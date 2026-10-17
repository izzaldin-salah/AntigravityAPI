import type { FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../types/config";
import type { OpenAIHealthResponse } from "../types/openai";

export interface HealthRouteOptions {
  config: AppConfig;
}

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (
  fastify,
  opts,
) => {
  fastify.get("/health", async (_req, reply) => {
    const response: OpenAIHealthResponse = {
      status: "ok",
      version: "0.1.0",
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      provider: { mode: opts.config.provider.mode },
    };
    return reply.status(200).send(response);
  });
};
