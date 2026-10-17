/**
 * STUB — owner: antigravity-deployment-agent.
 * Replace with the validated loader described in docs/architecture-contract.md (§6):
 * zod schema, fail-fast on invalid env, production requires API_KEYS.
 */
import { DEFAULT_DEV_API_KEY } from "../types/config";
import type {
  AntigravityCredentials,
  AppConfig,
  NodeEnv,
  ProviderConfig,
} from "../types/config";

function pickAntigravity(env: NodeJS.ProcessEnv): AntigravityCredentials {
  return {
    accessToken: env.ANTIGRAVITY_ACCESS_TOKEN,
    refreshToken: env.ANTIGRAVITY_REFRESH_TOKEN,
    clientId: env.ANTIGRAVITY_CLIENT_ID,
    clientSecret: env.ANTIGRAVITY_CLIENT_SECRET,
    projectId: env.ANTIGRAVITY_PROJECT_ID,
    endpoint: env.ANTIGRAVITY_ENDPOINT,
    tokenStorePath: env.ANTIGRAVITY_TOKEN_STORE_PATH,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV as NodeEnv) ?? "development";
  const apiKeys = (env.API_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const provider: ProviderConfig =
    env.PROVIDER_MODE === "antigravity"
      ? { mode: "antigravity", credentials: pickAntigravity(env) }
      : { mode: "mock" };
  return {
    nodeEnv,
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 3000),
    logLevel: env.LOG_LEVEL ?? "info",
    apiKeys:
      apiKeys.length > 0
        ? apiKeys
        : nodeEnv === "production"
          ? []
          : [DEFAULT_DEV_API_KEY],
    rateLimit: {
      windowMs: Number(env.RATE_LIMIT_WINDOW_MS ?? 60000),
      max: Number(env.RATE_LIMIT_MAX ?? 60),
    },
    corsOrigins:
      env.CORS_ORIGINS && env.CORS_ORIGINS !== "*"
        ? env.CORS_ORIGINS.split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : "*",
    trustProxy: env.TRUST_PROXY === "true" || env.TRUST_PROXY === "1",
    provider,
  };
}
