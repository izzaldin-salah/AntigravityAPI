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

  // ---- v1.1 Auth bypass matrix (§15, §16) ----

  it("auth bypass matrix: /admin paths and /health bypass Bearer auth; /v1/** and /usage enforce Bearer auth", async () => {
    const config = loadConfig({
      NODE_ENV: "development",
      API_KEYS: "expected-secret-key",
    });

    const app = Fastify();

    // Register routes simulating the app endpoints
    app.get("/health", async () => ({ status: "ok" }));
    app.get("/admin", async () => ({ page: "admin-root" }));
    app.get("/admin/dashboard", async () => ({ page: "dashboard" }));
    app.post("/admin/actions/connect", async () => ({ status: "connect-started" }));
    app.get("/v1/models", async () => ({ object: "list", data: [] }));
    app.get("/usage", async () => ({ object: "usage", requests: 0 }));
    app.post("/v1/chat/completions", async () => ({ id: "chatcmpl-1" }));

    await registerSecurityPlugins(app, config);

    // 1. GET /health (and with query) -> 200 without Bearer
    const health1 = await app.inject({ method: "GET", url: "/health" });
    expect(health1.statusCode).toBe(200);

    const health2 = await app.inject({ method: "GET", url: "/health?check=1" });
    expect(health2.statusCode).toBe(200);

    // 2. /admin endpoints (any method) -> 200 without Bearer (admin plugin enforces its own session auth)
    const adminRoot = await app.inject({ method: "GET", url: "/admin" });
    expect(adminRoot.statusCode).toBe(200);

    const adminDashboard = await app.inject({ method: "GET", url: "/admin/dashboard" });
    expect(adminDashboard.statusCode).toBe(200);

    const adminAction = await app.inject({ method: "POST", url: "/admin/actions/connect" });
    expect(adminAction.statusCode).toBe(200);

    // 3. /v1/models -> 401 without Bearer, 200 with valid Bearer
    const modelsNoAuth = await app.inject({ method: "GET", url: "/v1/models" });
    expect(modelsNoAuth.statusCode).toBe(401);
    expect(modelsNoAuth.json().error.code).toBe("invalid_api_key");

    const modelsWithAuth = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer expected-secret-key" },
    });
    expect(modelsWithAuth.statusCode).toBe(200);

    // 4. /usage -> 401 without Bearer, 200 with valid Bearer
    const usageNoAuth = await app.inject({ method: "GET", url: "/usage" });
    expect(usageNoAuth.statusCode).toBe(401);

    const usageWithAuth = await app.inject({
      method: "GET",
      url: "/usage",
      headers: { authorization: "Bearer expected-secret-key" },
    });
    expect(usageWithAuth.statusCode).toBe(200);

    // 5. POST /v1/chat/completions -> 401 without Bearer
    const chatNoAuth = await app.inject({ method: "POST", url: "/v1/chat/completions" });
    expect(chatNoAuth.statusCode).toBe(401);

    await app.close();
  });
});
