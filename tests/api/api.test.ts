import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { UsageTracker } from "../../src/core/usage-tracker";
import type { AppConfig } from "../../src/types/config";
import { MockTestProvider } from "./mock-provider";

const testConfig: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  logLevel: "silent",
  apiKeys: ["test-key"],
  rateLimit: { windowMs: 60000, max: 60 },
  corsOrigins: "*",
  trustProxy: false,
  provider: { mode: "mock" },
};

describe("personal-antigravity-api API endpoints", () => {
  it("GET /health responds 200 with no provider calls", async () => {
    const provider = new MockTestProvider();
    const app = await buildApp({ config: testConfig, provider });

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
    expect(typeof body.uptime).toBe("number");
    expect(body.provider).toEqual({ mode: "mock" });

    // Assert that /health made NO provider calls
    expect(provider.listModelsCalls).toBe(0);
    expect(provider.chatCalls).toBe(0);
    expect(provider.getUsageCalls).toBe(0);
    expect(provider.healthCheckCalls).toBe(0);

    await app.close();
  });

  it("adds x-request-id header matching req_* to responses", async () => {
    const provider = new MockTestProvider();
    const app = await buildApp({ config: testConfig, provider });

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toMatch(/^req_/);

    await app.close();
  });

  it("GET /v1/models returns models list in standard shape", async () => {
    const provider = new MockTestProvider({
      models: [
        {
          id: "gemini-2.5-pro",
          object: "model",
          created: 1700000000,
          owned_by: "google",
        },
      ],
    });
    const app = await buildApp({ config: testConfig, provider });

    const res = await app.inject({ method: "GET", url: "/v1/models" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("gemini-2.5-pro");
    expect(provider.listModelsCalls).toBe(1);

    await app.close();
  });

  it("POST /v1/chat/completions (non-stream) returns complete OpenAI response and records usage", async () => {
    const usageTracker = new UsageTracker();
    const provider = new MockTestProvider();
    const app = await buildApp({ config: testConfig, provider, usageTracker });

    const payload = {
      model: "mock-model-1",
      messages: [
        { role: "developer", content: "You are helpful." },
        { role: "user", content: "Hello!" },
      ],
      stream: false,
    };

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("mock-model-1");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("Hello from mock provider!");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 25,
      total_tokens: 40,
    });

    // Verify developer role was mapped to system
    expect(provider.lastChatRequest?.messages[0].role).toBe("system");

    // Verify usage was recorded in tracker
    const snapshot = usageTracker.snapshot();
    expect(snapshot.requests).toBe(1);
    expect(snapshot.prompt_tokens).toBe(15);
    expect(snapshot.completion_tokens).toBe(25);
    expect(snapshot.by_model["mock-model-1"].requests).toBe(1);

    await app.close();
  });

  it("POST /v1/chat/completions (non-stream) aggregates tool_call deltas", async () => {
    const provider = new MockTestProvider({
      chatHandler: async function* () {
        yield { type: "start", id: "chat-tools", model: "model-tool", created: 1000 };
        yield {
          type: "tool_call_delta",
          index: 0,
          id: "call_abc123",
          name: "get_weather",
          argumentsDelta: "{\"loc",
        };
        yield {
          type: "tool_call_delta",
          index: 0,
          argumentsDelta: "ation\":\"Paris\"}",
        };
        yield { type: "done", finishReason: "tool_calls" };
      },
    });

    const app = await buildApp({ config: testConfig, provider });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "model-tool",
        messages: [{ role: "user", content: "weather in paris?" }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls).toEqual([
      {
        id: "call_abc123",
        type: "function",
        function: {
          name: "get_weather",
          arguments: "{\"location\":\"Paris\"}",
        },
      },
    ]);

    await app.close();
  });

  it("POST /v1/chat/completions (streaming) yields correct SSE chunk sequence", async () => {
    const provider = new MockTestProvider({
      chatHandler: async function* (req) {
        yield {
          type: "start",
          id: "stream-id-1",
          model: req.model,
          created: 1700000000,
        };
        yield { type: "delta", text: "chunk 1 " };
        yield { type: "delta", text: "chunk 2" };
        yield { type: "done", finishReason: "stop" };
      },
    });

    const app = await buildApp({ config: testConfig, provider });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "mock-model-1",
        messages: [{ role: "user", content: "Tell me a story" }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const raw = res.body;
    const lines = raw.split("\n\n").filter(Boolean);

    // Filter out keep-alive if any
    const dataLines = lines.filter((l) => l.startsWith("data: "));
    expect(dataLines.length).toBeGreaterThanOrEqual(4);

    // 1. Role chunk
    const chunk1 = JSON.parse(dataLines[0].replace("data: ", ""));
    expect(chunk1.object).toBe("chat.completion.chunk");
    expect(chunk1.choices[0].delta.role).toBe("assistant");

    // 2. Content chunk 1
    const chunk2 = JSON.parse(dataLines[1].replace("data: ", ""));
    expect(chunk2.choices[0].delta.content).toBe("chunk 1 ");

    // 3. Content chunk 2
    const chunk3 = JSON.parse(dataLines[2].replace("data: ", ""));
    expect(chunk3.choices[0].delta.content).toBe("chunk 2");

    // 4. Finish reason chunk
    const chunk4 = JSON.parse(dataLines[3].replace("data: ", ""));
    expect(chunk4.choices[0].finish_reason).toBe("stop");

    // Final frame is [DONE]
    expect(dataLines[dataLines.length - 1]).toBe("data: [DONE]");

    await app.close();
  });

  it("POST /v1/chat/completions (streaming) emits usage chunk when stream_options.include_usage: true", async () => {
    const provider = new MockTestProvider({
      chatHandler: async function* (req) {
        yield { type: "start", id: "stream-usage", model: req.model, created: 1700000000 };
        yield { type: "delta", text: "hi" };
        yield {
          type: "usage",
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
        yield { type: "done", finishReason: "stop" };
      },
    });

    const app = await buildApp({ config: testConfig, provider });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "mock-model-1",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      },
    });

    expect(res.statusCode).toBe(200);
    const dataLines = res.body.split("\n\n").filter((l) => l.startsWith("data: "));

    // Check for the usage chunk (choices: [], usage: {...})
    const usageFrame = dataLines.find((l) => {
      if (l.includes("[DONE]")) return false;
      const parsed = JSON.parse(l.replace("data: ", ""));
      return parsed.choices && parsed.choices.length === 0 && parsed.usage;
    });

    expect(usageFrame).toBeDefined();
    const parsedUsage = JSON.parse(usageFrame!.replace("data: ", ""));
    expect(parsedUsage.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    });

    await app.close();
  });

  describe("Validation 400 errors", () => {
    it("rejects request without model parameter", async () => {
      const provider = new MockTestProvider();
      const app = await buildApp({ config: testConfig, provider });

      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          messages: [{ role: "user", content: "hello" }],
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.param).toBe("model");
      expect(body.error.message).toContain("model");

      await app.close();
    });

    it("rejects request with empty messages array", async () => {
      const provider = new MockTestProvider();
      const app = await buildApp({ config: testConfig, provider });

      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "mock-model-1",
          messages: [],
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.param).toBe("messages");

      await app.close();
    });

    it("rejects request with invalid temperature", async () => {
      const provider = new MockTestProvider();
      const app = await buildApp({ config: testConfig, provider });

      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "mock-model-1",
          messages: [{ role: "user", content: "hello" }],
          temperature: 2.5,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.param).toBe("temperature");

      await app.close();
    });

    it("rejects request with n > 1 with code unsupported_parameter", async () => {
      const provider = new MockTestProvider();
      const app = await buildApp({ config: testConfig, provider });

      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "mock-model-1",
          messages: [{ role: "user", content: "hello" }],
          n: 2,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.param).toBe("n");
      expect(body.error.code).toBe("unsupported_parameter");

      await app.close();
    });

    it("rejects invalid top_p and handles max_completion_tokens precedence over max_tokens", async () => {
      const provider = new MockTestProvider();
      const app = await buildApp({ config: testConfig, provider });

      // Invalid top_p
      const resBadTopP = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "mock-model-1",
          messages: [{ role: "user", content: "hello" }],
          top_p: 1.5,
        },
      });
      expect(resBadTopP.statusCode).toBe(400);
      expect(resBadTopP.json().error.param).toBe("top_p");

      // max_completion_tokens winning over max_tokens
      const resTokens = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "mock-model-1",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 100,
          max_completion_tokens: 200,
        },
      });
      expect(resTokens.statusCode).toBe(200);
      expect(provider.lastChatRequest?.maxTokens).toBe(200);

      await app.close();
    });
  });

  describe("Provider error mappings", () => {
    it("maps provider unauthorized error to 502 provider_auth_error in non-stream mode", async () => {
      const provider = new MockTestProvider({
        chatHandler: async function* () {
          yield {
            type: "error",
            error: {
              code: "unauthorized",
              message: "Invalid upstream credentials",
            },
          };
        },
      });

      const app = await buildApp({ config: testConfig, provider });
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "mock-model-1",
          messages: [{ role: "user", content: "hello" }],
        },
      });

      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(body.error.type).toBe("api_error");
      expect(body.error.code).toBe("provider_auth_error");
      expect(body.error.message).toBe("Invalid upstream credentials");

      await app.close();
    });

    it("maps provider not_found error to 404 model_not_found", async () => {
      const provider = new MockTestProvider({
        chatHandler: async function* () {
          yield {
            type: "error",
            error: {
              code: "not_found",
              message: "Model does not exist",
            },
          };
        },
      });

      const app = await buildApp({ config: testConfig, provider });
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "non-existent-model",
          messages: [{ role: "user", content: "hello" }],
        },
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("model_not_found");

      await app.close();
    });

    it("emits mid-stream error frame then [DONE] when provider yields error during stream", async () => {
      const provider = new MockTestProvider({
        chatHandler: async function* () {
          yield { type: "start", id: "err-stream", model: "m", created: 100 };
          yield { type: "delta", text: "beginning " };
          yield {
            type: "error",
            error: {
              code: "upstream_error",
              message: "Internal upstream provider failure",
            },
          };
        },
      });

      const app = await buildApp({ config: testConfig, provider });
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "mock-model-1",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
      });

      expect(res.statusCode).toBe(200);
      const lines = res.body.split("\n\n").filter((l) => l.startsWith("data: "));

      const errorLine = lines.find((l) => l.includes("\"error\""));
      expect(errorLine).toBeDefined();
      const parsedError = JSON.parse(errorLine!.replace("data: ", ""));
      expect(parsedError.error.type).toBe("api_error");
      expect(parsedError.error.code).toBe("upstream_error");

      // Verify that after the error frame, [DONE] is emitted
      expect(lines[lines.length - 1]).toBe("data: [DONE]");

      await app.close();
    });
  });

  describe("/usage endpoint", () => {
    it("accumulates usage across two requests and merges provider usage", async () => {
      const usageTracker = new UsageTracker();
      const provider = new MockTestProvider({
        usage: {
          promptTokens: 100,
          completionTokens: 200,
          totalTokens: 300,
        },
      });

      const app = await buildApp({ config: testConfig, provider, usageTracker });

      // Request 1
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "mock-model-1",
          messages: [{ role: "user", content: "Request 1" }],
        },
      });

      // Request 2
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "mock-model-1",
          messages: [{ role: "user", content: "Request 2" }],
        },
      });

      const res = await app.inject({ method: "GET", url: "/usage" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.object).toBe("usage");
      expect(body.data.requests).toBe(2);
      expect(body.data.prompt_tokens).toBe(30); // 15 + 15
      expect(body.data.completion_tokens).toBe(50); // 25 + 25
      expect(body.data.total_tokens).toBe(80); // 40 + 40
      expect(body.data.by_model["mock-model-1"].requests).toBe(2);
      expect(typeof body.data.since).toBe("number");
      expect(body.data.provider).toEqual({
        promptTokens: 100,
        completionTokens: 200,
        totalTokens: 300,
      });

      await app.close();
    });

    it("handles provider.getUsage() failure gracefully with provider: null and 200 OK", async () => {
      const provider = new MockTestProvider();
      provider.getUsage = async () => {
        throw new Error("Provider quota service down");
      };

      const app = await buildApp({ config: testConfig, provider });
      const res = await app.inject({ method: "GET", url: "/usage" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.provider).toBeNull();

      await app.close();
    });
  });

  describe("Client disconnect test (real socket)", () => {
    it("observes signal.aborted within ~200ms when client disconnects mid-stream", async () => {
      let observedAborted = false;
      const provider = new MockTestProvider({
        chatHandler: async function* (req) {
          req.signal?.addEventListener("abort", () => {
            observedAborted = true;
          });

          yield {
            type: "start",
            id: "disconnect-test",
            model: req.model,
            created: 1700000000,
          };
          yield { type: "delta", text: "streaming start... " };

          for (let i = 0; i < 30; i++) {
            if (req.signal?.aborted) {
              observedAborted = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 20));
          }
          if (req.signal?.aborted) {
            observedAborted = true;
          }
        },
      });

      const app = await buildApp({ config: testConfig, provider });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });

      const controller = new AbortController();
      const response = await fetch(`${address}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mock-model-1",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
        signal: controller.signal,
      });

      expect(response.status).toBe(200);

      const reader = response.body?.getReader();
      if (reader) {
        await reader.read();
        controller.abort();
        reader.cancel().catch(() => {});
      }

      const start = Date.now();
      while (!observedAborted && Date.now() - start < 400) {
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(observedAborted).toBe(true);

      await app.close();
    });
  });
});
