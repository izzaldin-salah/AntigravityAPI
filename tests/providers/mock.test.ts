import { describe, it, expect } from "vitest";
import { MockProvider } from "../../src/providers/mock";
import { ProviderError, type NormalizedChatRequest } from "../../src/types/provider";

describe("MockProvider", () => {
  it("lists at least two deterministic models", async () => {
    const provider = new MockProvider();
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThanOrEqual(2);
    expect(models.map((m) => m.id)).toContain("mock-fast");
    expect(models.map((m) => m.id)).toContain("mock-smart");
  });

  it("yields deterministic stream events and records usage", async () => {
    const provider = new MockProvider();
    const request: NormalizedChatRequest = {
      model: "mock-fast",
      messages: [{ role: "user", content: "hello world test" }],
      stream: true,
      requestId: "test-req-1",
    };

    const events = [];
    for await (const event of provider.chat(request)) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events[0].type).toBe("start");
    expect(events[events.length - 2].type).toBe("usage");
    expect(events[events.length - 1].type).toBe("done");

    // Check deltas
    const textDeltas = events
      .filter((e) => e.type === "delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(textDeltas).toBe("[mock-fast] Echo: hello world test");

    // Check accumulated usage
    const usage = await provider.getUsage();
    expect(usage.requests).toBe(1);
    expect(usage.promptTokens).toBeGreaterThan(0);
    expect(usage.completionTokens).toBeGreaterThan(0);
    expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
    expect(usage.byModel?.["mock-fast"]?.requests).toBe(1);
  });

  it("produces identical output for identical prompts across runs", async () => {
    const provider1 = new MockProvider();
    const provider2 = new MockProvider();
    const request: NormalizedChatRequest = {
      model: "mock-smart",
      messages: [{ role: "user", content: "determinism check" }],
      stream: true,
      requestId: "det-1",
    };

    const deltas1: string[] = [];
    for await (const event of provider1.chat(request)) {
      if (event.type === "delta") deltas1.push(event.text);
    }

    const deltas2: string[] = [];
    for await (const event of provider2.chat(request)) {
      if (event.type === "delta") deltas2.push(event.text);
    }

    expect(deltas1.join("")).toBe(deltas2.join(""));
  });

  it("honors AbortSignal and stops promptly", async () => {
    const provider = new MockProvider();
    const controller = new AbortController();

    const request: NormalizedChatRequest = {
      model: "mock-fast",
      messages: [{ role: "user", content: "long message to test abort signal functionality" }],
      stream: true,
      requestId: "abort-req-1",
      signal: controller.signal,
    };

    // Pre-aborted signal
    controller.abort();

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of provider.chat(request)) {
        // do nothing
      }
    }).rejects.toThrowError(ProviderError);
  });

  it("throws not_found error on unknown model", async () => {
    const provider = new MockProvider();
    const request: NormalizedChatRequest = {
      model: "non-existent-model",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      requestId: "unknown-1",
    };

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of provider.chat(request)) {
        // do nothing
      }
    }).rejects.toMatchObject({
      payload: {
        code: "not_found",
      },
    });
  });

  it("returns healthy status from healthCheck", async () => {
    const provider = new MockProvider();
    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);
  });
});
