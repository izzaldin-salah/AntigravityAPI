import { describe, it, expect, vi } from "vitest";
import { AntigravityProvider } from "../../src/providers/antigravity";
import { ProviderError, type NormalizedChatRequest } from "../../src/types/provider";

function createSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("AntigravityProvider", () => {
  it("lists exactly the single served model", async () => {
    const provider = new AntigravityProvider();
    const models = await provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("gemini-3.8-flash-high");
  });

  it("routes any requested model name to the single served model", async () => {
    let upstreamBody: {
      model?: string;
      request?: {
        generationConfig?: {
          thinkingConfig?: { includeThoughts?: boolean; thinkingLevel?: string };
        };
      };
    } = {};
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body)) as typeof upstreamBody;
      return new Response(
        createSseStream([
          'data: {"response":{"responseId":"resp_forced","candidates":[{"content":{"parts":[{"text":"routed"}]}}]}}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const provider = new AntigravityProvider({ accessToken: "test-token" }, { fetch: fakeFetch });
    const request: NormalizedChatRequest = {
      model: "gpt-4-unknown",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      requestId: "force-route-req",
    };

    const events = [];
    for await (const event of provider.chat(request)) {
      events.push(event);
    }

    expect(upstreamBody.model).toBe("gemini-3.8-flash-tiered");
    expect(upstreamBody.request?.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
    expect(events[0]).toMatchObject({ type: "start", model: "gemini-3.8-flash-high" });
  });

  it("parses upstream SSE lines into standard ProviderEvents", async () => {
    const sseData = [
      'data: {"response":{"responseId":"resp_abc_1","candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}}\n\n',
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"from Antigravity!"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}}\n\n',
      'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n',
      "data: [DONE]\n\n",
    ];

    const fakeFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("streamGenerateContent")) {
        return new Response(createSseStream(sseData), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const provider = new AntigravityProvider(
      {
        accessToken: "test-token",
        projectId: "test-proj",
      },
      { fetch: fakeFetch },
    );

    const request: NormalizedChatRequest = {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      requestId: "sse-parse-test",
    };

    const events = [];
    for await (const event of provider.chat(request)) {
      events.push(event);
    }

    expect(events.length).toBe(5);
    expect(events[0]).toMatchObject({ type: "start", id: "resp_abc_1", model: "gemini-3.8-flash-high" });
    expect(events[1]).toMatchObject({ type: "delta", text: "Hello " });
    expect(events[2]).toMatchObject({ type: "delta", text: "from Antigravity!" });
    expect(events[3]).toMatchObject({
      type: "usage",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    expect(events[4]).toMatchObject({
      type: "done",
      finishReason: "stop",
    });

    const recordedUsage = await provider.getUsage();
    expect(recordedUsage.promptTokens).toBe(10);
    expect(recordedUsage.completionTokens).toBe(5);
    expect(recordedUsage.requests).toBe(1);
  });

  it("refreshes token on 401 and retries at most once", async () => {
    let streamCallCount = 0;
    let refreshCallCount = 0;

    const sseData = [
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Success after refresh"}]}}],"finishReason":"STOP"}}\n\n',
      "data: [DONE]\n\n",
    ];

    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes("oauth2.googleapis.com/token")) {
        refreshCallCount++;
        return new Response(
          JSON.stringify({
            access_token: "refreshed-token-xyz",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("streamGenerateContent")) {
        streamCallCount++;
        const authHeader = (init?.headers as Record<string, string>)?.["Authorization"];

        if (streamCallCount === 1) {
          expect(authHeader).toBe("Bearer stale-initial-token");
          return new Response("Unauthorized", { status: 401 });
        }

        if (streamCallCount === 2) {
          expect(authHeader).toBe("Bearer refreshed-token-xyz");
          return new Response(createSseStream(sseData), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
      }

      return new Response("Unhandled", { status: 500 });
    }) as unknown as typeof fetch;

    const provider = new AntigravityProvider(
      {
        accessToken: "stale-initial-token",
        refreshToken: "valid-refresh-token",
      },
      { fetch: fakeFetch },
    );

    const request: NormalizedChatRequest = {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "test 401 recovery" }],
      stream: true,
      requestId: "retry-401-req",
    };

    const deltas: string[] = [];
    for await (const event of provider.chat(request)) {
      if (event.type === "delta") {
        deltas.push(event.text);
      }
    }

    expect(streamCallCount).toBe(2);
    expect(refreshCallCount).toBe(1);
    expect(deltas.join("")).toBe("Success after refresh");
  });

  it("refresh-on-401 fails cleanly without infinite loop if second attempt also returns 401", async () => {
    let streamCallCount = 0;
    let refreshCallCount = 0;

    const fakeFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = url.toString();

      if (urlStr.includes("oauth2.googleapis.com/token")) {
        refreshCallCount++;
        return new Response(
          JSON.stringify({
            access_token: "new-token-that-is-still-rejected",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("streamGenerateContent")) {
        streamCallCount++;
        return new Response("Unauthorized", { status: 401 });
      }

      return new Response("Unhandled", { status: 500 });
    }) as unknown as typeof fetch;

    const provider = new AntigravityProvider(
      {
        accessToken: "token-attempt-1",
        refreshToken: "refresh-token",
      },
      { fetch: fakeFetch },
    );

    const request: NormalizedChatRequest = {
      model: "gemini-3-flash",
      messages: [{ role: "user", content: "test double 401" }],
      stream: true,
      requestId: "double-401-req",
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of provider.chat(request)) {
        // do nothing
      }
      expect.unreachable("Should have failed on second 401");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const providerError = err as ProviderError;
      expect(providerError.payload.code).toBe("unauthorized");
      expect(streamCallCount).toBe(2);
      expect(refreshCallCount).toBe(1);
    }
  });

  it("maps HTTP error status codes to canonical provider error codes", async () => {
    const errorCases = [
      { status: 400, expectedCode: "invalid_request" },
      { status: 404, expectedCode: "not_found" },
      { status: 429, expectedCode: "rate_limited" },
      { status: 504, expectedCode: "timeout" },
      { status: 500, expectedCode: "upstream_error" },
    ];

    for (const testCase of errorCases) {
      const fakeFetch = vi.fn(async () => {
        return new Response(`Error ${testCase.status}`, { status: testCase.status });
      }) as unknown as typeof fetch;

      const provider = new AntigravityProvider(
        { accessToken: "valid-token" },
        { fetch: fakeFetch },
      );

      const request: NormalizedChatRequest = {
        model: "gemini-3-pro",
        messages: [{ role: "user", content: "error map test" }],
        stream: true,
        requestId: `err-${testCase.status}`,
      };

      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of provider.chat(request)) {
          // do nothing
        }
        expect.unreachable(`Status ${testCase.status} should have thrown ProviderError`);
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).payload.code).toBe(testCase.expectedCode);
      }
    }
  });

  it("honors AbortSignal before and during execution", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new AntigravityProvider({ accessToken: "valid-token" });
    const request: NormalizedChatRequest = {
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "abort me" }],
      stream: true,
      requestId: "abort-antigravity",
      signal: controller.signal,
    };

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of provider.chat(request)) {
        // do nothing
      }
    }).rejects.toMatchObject({
      payload: {
        code: "aborted",
      },
    });
  });

  it("returns healthy status from healthCheck", async () => {
    const provider = new AntigravityProvider();
    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain("initialized");
  });

  describe("tool calling", () => {
    interface UpstreamBody {
      model?: string;
      request?: {
        contents?: Array<{
          role: string;
          parts?: Array<Record<string, unknown>>;
        }>;
        tools?: Array<{
          functionDeclarations: Array<{
            name: string;
            description?: string;
            parameters?: Record<string, unknown>;
          }>;
        }>;
        toolConfig?: {
          functionCallingConfig: { mode: string; allowedFunctionNames?: string[] };
        };
      };
    }

    const weatherTool = {
      type: "function" as const,
      function: {
        name: "get_weather",
        description: "Look up the weather for a city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    };

    function createCapturingProvider(sseLines: string[]) {
      let body: UpstreamBody = {};
      const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as UpstreamBody;
        return new Response(createSseStream(sseLines), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as unknown as typeof fetch;
      const provider = new AntigravityProvider(
        { accessToken: "test-token", projectId: "test-proj" },
        { fetch: fakeFetch },
      );
      return { provider, readBody: () => body };
    }

    it("forwards tool declarations upstream and uses the default VALIDATED mode", async () => {
      const { provider, readBody } = createCapturingProvider([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n',
        "data: [DONE]\n\n",
      ]);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "weather in Paris?" }],
        stream: true,
        requestId: "tools-default-mode",
        tools: [weatherTool],
      };

      for await (const _ of provider.chat(request)) {
        // drain
      }

      const body = readBody();
      expect(body.request?.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Look up the weather for a city.",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          ],
        },
      ]);
      expect(body.request?.toolConfig).toEqual({
        functionCallingConfig: { mode: "VALIDATED" },
      });
    });

    it("does not declare tools when the client forbids tool use", async () => {
      const { provider, readBody } = createCapturingProvider([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n',
        "data: [DONE]\n\n",
      ]);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "no tools please" }],
        stream: true,
        requestId: "tools-none",
        tools: [weatherTool],
        toolChoice: "none",
      };

      for await (const _ of provider.chat(request)) {
        // drain
      }

      const body = readBody();
      expect(body.request?.tools).toBeUndefined();
      expect(body.request?.toolConfig).toBeUndefined();
    });

    it("forces a tool call with ANY mode and a transcript directive", async () => {
      const { provider, readBody } = createCapturingProvider([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n',
        "data: [DONE]\n\n",
      ]);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "weather in Paris?" }],
        stream: true,
        requestId: "tools-required",
        tools: [weatherTool],
        toolChoice: "required",
      };

      for await (const _ of provider.chat(request)) {
        // drain
      }

      const body = readBody();
      expect(body.request?.toolConfig).toEqual({
        functionCallingConfig: { mode: "ANY" },
      });
      const contents = body.request?.contents ?? [];
      const last = contents[contents.length - 1];
      expect(last.role).toBe("user");
      expect(String(last.parts?.[0]?.text)).toContain("tool call");
    });

    it("maps a named tool choice to allowedFunctionNames", async () => {
      const { provider, readBody } = createCapturingProvider([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n',
        "data: [DONE]\n\n",
      ]);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "weather in Paris?" }],
        stream: true,
        requestId: "tools-named",
        tools: [weatherTool],
        toolChoice: { type: "function", function: { name: "get_weather" } },
      };

      for await (const _ of provider.chat(request)) {
        // drain
      }

      expect(readBody().request?.toolConfig).toEqual({
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] },
      });
    });

    it("maps tool results to a functionResponse turn and merges parallel results", async () => {
      const { provider, readBody } = createCapturingProvider([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n',
        "data: [DONE]\n\n",
      ]);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [
          { role: "user", content: "weather in Paris?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
              {
                id: "call_def",
                type: "function",
                function: { name: "get_time", arguments: "{}" },
              },
            ],
          },
          { role: "tool", content: "18C", tool_call_id: "call_abc" },
          { role: "tool", content: "12:00", tool_call_id: "call_def" },
        ],
        stream: true,
        requestId: "tools-results",
        tools: [weatherTool],
      };

      for await (const _ of provider.chat(request)) {
        // drain
      }

      const contents = readBody().request?.contents ?? [];
      expect(contents).toHaveLength(3);
      expect(contents[1]).toEqual({
        role: "model",
        parts: [
          {
            functionCall: {
              name: "get_weather",
              args: { city: "Paris" },
              id: "call_abc",
            },
          },
          { functionCall: { name: "get_time", args: {}, id: "call_def" } },
        ],
      });
      // Cloud Code Assist wants every function response of a turn merged into
      // a single user turn.
      expect(contents[2]).toEqual({
        role: "user",
        parts: [
          { functionResponse: { name: "get_weather", response: { output: "18C" } } },
          { functionResponse: { name: "get_time", response: { output: "12:00" } } },
        ],
      });
    });

    it("emits one tool_call_delta per call and reports tool_calls as the finish reason", async () => {
      const { provider } = createCapturingProvider([
        'data: {"response":{"responseId":"resp_tools","candidates":[{"content":{"parts":[{"functionCall":{"id":"fc1","name":"get_weather","args":{"city":"Paris"}}}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"id":"fc2","name":"get_time","args":{}}}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n',
        "data: [DONE]\n\n",
      ]);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "weather and time?" }],
        stream: true,
        requestId: "tools-stream",
        tools: [weatherTool],
      };

      const events = [];
      for await (const event of provider.chat(request)) {
        events.push(event);
      }

      const toolEvents = events.filter((event) => event.type === "tool_call_delta");
      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[0]).toMatchObject({
        type: "tool_call_delta",
        index: 0,
        id: "fc1",
        name: "get_weather",
        argumentsDelta: '{"city":"Paris"}',
      });
      expect(toolEvents[1]).toMatchObject({
        type: "tool_call_delta",
        index: 1,
        id: "fc2",
        name: "get_time",
        argumentsDelta: "{}",
      });
      expect(events[events.length - 1]).toMatchObject({
        type: "done",
        finishReason: "tool_calls",
      });
    });

    it("mints a tool call id when the upstream does not provide one", async () => {
      const { provider } = createCapturingProvider([
        'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n',
        "data: [DONE]\n\n",
      ]);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "weather?" }],
        stream: true,
        requestId: "tools-generated-id",
        tools: [weatherTool],
      };

      const events = [];
      for await (const event of provider.chat(request)) {
        events.push(event);
      }

      const toolEvent = events.find((event) => event.type === "tool_call_delta");
      expect(toolEvent).toMatchObject({ type: "tool_call_delta", index: 0 });
      expect(String((toolEvent as { id?: string }).id)).toMatch(/^call_[0-9a-f]{16}$/);
    });

    it("replays the thought signature with the follow-up function call", async () => {
      // One provider instance handles both turns, exactly like the gateway.
      const bodies: UpstreamBody[] = [];
      let call = 0;
      const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        call += 1;
        bodies.push(JSON.parse(String(init?.body)) as UpstreamBody);
        const lines =
          call === 1
            ? [
                'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"id":"fc1","name":"get_weather","args":{"city":"Paris"}},"thoughtSignature":"SIG-123"}]}}]}}\n\n',
                "data: [DONE]\n\n",
              ]
            : [
                'data: {"response":{"candidates":[{"content":{"parts":[{"text":"18C"}]}}]}}\n\n',
                "data: [DONE]\n\n",
              ];
        return new Response(createSseStream(lines), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as unknown as typeof fetch;

      const provider = new AntigravityProvider(
        { accessToken: "test-token", projectId: "test-proj" },
        { fetch: fakeFetch },
      );

      const firstRequest: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "weather?" }],
        stream: true,
        requestId: "tools-signature-first",
        tools: [weatherTool],
      };
      for await (const _ of provider.chat(firstRequest)) {
        // drain
      }

      // The client answers the tool call in the next turn.
      const secondRequest: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "fc1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
          { role: "tool", content: "18C", tool_call_id: "fc1" },
        ],
        stream: true,
        requestId: "tools-signature-second",
        tools: [weatherTool],
      };
      for await (const _ of provider.chat(secondRequest)) {
        // drain
      }

      const contents = bodies[1].request?.contents ?? [];
      const modelTurn = contents.find((content) => content.role === "model");
      // The signature is a sibling of functionCall, not a field inside it.
      expect(modelTurn?.parts?.[0]).toEqual({
        functionCall: {
          name: "get_weather",
          args: { city: "Paris" },
          id: "fc1",
        },
        thoughtSignature: "SIG-123",
      });
    });

    it("rejects a tool result that cannot be matched to a function name", async () => {
      const { provider } = createCapturingProvider([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n',
        "data: [DONE]\n\n",
      ]);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [
          { role: "user", content: "weather?" },
          { role: "tool", content: "18C", tool_call_id: "call_unknown" },
        ],
        stream: true,
        requestId: "tools-unmatched",
        tools: [weatherTool],
      };

      await expect(async () => {
        for await (const _ of provider.chat(request)) {
          // drain
        }
      }).rejects.toMatchObject({
        payload: { code: "invalid_request" },
      });
    });
  });

  describe("multimodal and structured output", () => {
    interface UpstreamBody {
      request?: {
        contents?: Array<{
          role: string;
          parts?: Array<Record<string, unknown>>;
        }>;
        generationConfig?: Record<string, unknown>;
      };
    }

    function createCapturingProvider(sseLines: string[]) {
      let body: UpstreamBody = {};
      const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as UpstreamBody;
        return new Response(createSseStream(sseLines), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as unknown as typeof fetch;
      const provider = new AntigravityProvider(
        { accessToken: "test-token", projectId: "test-proj" },
        { fetch: fakeFetch },
      );
      return { provider, readBody: () => body };
    }

    const sse = [
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n',
      "data: [DONE]\n\n",
    ];

    it("sends a base64 image as inlineData", async () => {
      const { provider, readBody } = createCapturingProvider(sse);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [
          {
            role: "user",
            content: "what is in this image?",
            parts: [
              { type: "text", text: "what is in this image?" },
              { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
            ],
          },
        ],
        stream: true,
        requestId: "image-inline",
      };

      for await (const _ of provider.chat(request)) {
        // drain
      }

      const contents = readBody().request?.contents ?? [];
      expect(contents[0]).toEqual({
        role: "user",
        parts: [
          { text: "what is in this image?" },
          { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
        ],
      });
    });

    it("sends a remote image as fileData without fetching it", async () => {
      const { provider, readBody } = createCapturingProvider(sse);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [
          {
            role: "user",
            content: "describe",
            parts: [
              { type: "text", text: "describe" },
              {
                type: "image",
                mimeType: "image/png",
                url: "https://example.com/logo.png",
              },
            ],
          },
        ],
        stream: true,
        requestId: "image-remote",
      };

      for await (const _ of provider.chat(request)) {
        // drain
      }

      const contents = readBody().request?.contents ?? [];
      expect(contents[0]?.parts?.[1]).toEqual({
        fileData: { fileUri: "https://example.com/logo.png", mimeType: "image/png" },
      });
    });

    it("maps response_format json_object to the upstream mime type", async () => {
      const { provider, readBody } = createCapturingProvider(sse);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "json please" }],
        stream: true,
        requestId: "response-json-object",
        responseFormat: { type: "json_object" },
      };

      for await (const _ of provider.chat(request)) {
        // drain
      }

      expect(readBody().request?.generationConfig?.responseMimeType).toBe(
        "application/json",
      );
      expect(readBody().request?.generationConfig?.responseSchema).toBeUndefined();
    });

    it("maps response_format json_schema to an enforced upstream schema", async () => {
      const { provider, readBody } = createCapturingProvider(sse);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "capital of France" }],
        stream: true,
        requestId: "response-json-schema",
        responseFormat: {
          type: "json_schema",
          name: "city",
          schema: {
            type: "object",
            properties: { capital: { type: "string" } },
            required: ["capital"],
          },
        },
      };

      for await (const _ of provider.chat(request)) {
        // drain
      }

      const generationConfig = readBody().request?.generationConfig ?? {};
      expect(generationConfig.responseMimeType).toBe("application/json");
      expect(generationConfig.responseSchema).toEqual({
        type: "OBJECT",
        properties: { capital: { type: "STRING" } },
        required: ["capital"],
      });
    });

    it("appends a whitespace user turn when the conversation ends with an assistant turn", async () => {
      // The backend rejects a conversation that ends with a model turn.
      const { provider, readBody } = createCapturingProvider(sse);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello!" },
        ],
        stream: true,
        requestId: "trailing-assistant-turn",
      };

      for await (const _ of provider.chat(request)) {
        // drain
      }

      const contents = readBody().request?.contents ?? [];
      expect(contents).toHaveLength(3);
      expect(contents[2]).toEqual({ role: "user", parts: [{ text: " " }] });
    });

    it("reports the request roles when the upstream complains about a model turn", async () => {
      const fakeFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: "Requests ending with a model turn are not supported.",
              status: "INVALID_ARGUMENT",
            },
          }),
          { status: 400 },
        ),
      ) as unknown as typeof fetch;

      const provider = new AntigravityProvider(
        { accessToken: "test-token", projectId: "test-proj" },
        { fetch: fakeFetch },
      );

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello!" },
        ],
        stream: true,
        requestId: "model-turn-error",
      };

      await expect(async () => {
        for await (const _ of provider.chat(request)) {
          // drain
        }
      }).rejects.toMatchObject({
        payload: {
          code: "invalid_request",
          message: expect.stringContaining("request roles: system > user > assistant"),
        },
      });
    });

    it("rejects a response schema the provider cannot express", async () => {
      const { provider } = createCapturingProvider(sse);

      const request: NormalizedChatRequest = {
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "json please" }],
        stream: true,
        requestId: "response-bad-schema",
        responseFormat: {
          type: "json_schema",
          schema: { type: "date" },
        },
      };

      await expect(async () => {
        for await (const _ of provider.chat(request)) {
          // drain
        }
      }).rejects.toMatchObject({
        payload: { code: "invalid_request" },
      });
    });
  });
});
