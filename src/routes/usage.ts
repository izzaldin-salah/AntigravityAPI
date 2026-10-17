import type { FastifyPluginAsync } from "fastify";
import type { UsageTracker } from "../core/usage-tracker";
import type { OpenAIUsageResponse } from "../types/openai";
import type { AIProvider, UsageInfo } from "../types/provider";

export interface UsageRouteOptions {
  provider: AIProvider;
  usageTracker: UsageTracker;
}

export const usageRoutes: FastifyPluginAsync<UsageRouteOptions> = async (
  fastify,
  opts,
) => {
  fastify.get("/usage", async (_req, reply) => {
    const snapshot = opts.usageTracker.snapshot();

    let providerUsage: UsageInfo | null = null;
    try {
      providerUsage = await opts.provider.getUsage();
    } catch {
      // Provider failure should degrade gracefully to provider: null and never 500
      providerUsage = null;
    }

    const response: OpenAIUsageResponse = {
      object: "usage",
      data: {
        requests: snapshot.requests,
        prompt_tokens: snapshot.prompt_tokens,
        completion_tokens: snapshot.completion_tokens,
        total_tokens: snapshot.total_tokens,
        by_model: snapshot.by_model,
        since: snapshot.since,
        provider: providerUsage,
      },
    };

    return reply.status(200).send(response);
  });
};
