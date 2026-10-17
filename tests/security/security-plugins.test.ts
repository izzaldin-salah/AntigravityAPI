import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env";
import { registerSecurityPlugins } from "../../src/middleware";
import { ProviderError } from "../../src/types/provider";

describe("Integrated Security Plugins (tests/security/security-plugins.test.ts)", () => {
  it("CORS preflight OPTIONS passes without auth and returns CORS headers", async () => {
    const config = loadConfig({
      NODE_ENV: "production",
      API_KEYS: "production-secure-key",
      CORS_ORIGINS: "http://localhost:3000,https://app.client.com",
    });

    const app = Fastify();
    app.post("/v1/chat/completions", async () => ({ id: "chatcmpl-test" }));
    await registerSecurityPlugins(app, config);

    // OPTIONS preflight
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/chat/completions",
      headers: {
        origin: "https://app.client.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "Authorization, Content-Type",
      },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      "https://app.client.com",
    );
    expect(preflight.headers["x-request-id"]).toBeDefined();

    await app.close();
  });

  it("handles authenticated requests and appends x-request-id header", async () => {
    const config = loadConfig({
      NODE_ENV: "development",
      API_KEYS: "my-valid-key",
    });

    const app = Fastify();
    app.get("/v1/models", async () => ({ object: "list" }));
    await registerSecurityPlugins(app, config);

    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer my-valid-key" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();

    await app.close();
  });

  it("error handler maps ProviderError into canonical status and envelope", async () => {
    const config = loadConfig({
      NODE_ENV: "development",
      API_KEYS: "err-key",
    });

    const app = Fastify();
    app.get("/trigger-provider-err", async () => {
      throw new ProviderError({
        code: "rate_limited",
        message: "Upstream rate limit reached",
      });
    });
    app.get("/trigger-auth-err", async () => {
      throw new ProviderError({
        code: "unauthorized",
        message: "Invalid upstream credentials",
      });
    });
    await registerSecurityPlugins(app, config);

    // Rate limited -> 429
    const rateLimitRes = await app.inject({
      method: "GET",
      url: "/trigger-provider-err",
      headers: { authorization: "Bearer err-key" },
    });
    expect(rateLimitRes.statusCode).toBe(429);
    expect(rateLimitRes.json()).toEqual({
      error: {
        message: "Upstream rate limit reached",
        type: "rate_limit_error",
        param: null,
        code: "rate_limit_exceeded",
      },
    });

    // Unauthorized -> 502 provider_auth_error
    const authRes = await app.inject({
      method: "GET",
      url: "/trigger-auth-err",
      headers: { authorization: "Bearer err-key" },
    });
    expect(authRes.statusCode).toBe(502);
    expect(authRes.json()).toEqual({
      error: {
        message: "Invalid upstream credentials",
        type: "api_error",
        param: null,
        code: "provider_auth_error",
      },
    });

    await app.close();
  });

  it("error handler handles 500 without leaking stack traces in production", async () => {
    const config = loadConfig({
      NODE_ENV: "production",
      API_KEYS: "prod-key",
    });

    const app = Fastify();
    app.get("/throw-unhandled", async () => {
      throw new Error("Sensitive internal database connection failed at line 42");
    });
    await registerSecurityPlugins(app, config);

    const res = await app.inject({
      method: "GET",
      url: "/throw-unhandled",
      headers: { authorization: "Bearer prod-key" },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toEqual({
      error: {
        message: "Internal server error",
        type: "server_error",
        param: null,
        code: "internal_error",
      },
    });
    // Ensure no stack trace in body
    expect(JSON.stringify(body)).not.toContain("line 42");
    expect(JSON.stringify(body)).not.toContain("stack");

    await app.close();
  });
});
