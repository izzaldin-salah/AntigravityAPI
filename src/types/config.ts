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

/** v1.1: admin dashboard configuration (resolved by loadConfig; secrets never logged). */
export interface AdminConfig {
  enabled: boolean;
  /** Resolved plaintext password (mutually exclusive with passwordHash). Never log. */
  password?: string;
  /** Resolved scrypt hash `scrypt$N$r$p$<saltB64>$<hashB64>`. Never log. */
  passwordHash?: string;
  sessionTtlMs: number;
  loginWindowMs: number;
  loginMax: number;
}

/** v1.1: credential persistence configuration. */
export interface CredentialStoreConfig {
  backend: "auto" | "file" | "redis";
  redisUrl?: string;
  filePath: string;
  /** Resolved key material (base64 or passphrase). Never log. */
  encryptionKey?: string;
}

/** v1.1: OAuth (browser connect) configuration. */
export interface OAuthConfig {
  /** Public base URL for the callback; derived from the request host when unset. */
  redirectBaseUrl?: string;
  scopes: string[];
  authEndpoint?: string;
  tokenEndpoint?: string;
}

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
  /** v1.1 additions (see architecture contract §14). */
  admin: AdminConfig;
  credentials: CredentialStoreConfig;
  oauth: OAuthConfig;
}

/** v1.1: default OAuth scopes (UNVERIFIED — may need adjustment per Google account). */
export const DEFAULT_OAUTH_SCOPES: string[] = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
];

export const GOOGLE_OAUTH_AUTH_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

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
