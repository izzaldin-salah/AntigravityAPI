/**
 * Fixed-window in-memory rate limiting middleware.
 * Owner: antigravity-deployment-agent.
 * Frozen contract: docs/architecture-contract.md (§6, §7, §9).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../types/config";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export function getClientIp(request: FastifyRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = request.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim().length > 0) {
      return xff.split(",")[0].trim();
    }
    if (Array.isArray(xff) && xff.length > 0) {
      return xff[0].split(",")[0].trim();
    }
  }

  return request.ip || request.socket.remoteAddress || "127.0.0.1";
}

export class InMemoryRateLimiter {
  private readonly store = new Map<string, RateLimitEntry>();
  private lastPruneTime = Date.now();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
    private readonly trustProxy: boolean,
  ) {}

  public getRateLimitKey(request: FastifyRequest): string {
    if (request.apiKey) {
      return `key:${request.apiKey}`;
    }

    const authHeader = request.headers.authorization;
    if (authHeader) {
      const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
      if (match) {
        return `key:${match[1]}`;
      }
    }

    return `ip:${getClientIp(request, this.trustProxy)}`;
  }

  public check(key: string, now: number = Date.now()): {
    allowed: boolean;
    limit: number;
    remaining: number;
    resetAt: number;
    retryAfterSeconds: number;
  } {
    // max = 0 disables rate limiting
    if (this.max === 0) {
      return {
        allowed: true,
        limit: 0,
        remaining: 0,
        resetAt: Math.ceil((now + this.windowMs) / 1000),
        retryAfterSeconds: 0,
      };
    }

    this.maybePrune(now);

    let entry = this.store.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = {
        count: 1,
        resetAt: now + this.windowMs,
      };
      this.store.set(key, entry);

      return {
        allowed: true,
        limit: this.max,
        remaining: Math.max(0, this.max - 1),
        resetAt: Math.ceil(entry.resetAt / 1000),
        retryAfterSeconds: 0,
      };
    }

    if (entry.count < this.max) {
      entry.count += 1;
      return {
        allowed: true,
        limit: this.max,
        remaining: Math.max(0, this.max - entry.count),
        resetAt: Math.ceil(entry.resetAt / 1000),
        retryAfterSeconds: 0,
      };
    }

    // Over limit
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return {
      allowed: false,
      limit: this.max,
      remaining: 0,
      resetAt: Math.ceil(entry.resetAt / 1000),
      retryAfterSeconds: retryAfter,
    };
  }

  public reset(): void {
    this.store.clear();
  }

  private maybePrune(now: number): void {
    // Prune expired entries every 30 seconds or if map exceeds 2000 entries
    if (now - this.lastPruneTime > 30000 || this.store.size > 2000) {
      this.lastPruneTime = now;
      for (const [k, v] of this.store.entries()) {
        if (now >= v.resetAt) {
          this.store.delete(k);
        }
      }
    }
  }
}

export function createRateLimitHook(config: AppConfig, limiter?: InMemoryRateLimiter) {
  const activeLimiter =
    limiter ||
    new InMemoryRateLimiter(
      config.rateLimit.windowMs,
      config.rateLimit.max,
      config.trustProxy,
    );

  return async function rateLimitHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (config.rateLimit.max === 0) {
      return;
    }

    // Skip OPTIONS and GET /health
    if (request.method === "OPTIONS") {
      return;
    }
    if (
      request.method === "GET" &&
      (request.url === "/health" || request.url.startsWith("/health?"))
    ) {
      return;
    }

    const key = activeLimiter.getRateLimitKey(request);
    const result = activeLimiter.check(key);

    reply.header("X-RateLimit-Limit", String(result.limit));
    reply.header("X-RateLimit-Remaining", String(result.remaining));
    reply.header("X-RateLimit-Reset", String(result.resetAt));
    reply.header("x-request-id", request.id);

    if (!result.allowed) {
      reply.header("Retry-After", String(result.retryAfterSeconds));
      return reply.status(429).send({
        error: {
          message: "Rate limit exceeded. Please try again later.",
          type: "rate_limit_error",
          param: null,
          code: "rate_limit_exceeded",
        },
      });
    }
  };
}

/**
 * v1.1 seam (architecture contract §15) — generic fixed-window limiter used by
 * the admin login gate. STUB: owner antigravity-deployment-agent refines and
 * tests it during the dashboard wave; behavior/signature is frozen.
 *
 * `max: 0` disables limiting (always allowed).
 */
export function createFixedWindowLimiter(opts: {
  windowMs: number;
  max: number;
}): (key: string) => {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
  limit: number;
} {
  const store = new Map<string, RateLimitEntry>();

  return (key: string) => {
    const now = Date.now();

    if (opts.max === 0) {
      return { allowed: true, retryAfterSeconds: 0, remaining: 0, limit: 0 };
    }

    // Lazy prune to keep memory bounded under traffic.
    if (store.size > 2000) {
      for (const [k, v] of store.entries()) {
        if (now >= v.resetAt) store.delete(k);
      }
    }

    let entry = store.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 1, resetAt: now + opts.windowMs };
      store.set(key, entry);
      return {
        allowed: true,
        retryAfterSeconds: 0,
        remaining: Math.max(0, opts.max - 1),
        limit: opts.max,
      };
    }

    if (entry.count < opts.max) {
      entry.count += 1;
      return {
        allowed: true,
        retryAfterSeconds: 0,
        remaining: Math.max(0, opts.max - entry.count),
        limit: opts.max,
      };
    }

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      remaining: 0,
      limit: opts.max,
    };
  };
}
