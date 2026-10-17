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
    expect(health.detail).toContain("gemini-3.8-flash-high");
  });
});
