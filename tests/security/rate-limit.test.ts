import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env";
import {
  createFixedWindowLimiter,
  createRateLimitHook,
  InMemoryRateLimiter,
} from "../../src/middleware/rate-limit";

describe("Rate Limiting Middleware (tests/security/rate-limit.test.ts)", () => {
  it("sets X-RateLimit headers and permits requests under the limit", async () => {
    const config = loadConfig({
      RATE_LIMIT_MAX: "3",
      RATE_LIMIT_WINDOW_MS: "10000",
    });

    const app = Fastify();
    app.addHook("onRequest", createRateLimitHook(config));
    app.get("/test", async () => ({ ok: true }));

    const res1 = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer user-key" },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers["x-ratelimit-limit"]).toBe("3");
    expect(res1.headers["x-ratelimit-remaining"]).toBe("2");
    expect(res1.headers["x-ratelimit-reset"]).toBeDefined();

    const res2 = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer user-key" },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers["x-ratelimit-remaining"]).toBe("1");

    await app.close();
  });

  it("returns 429 + Retry-After + error envelope when rate limit is exceeded", async () => {
    const config = loadConfig({
      RATE_LIMIT_MAX: "2",
      RATE_LIMIT_WINDOW_MS: "5000",
    });

    const app = Fastify();
    app.addHook("onRequest", createRateLimitHook(config));
    app.get("/test", async () => ({ ok: true }));

    // Request 1: remaining 1
    await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer limit-key" },
    });
    // Request 2: remaining 0
    await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer limit-key" },
    });

    // Request 3: exceeded!
    const res3 = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer limit-key" },
    });

    expect(res3.statusCode).toBe(429);
    expect(res3.headers["retry-after"]).toBeDefined();
    const retryAfter = Number(res3.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);

    expect(res3.headers["x-ratelimit-limit"]).toBe("2");
    expect(res3.headers["x-ratelimit-remaining"]).toBe("0");

    const body = res3.json();
    expect(body).toEqual({
      error: {
        message: "Rate limit exceeded. Please try again later.",
        type: "rate_limit_error",
        param: null,
        code: "rate_limit_exceeded",
      },
    });

    await app.close();
  });

  it("RATE_LIMIT_MAX=0 disables rate limiting", async () => {
    const config = loadConfig({
      RATE_LIMIT_MAX: "0",
      RATE_LIMIT_WINDOW_MS: "60000",
    });

    const app = Fastify();
    app.addHook("onRequest", createRateLimitHook(config));
    app.get("/test", async () => ({ ok: true }));

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { authorization: "Bearer unlimited-key" },
      });
      expect(res.statusCode).toBe(200);
    }

    await app.close();
  });

  it("resets limit after window expiry with real timers (small windowMs)", async () => {
    const windowMs = 40; // 40ms window
    const config = loadConfig({
      RATE_LIMIT_MAX: "1",
      RATE_LIMIT_WINDOW_MS: String(windowMs),
    });

    const app = Fastify();
    app.addHook("onRequest", createRateLimitHook(config));
    app.get("/test", async () => ({ ok: true }));

    // Request 1: allowed
    const res1 = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer timer-key" },
    });
    expect(res1.statusCode).toBe(200);

    // Request 2 (immediate): rate limited
    const res2 = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer timer-key" },
    });
    expect(res2.statusCode).toBe(429);

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, windowMs + 20));

    // Request 3 (after windowMs): allowed again
    const res3 = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer timer-key" },
    });
    expect(res3.statusCode).toBe(200);
    expect(res3.headers["x-ratelimit-remaining"]).toBe("0");

    await app.close();
  });

  it("partitions rate limits by API key, and falls back to client IP", async () => {
    const limiter = new InMemoryRateLimiter(60000, 1, true);

    const app = Fastify();
    app.addHook("onRequest", createRateLimitHook(loadConfig({}), limiter));
    app.get("/test", async () => ({ ok: true }));

    // User A using key-a
    const resA1 = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer key-a" },
    });
    expect(resA1.statusCode).toBe(200);

    // User A exceeds
    const resA2 = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer key-a" },
    });
    expect(resA2.statusCode).toBe(429);

    // User B with key-b still allowed
    const resB = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer key-b" },
    });
    expect(resB.statusCode).toBe(200);

    // IP-based request with X-Forwarded-For when trustProxy=true
    const resIp1 = await app.inject({
      method: "GET",
      url: "/test",
      headers: { "x-forwarded-for": "198.51.100.1" },
    });
    expect(resIp1.statusCode).toBe(200);

    const resIp2 = await app.inject({
      method: "GET",
      url: "/test",
      headers: { "x-forwarded-for": "198.51.100.1" },
    });
    expect(resIp2.statusCode).toBe(429);

    await app.close();
  });

  // ---- v1.1 createFixedWindowLimiter tests (§15, §16) ----

  describe("createFixedWindowLimiter factory", () => {
    it("max: 0 disables limiting completely", () => {
      const limiter = createFixedWindowLimiter({ windowMs: 1000, max: 0 });
      for (let i = 0; i < 20; i++) {
        const res = limiter("any-key");
        expect(res.allowed).toBe(true);
        expect(res.limit).toBe(0);
        expect(res.remaining).toBe(0);
        expect(res.retryAfterSeconds).toBe(0);
      }
    });

    it("tracks count and emits Retry-After when max is exceeded", () => {
      const limiter = createFixedWindowLimiter({ windowMs: 5000, max: 2 });
      const r1 = limiter("user-1");
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(1);
      expect(r1.limit).toBe(2);

      const r2 = limiter("user-1");
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(0);

      const r3 = limiter("user-1");
      expect(r3.allowed).toBe(false);
      expect(r3.remaining).toBe(0);
      expect(r3.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(r3.retryAfterSeconds).toBeLessThanOrEqual(5);

      // Other key still permitted
      const other = limiter("user-2");
      expect(other.allowed).toBe(true);
      expect(other.remaining).toBe(1);
    });

    it("resets window after windowMs has elapsed", async () => {
      const windowMs = 50;
      const limiter = createFixedWindowLimiter({ windowMs, max: 1 });

      const r1 = limiter("user-temp");
      expect(r1.allowed).toBe(true);

      const r2 = limiter("user-temp");
      expect(r2.allowed).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, windowMs + 20));

      const r3 = limiter("user-temp");
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);
    });
  });
});
