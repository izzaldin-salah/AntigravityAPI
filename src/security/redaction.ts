/**
 * Redaction utilities for structured logging and sensitive data protection.
 * Owner: antigravity-deployment-agent.
 * Frozen contract: docs/architecture-contract.md (§2, §6, §7), src/types/config.ts.
 */
import { REDACT_LOG_PATHS } from "../types/config";

export const REDACT_CENSOR = "[Redacted]";

/**
 * Pino/Fastify logger redaction options using the frozen REDACT_LOG_PATHS list.
 */
export function getRedactionConfig(censor: string = REDACT_CENSOR): {
  paths: string[];
  censor: string;
} {
  return {
    paths: [...REDACT_LOG_PATHS],
    censor,
  };
}

/**
 * Redacts a bearer token string (e.g. "Bearer secret-123" -> "Bearer [Redacted]").
 */
export function redactBearerToken(authHeader: string | undefined): string {
  if (!authHeader) return "";
  if (authHeader.startsWith("Bearer ")) {
    return `Bearer ${REDACT_CENSOR}`;
  }
  return REDACT_CENSOR;
}

/**
 * Deep-clones an object and replaces values of sensitive keys with "[Redacted]".
 * Keys checked case-insensitively include: apikey, api_key, accesstoken, access_token,
 * refreshtoken, refresh_token, clientsecret, client_secret, password, token, authorization, cookie.
 */
const SENSITIVE_KEY_REGEX =
  /^(apikey|api_key|accesstoken|access_token|refreshtoken|refresh_token|clientsecret|client_secret|password|token|authorization|cookie)$/i;

export function redactSensitiveObject<T>(input: T, censor: string = REDACT_CENSOR): T {
  if (input === null || typeof input !== "object") {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveObject(item, censor)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      result[key] = censor;
    } else if (value !== null && typeof value === "object") {
      result[key] = redactSensitiveObject(value, censor);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}
