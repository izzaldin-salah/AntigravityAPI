/**
 * STUB — owner: antigravity-deployment-agent.
 * Replace with the real security plugin registration described in
 * docs/architecture-contract.md (§9): CORS, API-key auth, rate limiting,
 * centralized error handling. Called once by src/server.ts after buildApp().
 */
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../types/config";

export async function registerSecurityPlugins(
  _app: FastifyInstance,
  _config: AppConfig,
): Promise<void> {
  /* no-op scaffold stub */
}
