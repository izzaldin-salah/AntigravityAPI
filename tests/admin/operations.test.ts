import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app";
import { loadConfig } from "../../src/config/env";
import { createSessionStore } from "../../src/security/session-store";
import { MockTestProvider } from "../api/mock-provider";
import { RequestTracker } from "../../src/core/request-tracker";
import type { CredentialStore, OAuthService } from "../../src/types/admin";
import type { ProviderEvent } from "../../src/types/provider";
import { renderHealth, renderStorage, renderSetup, type OperationsViewData } from "../../src/admin/operations-view";

async function fixture(provider = new MockTestProvider()) {
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", ADMIN_PASSWORD: "admin-test", CREDENTIAL_ENCRYPTION_KEY: "test-key", API_KEYS: "API_SECRET_SENTINEL", CREDENTIAL_STORE: "file" });
  const sessions = createSessionStore();
  const store: CredentialStore = { backend: "memory", async load() { return null; }, async save() {}, async clear() {}, async health() { return { backend: "memory", ok: true }; } };
  const oauth: OAuthService = { isConfigured: () => false, buildAuthorizeUrl: () => "", async exchangeCode() { throw Error("unused"); }, async testRefresh() { throw Error("unused"); } };
  const app = await buildApp({ config, provider, admin: { sessionStore: sessions, credentialStore: store, oauthService: oauth } });
  const session = await sessions.create(60000);
  return { app, provider, headers: { cookie: `admin_session=${session.id}`, "x-csrf-token": session.csrfToken, accept: "application/json" } };
}

describe("Admin operations", () => {
  it("requires session and CSRF before testing or revealing a key", async () => {
    const { app, provider, headers } = await fixture();
    try {
      for (const url of ["/admin/actions/test-connection", "/admin/actions/api-key"]) {
        expect((await app.inject({ method: "POST", url })).statusCode).toBe(401);
        expect((await app.inject({ method: "POST", url, headers: { cookie: headers.cookie } })).statusCode).toBe(403);
      }
      expect(provider.chatCalls).toBe(0);
    } finally { await app.close(); }
  });
  it("runs a bounded test, shares metrics, and keeps content out of request history", async () => {
    const { app, headers } = await fixture();
    try {
      const result = await app.inject({ method: "POST", url: "/admin/actions/test-connection", headers });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ ok: true, response: "Hello from mock provider!" });
      const dashboard = await app.inject({ url: "/admin/dashboard", headers });
      expect(dashboard.body).toContain("Recent requests");
      expect(dashboard.body).not.toContain("Hello from mock provider!");
      expect(dashboard.body).not.toContain("API_SECRET_SENTINEL");
      const stats = await app.inject({ url: "/admin/api/operations", headers });
      expect(stats.json()).toMatchObject({ requests: 1, succeeded: 1, failed: 0, inputTokens: 15, outputTokens: 25 });
      expect(JSON.stringify(stats.json())).not.toContain("Hello from mock provider!");
      expect(stats.headers["cache-control"]).toBe("no-store");
      expect((await app.inject({ url: "/admin/api/operations" })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it("reveals the key only on an authenticated POST and never caches it", async () => {
    const { app, headers } = await fixture();
    try {
      const res = await app.inject({ method: "POST", url: "/admin/actions/api-key", headers });
      expect(res.json()).toEqual({ key: "API_SECRET_SENTINEL" });
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally { await app.close(); }
  });
  it("tracks API calls and streaming failures in the same dashboard counters", async () => {
    const provider = new MockTestProvider();
    const { app, headers } = await fixture(provider);
    try {
      const payload = { model: "test", messages: [{ role: "user", content: "PRIVATE_PROMPT" }] };
      expect((await app.inject({ method: "POST", url: "/v1/chat/completions", payload })).statusCode).toBe(200);
      provider.chatHandler = async function* () { yield { type: "error", error: { code: "upstream_error", message: "PRIVATE_ERROR" } }; };
      await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { ...payload, stream: true } });
      const stats = (await app.inject({ url: "/admin/api/operations", headers })).json();
      expect(stats).toMatchObject({ requests: 2, succeeded: 1, failed: 1 });
      expect(stats.recent.every((row: { source: string }) => row.source === "api")).toBe(true);
      expect(JSON.stringify(stats)).not.toContain("PRIVATE_");
    } finally { await app.close(); }
  });
  it("limits concurrent tests and aborts upstream work after 30 seconds", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let signal: AbortSignal | undefined;
    const provider = new MockTestProvider({ chatHandler: async function* (request) {
      signal = request.signal;
      started();
      await new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    } });
    const { app, headers } = await fixture(provider);
    try {
      const first = app.inject({ method: "POST", url: "/admin/actions/test-connection", headers });
      // Start the inject thenable before waiting for provider work.
      const completion = Promise.resolve(first);
      await ready;
      expect((await app.inject({ method: "POST", url: "/admin/actions/test-connection", headers })).statusCode).toBe(429);
      await vi.advanceTimersByTimeAsync(30001);
      expect((await completion).statusCode).toBe(504);
      expect(signal?.aborted).toBe(true);
      expect((await app.inject({ url: "/admin/api/operations", headers })).json()).toMatchObject({ failed: 1, cancelled: 0 });
    } finally { vi.useRealTimers(); await app.close(); }
  });
  it("reports provider failure without reflecting its potentially secret error text", async () => {
    const provider = new MockTestProvider({ chatHandler: async function* () { throw Error("TOKEN_SENTINEL"); } });
    const { app, headers } = await fixture(provider);
    try {
      const result = await app.inject({ method: "POST", url: "/admin/actions/test-connection", headers });
      expect(result.statusCode).toBe(502);
      expect(result.body).not.toContain("TOKEN_SENTINEL");
      const stats = (await app.inject({ url: "/admin/api/operations", headers })).json();
      expect(stats).toMatchObject({ requests: 1, failed: 1 });
      expect(JSON.stringify(stats)).not.toContain("TOKEN_SENTINEL");
    } finally { await app.close(); }
  });
});

describe("Request metadata tracking", () => {
  const request = { model: "PRIVATE_CLIENT_INPUT", messages: [{ role: "user" as const, content: "PRIVATE_PROMPT" }], stream: true, requestId: "test" };
  async function* events(): AsyncIterable<ProviderEvent> {
    yield { type: "start", id: "test", model: "test-model", created: 1 };
    yield { type: "delta", text: "PRIVATE_REPLY" };
    yield { type: "usage", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } };
    yield { type: "done", finishReason: "stop" };
  }
  it("retains only the latest 50 metadata rows with lifetime counters and defensive snapshots", async () => {
    const tracker = new RequestTracker();
    for (let i = 0; i < 53; i++) for await (const _ of tracker.observe(request, events(), "api")) { /* consume */ }
    const stats = tracker.snapshot();
    expect(stats).toMatchObject({ requests: 53, succeeded: 53, failed: 0, inputTokens: 106, outputTokens: 159 });
    expect(stats.recent).toHaveLength(50);
    expect(JSON.stringify(stats)).not.toContain("PRIVATE_");
    stats.recent[0]!.model = "changed";
    expect(tracker.snapshot().recent[0]!.model).toBe("test-model");
  });
  it("counts stream errors and client cancellation separately from success", async () => {
    const tracker = new RequestTracker();
    async function* failed(): AsyncIterable<ProviderEvent> { yield { type: "error", error: { code: "unauthorized", message: "SECRET_ERROR" } }; }
    for await (const _ of tracker.observe(request, failed(), "api")) { /* consume */ }
    for await (const _ of tracker.observe(request, events(), "api")) { break; }
    expect(tracker.snapshot()).toMatchObject({ requests: 2, succeeded: 0, failed: 1, cancelled: 1 });
    expect(JSON.stringify(tracker.snapshot())).not.toContain("SECRET_ERROR");
  });
});

