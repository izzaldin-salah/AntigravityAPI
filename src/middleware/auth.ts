/**
 * API Key Authentication Middleware.
 * Owner: antigravity-deployment-agent.
 * Frozen contract: docs/architecture-contract.md (§7, §9, §15).
 */
import * as crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../types/config";

declare module "fastify" {
  interface FastifyRequest {
    apiKey?: string;
  }
}

/**
 * Constant-time comparison between a candidate API key and a list of valid keys.
 * Uses SHA-256 digests to ensure buffers are always of identical length (32 bytes),
 * mitigating timing attacks regardless of input string lengths.
 */
export function timingSafeKeyMatch(candidateKey: string, allowedKeys: string[]): boolean {
  if (allowedKeys.length === 0 || !candidateKey) {
    return false;
  }

  const candidateHash = crypto.createHash("sha256").update(candidateKey).digest();
  let matched = false;

  for (const allowed of allowedKeys) {
    const allowedHash = crypto.createHash("sha256").update(allowed).digest();
    if (crypto.timingSafeEqual(candidateHash, allowedHash)) {
      matched = true;
    }
  }

  return matched;
}

/**
 * Checks if the request should bypass authentication.
 * Bypasses (contract §15):
 *  - OPTIONS requests (CORS preflight)
 *  - ALL /admin paths (any method; the admin plugin enforces its own session auth)
 *  - GET /health (query parameters tolerated)
 */
export function isAuthBypassed(request: FastifyRequest): boolean {
  if (request.method === "OPTIONS") {
    return true;
  }

  const pathname = request.url.split("?")[0];
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    return true;
  }

  if (request.method === "GET") {
    if (pathname === "/health") {
      return true;
    }
  }

  return false;
}

export function createAuthHook(config: AppConfig) {
  return async function authHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (isAuthBypassed(request)) {
      return;
    }

    // Outside production, if apiKeys is empty, allow through with a warning log
    if (config.apiKeys.length === 0) {
      request.log.warn(
        "API key authentication bypassed: config.apiKeys is empty (development mode only).",
      );
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader) {
      reply.header("x-request-id", request.id);
      return reply.status(401).send({
        error: {
          message: "Missing Authorization header. Use 'Authorization: Bearer <api_key>'.",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
      });
    }

    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
    if (!match) {
      reply.header("x-request-id", request.id);
      return reply.status(401).send({
        error: {
          message: "Invalid Authorization header format. Expected 'Bearer <api_key>'.",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
      });
    }

    const token = match[1];
    const isValid = timingSafeKeyMatch(token, config.apiKeys);

    if (!isValid) {
      reply.header("x-request-id", request.id);
      return reply.status(401).send({
        error: {
          message: "Incorrect API key provided.",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
      });
    }

    // Attach validated key to request for rate limiting and logging
    request.apiKey = token;
  };
}
