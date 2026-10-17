import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { OpenAIHttpError, formatOpenAIError } from "./core/errors";
import { UsageTracker } from "./core/usage-tracker";
import { registerRoutes } from "./routes";
import { REDACT_LOG_PATHS, type AppConfig } from "./types/config";
import type { AIProvider } from "./types/provider";

export interface BuildAppOptions {
  config: AppConfig;
  provider: AIProvider;
  usageTracker?: UsageTracker;
}

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.config.logLevel,
      redact: REDACT_LOG_PATHS,
    },
    genReqId: () => `req_${randomUUID()}`,
  });

  // Set x-request-id response header to correlation id
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  // Error handler enforcing OpenAI error envelope
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof OpenAIHttpError) {
      return reply.status(error.status).send(error.body);
    }

    const err = error as { statusCode?: number; message?: string };
    if (
      typeof err.statusCode === "number" &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    ) {
      return reply
        .status(err.statusCode)
        .send(
          formatOpenAIError(
            err.message ?? "Bad Request",
            "invalid_request_error",
            null,
            null,
          ),
        );
    }

    request.log.error(error);
    return reply
      .status(500)
      .send(
        formatOpenAIError(
          "Internal server error",
          "server_error",
          null,
          "internal_error",
        ),
      );
  });

  const usageTracker = options.usageTracker ?? new UsageTracker();

  await registerRoutes(app, {
    config: options.config,
    provider: options.provider,
    usageTracker,
  });

  return app;
}
