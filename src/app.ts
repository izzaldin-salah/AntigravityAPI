import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { registerAdminDashboard, renderDisabledPage } from "./admin";
import { OpenAIHttpError, formatOpenAIError } from "./core/errors";
import { UsageTracker } from "./core/usage-tracker";
import { RequestTracker, trackProvider } from "./core/request-tracker";
import { registerRoutes } from "./routes";
import type {
  CredentialStore,
  OAuthService,
  SessionStore,
} from "./types/admin";
import { REDACT_LOG_PATHS, type AppConfig } from "./types/config";
import type { AIProvider } from "./types/provider";

/** Maximum accepted request body (multimodal requests carry base64 images). */
const MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024;

export interface BuildAppAdminOptions {
  sessionStore: SessionStore;
  credentialStore: CredentialStore;
  oauthService: OAuthService;
}

export interface BuildAppOptions {
  config: AppConfig;
  provider: AIProvider;
  usageTracker?: UsageTracker;
  admin?: BuildAppAdminOptions;
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
    trustProxy: options.config.trustProxy,
    // Multimodal requests carry base64 images, which exceed Fastify's 1 MB
    // default. The per-image limit in the request validator (8 MB) and this
    // request ceiling keep the body size bounded.
    bodyLimit: MAX_REQUEST_BODY_BYTES,
  });

  // Register content-type parser for application/x-www-form-urlencoded using standard URLSearchParams
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body: string, done) => {
      try {
        const params = new URLSearchParams(body);
        const parsed: Record<string, string> = {};
        for (const [key, value] of params.entries()) {
          parsed[key] = value;
        }
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

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
  const requestTracker = new RequestTracker();

  await registerRoutes(app, {
    config: options.config,
    provider: trackProvider(options.provider, requestTracker, "api"),
    usageTracker,
  });

  if (options.admin && options.config.admin.enabled) {
    await registerAdminDashboard(app, {
      config: options.config,
      provider: options.provider,
      sessionStore: options.admin.sessionStore,
      credentialStore: options.admin.credentialStore,
      oauthService: options.admin.oauthService,
      requestTracker,
    });
  } else {
    app.get("/admin", async (_request, reply) => {
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply.send(renderDisabledPage());
    });
  }

  return app;
}
