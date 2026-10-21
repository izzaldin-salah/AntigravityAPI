import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityProvider } from "../../src/providers/antigravity";
import { createModelSettingsStore } from "../../src/core/model-settings-store";

const catalog = { models: {
  "gemini-3.8-flash-tiered": { displayName: "Gemini 3.8 Flash" },
  "gemini-3.1-pro-preview": { displayName: "Gemini 3.1 Pro" },
  "gemini-3-pro-preview": {}, "gemini-2.5-flash": {},
  "claude-opus-4-6-thinking": {}, "claude-sonnet-4-6": { supportsThinking: true }, "claude-haiku-4-5": { supportsThinking: false },
  "gemini-3-pro-image": {}, "unknown-model": {},
} };
function setup() {
  const bodies: any[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("fetchAvailableModels")) return Response.json(catalog);
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  });
  const provider = new AntigravityProvider({ accessToken: "TEST_ACCESS_SENTINEL" }, { fetch: fetcher as typeof fetch });
  return { provider, fetcher, bodies };
}
const chat = { model: "client-alias", messages: [{ role: "user" as const, content: "hi" }], stream: true, requestId: "settings-test" };

describe("Model settings", () => {
  it("discovers compatible account models without returning credentials or unsupported image models", async () => {
    const { provider } = setup();
    const models = await provider.discoverModels();
    expect(models.map(m => m.id)).toContain("gemini-3.1-pro-preview");
    expect(models.map(m => m.id)).not.toContain("gemini-3-pro-image");
    expect(models.map(m => m.id)).not.toContain("unknown-model");
    expect(JSON.stringify(models)).not.toContain("TEST_ACCESS_SENTINEL");
  });
  it("applies saved model and medium thinking to actual upstream requests and model listing", async () => {
    const { provider, bodies } = setup();
    await provider.updateModelSettings({ model: "gemini-3.1-pro-preview", thinkingLevel: "medium" });
    const events = [];
    for await (const event of provider.chat(chat)) events.push(event);
    expect(bodies[0].model).toBe("gemini-3.1-pro-preview");
    expect(bodies[0].request.generationConfig.thinkingConfig.thinkingLevel).toBe("MEDIUM");
    expect(events[0]).toMatchObject({ model: "gemini-3.1-pro-preview" });
    expect((await provider.listModels())[0].id).toBe("gemini-3.1-pro-preview");
  });
  it("keeps tiered public model labels consistent with the selected thinking level", async () => {
    const { provider, bodies } = setup();
    await provider.updateModelSettings({ model: "gemini-3.8-flash-tiered", thinkingLevel: "low" });
    for await (const _event of provider.chat(chat)) { /* consume */ }
    expect(bodies[0].model).toBe("gemini-3.8-flash-tiered");
    expect(bodies[0].request.generationConfig.thinkingConfig.thinkingLevel).toBe("LOW");
    expect((await provider.listModels())[0].id).toBe("gemini-3.8-flash-low");
  });
  it("rejects unknown models and unsupported thinking without changing the active selection", async () => {
    const { provider } = setup();
    const initial = await provider.getModelSettings();
    await expect(provider.updateModelSettings({ model: "made-up", thinkingLevel: "high" })).rejects.toThrow();
    await expect(provider.updateModelSettings({ model: "gemini-3-pro-preview", thinkingLevel: "medium" })).rejects.toThrow();
    expect(await provider.getModelSettings()).toEqual(initial);
  });
  it("uses token budgets for budget-based models and omits thinking for non-thinking models", async () => {
    const { provider, bodies } = setup();
    await provider.updateModelSettings({ model: "claude-opus-4-6-thinking", thinkingLevel: "medium" });
    for await (const _event of provider.chat({ ...chat, maxTokens: 64 })) { /* consume */ }
    expect(bodies[0].request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 8192 });
    expect(bodies[0].request.generationConfig.maxOutputTokens).toBeGreaterThan(8192);
    await provider.updateModelSettings({ model: "claude-haiku-4-5", thinkingLevel: null });
    for await (const _event of provider.chat(chat)) { /* consume */ }
    expect(bodies[1].request.generationConfig?.thinkingConfig).toBeUndefined();
  });
  it("keeps an in-flight request on its original model and thinking", async () => {
    const { provider, bodies } = setup();
    const stream = provider.chat(chat)[Symbol.asyncIterator]();
    const first = await stream.next();
    await provider.updateModelSettings({ model: "gemini-3.1-pro-preview", thinkingLevel: "low" });
    while (!(await stream.next()).done) { /* consume */ }
    expect(first.value).toMatchObject({ model: "gemini-3.8-flash-high" });
    expect(bodies[0].request.generationConfig.thinkingConfig.thinkingLevel).toBe("HIGH");
  });
  it("restores file settings across provider instances without modifying credential storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-settings-"));
    const config = { backend: "file" as const, filePath: join(directory, "credentials.enc") };
    try {
      const { fetcher } = setup();
      const first = new AntigravityProvider({ accessToken: "test" }, { fetch: fetcher as typeof fetch, modelSettingsStore: createModelSettingsStore(config) });
      await first.updateModelSettings({ model: "gemini-3.1-pro-preview", thinkingLevel: "low" });
      const second = new AntigravityProvider({}, { modelSettingsStore: createModelSettingsStore(config) });
      expect(await second.getModelSettings()).toMatchObject({ model: "gemini-3.1-pro-preview", thinkingLevel: "low" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("does not apply a selection when persistence fails", async () => {
    const { fetcher } = setup();
    const provider = new AntigravityProvider({ accessToken: "test" }, { fetch: fetcher as typeof fetch, modelSettingsStore: { backend: "file", async load() { return null; }, async save() { throw new Error("write failed"); } } });
    await expect(provider.updateModelSettings({ model: "gemini-3.1-pro-preview", thinkingLevel: "low" })).rejects.toThrow();
    expect(await provider.getModelSettings()).toMatchObject({ model: "gemini-3.8-flash-tiered", thinkingLevel: "high" });
  });
  it("uses account thinking capability metadata for Claude models without a thinking suffix", async () => {
    const { provider, bodies } = setup();
    const options = await provider.discoverModels();
    expect(options.find(model => model.id === "claude-sonnet-4-6")?.thinkingLevels).toEqual(["low", "medium", "high"]);
    await provider.updateModelSettings({ model: "claude-sonnet-4-6", thinkingLevel: "low" });
    for await (const _event of provider.chat(chat)) { /* consume */ }
    expect(bodies[0].request.generationConfig.thinkingConfig.thinkingBudget).toBe(1024);
    await expect(provider.updateModelSettings({ model: "claude-haiku-4-5", thinkingLevel: "low" })).rejects.toThrow();
  });
  it("recovers from a temporary settings load failure without silently using defaults", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("Redis unavailable")).mockResolvedValueOnce({ model: "gemini-3.1-pro-preview", thinkingLevel: "low" });
    const provider = new AntigravityProvider({}, { modelSettingsStore: { backend: "redis", load, async save() {} } });
    await expect(provider.getModelSettings()).rejects.toThrow("Redis unavailable");
    expect(await provider.getModelSettings()).toMatchObject({ model: "gemini-3.1-pro-preview", thinkingLevel: "low" });
  });
});