describe("Operational status presentation", () => {
  const data: OperationsViewData = { snapshot: new RequestTracker().snapshot(), baseUrl: "https://gateway.example", models: ["gemini-3.8-flash-high"], apiKeyCount: 1, isRender: false, encryptedStore: true, hasTokenCache: true };
  it("distinguishes file, memory, and unverified Redis durability", () => {
    expect(renderStorage({ backend: "memory", ok: true }, data)).toContain("Not persistent");
    expect(renderStorage({ backend: "redis", ok: true }, data)).toContain("Those settings are not verified here");
    expect(renderStorage({ backend: "file", ok: true }, data)).toContain("same disk");
    expect(renderStorage({ backend: "file", ok: false }, { ...data, isRender: true })).toContain("ephemeral");
    expect(renderStorage({ backend: "file", ok: true }, data)).toContain("plaintext");
  });
  it("gives different recovery steps for expired tokens with and without refresh credentials", () => {
    const status = { providerMode: "antigravity" as const, connected: true, hasRefreshToken: true, needsReconnect: false, accessTokenExpiresAt: Date.now() - 1000 };
    expect(renderHealth(status, data)).toContain("attempt renewal on the next request");
    expect(renderHealth({ ...status, hasRefreshToken: false }, data)).toContain("No refresh token is available");
    expect(renderHealth({ ...status, needsReconnect: true }, data)).toContain("replace rejected credentials");
  });
  it("escapes setup values and keeps examples free of actual API keys", () => {
    const html = renderSetup({ ...data, models: ['<script>alert("x")</script>'] });
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("ANTIGRAVITY_API_KEY");
    expect(html).toContain("https://gateway.example/v1");
  });
});
