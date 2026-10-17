import type { FastifyInstance } from "fastify";
import type { UsageTracker } from "../core/usage-tracker";
import type { AppConfig } from "../types/config";
import type { AIProvider } from "../types/provider";
import { chatRoutes } from "./chat";
import { healthRoutes } from "./health";
import { modelsRoutes } from "./models";
import { usageRoutes } from "./usage";

export interface RegisterRoutesOptions {
  config: AppConfig;
  provider: AIProvider;
  usageTracker: UsageTracker;
}

export async function registerRoutes(
  app: FastifyInstance,
  options: RegisterRoutesOptions,
): Promise<void> {
  await app.register(healthRoutes, { config: options.config });
  await app.register(modelsRoutes, { provider: options.provider });
  await app.register(usageRoutes, {
    provider: options.provider,
    usageTracker: options.usageTracker,
  });
  await app.register(chatRoutes, {
    provider: options.provider,
    usageTracker: options.usageTracker,
  });
}

export { chatRoutes, healthRoutes, modelsRoutes, usageRoutes };
