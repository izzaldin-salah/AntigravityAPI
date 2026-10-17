/**
 * Security middleware registration.
 * Owner: antigravity-deployment-agent.
 * Frozen contract: docs/architecture-contract.md (§4, §7, §9).
 *
 * Called once by src/server.ts after buildApp() and before listen().
 * Root-scope hooks apply globally even to already-registered routes.
 */
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../types/config";
import { createAuthHook } from "./auth";
import { registerCors } from "./cors";
import { createErrorHandler } from "./error-handler";
import { createRateLimitHook } from "./rate-limit";

export * from "./auth";
export * from "./cors";
export * from "./error-handler";
export * from "./rate-limit";

export async function registerSecurityPlugins(
  app: FastifyInstance,
  config: AppConfig,
): Promise<void> {
  // 1. Centralized Error Handler (attached to root scope)
  app.setErrorHandler(createErrorHandler(config));

  // 2. Correlation Request-ID hook: ensures x-request-id is populated on all responses
  app.addHook("onSend", async (request, reply) => {
    if (!reply.hasHeader("x-request-id")) {
      reply.header("x-request-id", request.id);
    }
  });

  // 3. Rate limiting hook (onRequest hook)
  app.addHook("onRequest", createRateLimitHook(config));

  // 4. API Key Authentication hook (onRequest hook)
  app.addHook("onRequest", createAuthHook(config));

  // 5. CORS plugin
  await registerCors(app, config);
}
