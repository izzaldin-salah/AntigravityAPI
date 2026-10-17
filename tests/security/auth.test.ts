import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env";
import { createAuthHook, timingSafeKeyMatch } from "../../src/middleware/auth";

describe("API Key Authentication (tests/security/auth.test.ts)", () => {
  it("timingSafeKeyMatch verifies keys securely", () => {
    const keys = ["secret-key-1", "secret-key-2"];
    expect(timingSafeKeyMatch("secret-key-1", keys)).toBe(true);
    expect(timingSafeKeyMatch("secret-key-2", keys)).toBe(true);
    expect(timingSafeKeyMatch("wrong-key", keys)).toBe(false);
    expect(timingSafeKeyMatch("", keys)).toBe(false);
    expect(timingSafeKeyMatch("secret-key-1", [])).toBe(false);
  });

  it("returns 401 with error envelope when Authorization header is missing", async () => {
    const config = loadConfig({
      NODE_ENV: "development",
      API_KEYS: "test-secret-key",
    });

    const app = Fastify();
    app.addHook("onRequest", createAuthHook(config));
    app.get("/v1/models", async () => ({ object: "list", data: [] }));

    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body).toEqual({
      error: {
        message: expect.stringContaining("Missing Authorization header"),
        type: "invalid_request_error",
        param: null,
        code: "invalid_api_key",
      },
    });

    await app.close();
  });

  it("returns 401 when Authorization header has invalid format or incorrect key", async () => {
    const config = loadConfig({
      NODE_ENV: "development",
      API_KEYS: "test-secret-key",
    });

    const app = Fastify();
    app.addHook("onRequest", createAuthHook(config));
    app.get("/test", async () => ({ ok: true }));

    // Bad format
    const badFormat = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Basic some-credentials" },
    });
    expect(badFormat.statusCode).toBe(401);
    expect(badFormat.json().error.code).toBe("invalid_api_key");

    // Incorrect key
    const badKey = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer wrong-key" },
    });
    expect(badKey.statusCode).toBe(401);
    expect(badKey.json().error.code).toBe("invalid_api_key");

    await app.close();
  });

  it("returns 200 when valid API key is supplied", async () => {
    const config = loadConfig({
      NODE_ENV: "development",
      API_KEYS: "key-a,key-b",
    });

    const app = Fastify();
    app.addHook("onRequest", createAuthHook(config));
    app.get("/v1/models", async () => ({ object: "list" }));

    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer key-b" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ object: "list" });

    await app.close();
  });

  it("bypasses authentication for GET /health and OPTIONS preflight", async () => {
    const config = loadConfig({
      NODE_ENV: "development",
      API_KEYS: "strict-key",
    });

    const app = Fastify();
    app.addHook("onRequest", createAuthHook(config));
    app.get("/health", async () => ({ status: "ok" }));
    app.options("/test", async () => "ok");

    // GET /health without auth
    const healthRes = await app.inject({
      method: "GET",
      url: "/health",
    });
    expect(healthRes.statusCode).toBe(200);

    // OPTIONS /test without auth
    const optionsRes = await app.inject({
      method: "OPTIONS",
      url: "/test",
    });
    expect(optionsRes.statusCode).toBe(200);

    await app.close();
  });

  it("allows requests through in dev when config.apiKeys is empty (dev only)", async () => {
    const config = loadConfig({ NODE_ENV: "development" });
    // Manually test empty array state
    config.apiKeys = [];

    const app = Fastify();
    app.addHook("onRequest", createAuthHook(config));
    app.get("/v1/test", async () => ({ success: true }));

    const res = await app.inject({
      method: "GET",
      url: "/v1/test",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    await app.close();
  });
});
