import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app";
import { loadConfig } from "../../src/config/env";
import { createSessionStore } from "../../src/security/session-store";
import { AntigravityProvider } from "../../src/providers/antigravity";
import type { CredentialStore, OAuthService } from "../../src/types/admin";
import { renderModelSettings } from "../../src/admin/model-settings-view";

async function fixture() {
  const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes("fetchAvailableModels")
    ? Response.json({ models: { "gemini-3.8-flash-tiered": {}, "gemini-3.1-pro-preview": {} } })
    : new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n'));
  const provider = new AntigravityProvider({ accessToken: "PRIVATE_OAUTH_SENTINEL" }, { fetch: fetcher as typeof fetch });
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", ADMIN_PASSWORD: "test", API_KEYS: "PRIVATE_API_SENTINEL", CREDENTIAL_ENCRYPTION_KEY: "test", CREDENTIAL_STORE: "file" });
  const sessions = createSessionStore();
  const store: CredentialStore = { backend: "memory", async load() { return null; }, async save() {}, async clear() {}, async health() { return { backend: "memory", ok: true }; } };
  const oauth: OAuthService = { isConfigured: () => false, buildAuthorizeUrl: () => "", async exchangeCode() { throw Error("unused"); }, async testRefresh() { throw Error("unused"); } };
  const app = await buildApp({ config, provider, admin: { sessionStore: sessions, credentialStore: store, oauthService: oauth } });
  const session = await sessions.create(60000);
  return { app, provider, fetcher, headers: { cookie: `admin_session=${session.id}`, "x-csrf-token": session.csrfToken } };
}

describe("Admin model settings", () => {
  it("requires session and CSRF for both discovery and saves before calling upstream", async () => {
    const { app, headers, fetcher } = await fixture();
    try {
      for (const url of ["/admin/actions/models", "/admin/actions/model-settings"]) {
        expect((await app.inject({ method: "POST", url })).statusCode).toBe(401);
        expect((await app.inject({ method: "POST", url, headers: { cookie: headers.cookie } })).statusCode).toBe(403);
      }
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("shows current settings, saves a real selection, and updates API, dashboard, and connection test", async () => {
    const { app, headers } = await fixture();
    try {
      const initial = await app.inject({ url: "/admin/dashboard", headers });
      expect(initial.body).toContain('id="active-model">gemini-3.8-flash-high');
      expect(initial.body).toContain('id="active-thinking">high');
      const res = await app.inject({ method: "POST", url: "/admin/actions/model-settings", headers, payload: { model: "gemini-3.1-pro-preview", thinkingLevel: "medium" } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json().settings).toMatchObject({ model: "gemini-3.1-pro-preview", thinkingLevel: "medium" });
      const updated = await app.inject({ url: "/admin/dashboard", headers });
      expect(updated.body).toContain('id="active-thinking">medium');
      expect(updated.body).not.toContain("PRIVATE_");
      const models = await app.inject({ url: "/v1/models" });
      expect(models.json().data[0].id).toBe("gemini-3.1-pro-preview");
      const test = await app.inject({ method: "POST", url: "/admin/actions/test-connection", headers });
      expect(test.json()).toMatchObject({ ok: true, model: "gemini-3.1-pro-preview" });
      const chat = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "ignored", messages: [{ role: "user", content: "hi" }] } });
      expect(chat.json().model).toBe("gemini-3.1-pro-preview");
    } finally { await app.close(); }
  });
  it("rejects invalid settings without changing the active model", async () => {
    const { app, provider, headers } = await fixture();
    try {
      for (const payload of [{}, { model: "unknown", thinkingLevel: "low" }, { model: "gemini-3.1-pro-preview", thinkingLevel: "max" }, { model: "gemini-3.1-pro-preview", thinkingLevel: null }]) {
        expect((await app.inject({ method: "POST", url: "/admin/actions/model-settings", headers, payload })).statusCode).toBe(400);
      }
      expect((await provider.getModelSettings()).thinkingLevel).toBe("high");
    } finally { await app.close(); }
  });
  it("returns safe errors when model discovery fails and preserves settings", async () => {
    const { app, headers, fetcher, provider } = await fixture();
    fetcher.mockRejectedValue(new Error("PRIVATE_ERROR_SENTINEL"));
    try {
      const discovery = await app.inject({ method: "POST", url: "/admin/actions/models", headers });
      expect(discovery.statusCode).toBe(502);
      expect(discovery.body).not.toContain("PRIVATE_");
      const save = await app.inject({ method: "POST", url: "/admin/actions/model-settings", headers, payload: { model: "gemini-3.1-pro-preview", thinkingLevel: "low" } });
      expect(save.statusCode).toBe(503);
      expect(save.body).not.toContain("PRIVATE_");
      expect((await provider.getModelSettings()).thinkingLevel).toBe("high");
    } finally { await app.close(); }
  });
  it("escapes active labels and explains actual storage durability", () => {
    const html = renderModelSettings({ model: "gemini-3.8-flash-tiered", thinkingLevel: "high", publicModel: '<script>alert("x")</script>', storage: "file" }, true);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("ephemeral");
    expect(renderModelSettings(undefined, false)).toContain("could not be read");
  });
});
