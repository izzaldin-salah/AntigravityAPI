import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../types/config";
import type { OpenAIHealthResponse } from "../types/openai";

export interface HealthRouteOptions {
  config: AppConfig;
}

interface BuildInfo {
  commit: string;
  branch: string;
  builtAt: string;
}

/**
 * Read the build metadata written by `scripts/write-build-info.mjs` at build
 * time, so a deployment can be identified by its commit without log access.
 */
function readBuildInfo(): BuildInfo | undefined {
  const candidates = [
    join(__dirname, "..", "build-info.json"),
    join(process.cwd(), "dist", "build-info.json"),
  ];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BuildInfo>;
      if (typeof parsed.commit === "string" && parsed.commit.length > 0) {
        return {
          commit: parsed.commit,
          branch: typeof parsed.branch === "string" ? parsed.branch : "unknown",
          builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : "unknown",
        };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (
  fastify,
  opts,
) => {
  fastify.get("/health", async (_req, reply) => {
    const build = readBuildInfo();
    const response: OpenAIHealthResponse = {
      status: "ok",
      version: "0.1.0",
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      provider: { mode: opts.config.provider.mode },
      ...(build ? { build } : {}),
    };
    return reply.status(200).send(response);
  });
};
