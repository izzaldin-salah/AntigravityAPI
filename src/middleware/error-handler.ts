/**
 * Centralized Fastify error handler.
 * Owner: antigravity-deployment-agent.
 * Frozen contract: docs/architecture-contract.md (§7, §8).
 */
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../types/config";
import type { ProviderErrorPayload } from "../types/provider";

const PROVIDER_CODE_MAP: Record<
  string,
  { status: number; type: string; code: string }
> = {
  invalid_request: {
    status: 400,
    type: "invalid_request_error",
    code: "invalid_request",
  },
  unauthorized: {
    status: 502,
    type: "api_error",
    code: "provider_auth_error",
  },
  not_found: {
    status: 404,
    type: "invalid_request_error",
    code: "model_not_found",
  },
  rate_limited: {
    status: 429,
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
  },
  timeout: {
    status: 504,
    type: "api_error",
    code: "upstream_timeout",
  },
  aborted: {
    status: 499,
    type: "api_error",
    code: "client_closed_request",
  },
  upstream_error: {
    status: 502,
    type: "api_error",
    code: "upstream_error",
  },
  not_implemented: {
    status: 501,
    type: "server_error",
    code: "not_implemented",
  },
  unknown: {
    status: 500,
    type: "server_error",
    code: "internal_error",
  },
};

function extractProviderPayload(error: unknown): ProviderErrorPayload | undefined {
  if (typeof error === "object" && error !== null && "payload" in error) {
    const p = (error as { payload: unknown }).payload;
    if (
      typeof p === "object" &&
      p !== null &&
      "code" in p &&
      typeof (p as { code: unknown }).code === "string"
    ) {
      return p as ProviderErrorPayload;
    }
  }
  return undefined;
}

function extractParam(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.param === "string") {
      return obj.param;
    }
    if (typeof obj.validationContext === "string") {
      return obj.validationContext;
    }
  }
  return null;
}

export function createErrorHandler(config: AppConfig) {
  return function errorHandler(
    error: FastifyError | Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    reply.header("x-request-id", request.id);

    // 1. Check for ProviderError or ProviderErrorPayload-shaped error
    const providerPayload = extractProviderPayload(error);
    if (providerPayload) {
      const mapped = PROVIDER_CODE_MAP[providerPayload.code] || {
        status: providerPayload.status || 500,
        type: "server_error",
        code: "internal_error",
      };

      const httpStatus = providerPayload.status || mapped.status;
      reply.status(httpStatus).send({
        error: {
          message: providerPayload.message || "An upstream provider error occurred.",
          type: mapped.type,
          param: null,
          code: mapped.code,
        },
      });
      return;
    }

    // 2. Check for Fastify HTTP / validation errors with statusCode
    const fastifyErr = error as Partial<FastifyError>;
    const statusCode = fastifyErr.statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 600) {
      if (statusCode === 400) {
        reply.status(400).send({
          error: {
            message: error.message,
            type: "invalid_request_error",
            param: extractParam(error),
            code: fastifyErr.code || "invalid_request",
          },
        });
        return;
      }

      if (statusCode === 404) {
        reply.status(404).send({
          error: {
            message: error.message || "Resource not found.",
            type: "invalid_request_error",
            param: null,
            code: "not_found",
          },
        });
        return;
      }

      if (statusCode === 429) {
        reply.status(429).send({
          error: {
            message: error.message || "Rate limit exceeded.",
            type: "rate_limit_error",
            param: null,
            code: "rate_limit_exceeded",
          },
        });
        return;
      }

      if (statusCode < 500) {
        reply.status(statusCode).send({
          error: {
            message: error.message,
            type: "invalid_request_error",
            param: extractParam(error),
            code: fastifyErr.code || null,
          },
        });
        return;
      }
    }

    // 3. Unhandled server errors (500)
    request.log.error(error);

    const message =
      config.nodeEnv === "production"
        ? "Internal server error"
        : error.message || "Internal server error";

    reply.status(500).send({
      error: {
        message,
        type: "server_error",
        param: null,
        code: "internal_error",
      },
    });
  };
}
