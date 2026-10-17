/**
 * FROZEN SHARED CONTRACT — coordinator-owned (see docs/architecture-contract.md).
 * Changes require a handoff request; additive changes only.
 */

export type NodeEnv = "development" | "production" | "test";

/** In-memory fixed-window rate limiting. `max: 0` disables limiting. */
export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface AntigravityCredentials {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  projectId?: string;
  /** Base URL override for the upstream provider endpoint. */
  endpoint?: string;
  /** Path for an optional on-disk token cache. Ephemeral on Render Free. */
  tokenStorePath?: string;
}

export type ProviderConfig =
  | { mode: "mock" }
  | { mode: "antigravity"; credentials: AntigravityCredentials };

export interface AppConfig {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  logLevel: string;
  /** Empty array disables auth and is only permitted when nodeEnv !== "production". */
  apiKeys: string[];
  rateLimit: RateLimitConfig;
  corsOrigins: string[] | "*";
  trustProxy: boolean;
  provider: ProviderConfig;
}

/** Implicit dev key used when API_KEYS is unset outside production (with a warning). */
export const DEFAULT_DEV_API_KEY = "dev-local-key";

/** Redaction paths applied to structured (pino/fastify) logs. */
export const REDACT_LOG_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "res.headers['set-cookie']",
  "reply.headers['set-cookie']",
  "*.apiKey",
  "*.api_key",
  "*.accessToken",
  "*.access_token",
  "*.refreshToken",
  "*.refresh_token",
  "*.clientSecret",
  "*.client_secret",
  "*.password",
  "*.token",
];
