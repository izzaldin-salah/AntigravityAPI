/**
 * CORS plugin registration using @fastify/cors.
 * Owner: antigravity-deployment-agent.
 * Frozen contract: docs/architecture-contract.md (§6, §7, §9).
 */
import fastifyCors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../types/config";

export async function registerCors(
  app: FastifyInstance,
  config: AppConfig,
): Promise<void> {
  const origin = config.corsOrigins === "*" ? "*" : config.corsOrigins;

  await app.register(fastifyCors, {
    origin,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Request-Id",
      "Accept",
      "Origin",
    ],
    exposedHeaders: [
      "X-Request-Id",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "Retry-After",
    ],
  });
}
