/**
 * SCAFFOLD PLACEHOLDER — owner: antigravity-api-agent.
 * Replace with the full Fastify application per docs/architecture-contract.md (§7-§9).
 * Final frozen signature: buildApp({ config, provider, usageTracker }): Promise<FastifyInstance>
 */
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { REDACT_LOG_PATHS, type AppConfig } from "./types/config";
import type { AIProvider } from "./types/provider";

export interface BuildAppOptions {
  config: AppConfig;
  provider: AIProvider;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.config.logLevel, redact: REDACT_LOG_PATHS },
    genReqId: () => `req_${randomUUID()}`,
  });

  app.get("/health", async () => ({
    status: "ok",
    version: "0.1.0",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    provider: { mode: options.config.provider.mode },
  }));

  return app;
}
