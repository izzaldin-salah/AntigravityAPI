import type { OpenAIErrorBody } from "../types/openai";
import { ProviderError, type ProviderErrorPayload } from "../types/provider";

export function formatOpenAIError(
  message: string,
  type = "invalid_request_error",
  param: string | null = null,
  code: string | null = null,
): OpenAIErrorBody {
  return {
    error: {
      message,
      type,
      param,
      code,
    },
  };
}

export class OpenAIHttpError extends Error {
  readonly status: number;
  readonly body: OpenAIErrorBody;

  constructor(
    status: number,
    message: string,
    type = "invalid_request_error",
    param: string | null = null,
    code: string | null = null,
  ) {
    super(message);
    this.name = "OpenAIHttpError";
    this.status = status;
    this.body = formatOpenAIError(message, type, param, code);
  }
}

export interface HttpErrorMapping {
  status: number;
  body: OpenAIErrorBody;
}

export function mapProviderErrorToHttp(err: unknown): HttpErrorMapping {
  let payload: ProviderErrorPayload | undefined;

  if (err instanceof ProviderError) {
    payload = err.payload;
  } else if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    payload = err as ProviderErrorPayload;
  }

  if (!payload) {
    const message =
      err instanceof Error ? err.message : "An unexpected server error occurred.";
    return {
      status: 500,
      body: formatOpenAIError(message, "server_error", null, "internal_error"),
    };
  }

  const message = payload.message || "Provider error";

  switch (payload.code) {
    case "invalid_request":
      return {
        status: 400,
        body: formatOpenAIError(message, "invalid_request_error", null, "invalid_request"),
      };
    case "unauthorized":
      return {
        status: 502,
        body: formatOpenAIError(message, "api_error", null, "provider_auth_error"),
      };
    case "not_found":
      return {
        status: 404,
        body: formatOpenAIError(message, "invalid_request_error", null, "model_not_found"),
      };
    case "rate_limited":
      return {
        status: 429,
        body: formatOpenAIError(message, "rate_limit_error", null, "rate_limit_exceeded"),
      };
    case "timeout":
      return {
        status: 504,
        body: formatOpenAIError(message, "api_error", null, "upstream_timeout"),
      };
    case "aborted":
      return {
        status: 499,
        body: formatOpenAIError(message, "api_error", null, "client_closed_request"),
      };
    case "upstream_error":
      return {
        status: 502,
        body: formatOpenAIError(message, "api_error", null, "upstream_error"),
      };
    case "not_implemented":
      return {
        status: 501,
        body: formatOpenAIError(message, "server_error", null, "not_implemented"),
      };
    case "unknown":
    default:
      return {
        status: 500,
        body: formatOpenAIError(message, "server_error", null, "internal_error"),
      };
  }
}
