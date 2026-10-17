/**
 * Environment configuration loader and validator.
 * Owner: antigravity-deployment-agent.
 * Frozen contract: docs/architecture-contract.md (§6).
 */
import { z } from "zod";
import { DEFAULT_DEV_API_KEY, DEFAULT_OAUTH_SCOPES } from "../types/config";
import type {
  AntigravityCredentials,
  AppConfig,
  NodeEnv,
  ProviderConfig,
  RateLimitConfig,
} from "../types/config";

export class ConfigError extends Error {
  public readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"], {
      message: "NODE_ENV must be one of: 'development', 'production', 'test'",
    })
    .default("development"),

  HOST: z
    .string()
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val.trim() : "0.0.0.0")),

  PORT: z
    .string()
    .or(z.number())
    .optional()
    .transform((val, ctx) => {
      if (val === undefined || val === null || val === "") {
        return 3000;
      }
      const num = typeof val === "number" ? val : Number(String(val).trim());
      if (!Number.isInteger(num) || num < 1 || num > 65535) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `PORT must be an integer between 1 and 65535, received "${val}"`,
        });
        return z.NEVER;
      }
      return num;
    }),

  LOG_LEVEL: z
    .string()
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val.trim() : "info")),

  API_KEYS: z.string().optional(),

  RATE_LIMIT_WINDOW_MS: z
    .string()
    .or(z.number())
    .optional()
    .transform((val, ctx) => {
      if (val === undefined || val === null || val === "") {
        return 60000;
      }
      const num = typeof val === "number" ? val : Number(String(val).trim());
      if (!Number.isInteger(num) || num <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `RATE_LIMIT_WINDOW_MS must be a positive integer, received "${val}"`,
        });
        return z.NEVER;
      }
      return num;
    }),

  RATE_LIMIT_MAX: z
    .string()
    .or(z.number())
    .optional()
    .transform((val, ctx) => {
      if (val === undefined || val === null || val === "") {
        return 60;
      }
      const num = typeof val === "number" ? val : Number(String(val).trim());
      if (!Number.isInteger(num) || num < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `RATE_LIMIT_MAX must be a non-negative integer (0 disables), received "${val}"`,
        });
        return z.NEVER;
      }
      return num;
    }),

  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((val) => (val !== undefined ? val.trim() : "*")),

  TRUST_PROXY: z
    .string()
    .or(z.boolean())
    .optional()
    .transform((val) => {
      if (typeof val === "boolean") return val;
      if (val === undefined || val === null) return false;
      const lower = String(val).trim().toLowerCase();
      return lower === "true" || lower === "1";
    }),

  PROVIDER_MODE: z
    .enum(["antigravity"], {
      message: "PROVIDER_MODE must be 'antigravity'",
    })
    .default("antigravity"),

  ANTIGRAVITY_ACCESS_TOKEN: z.string().optional(),
  ANTIGRAVITY_REFRESH_TOKEN: z.string().optional(),
  ANTIGRAVITY_CLIENT_ID: z.string().optional(),
  ANTIGRAVITY_CLIENT_SECRET: z.string().optional(),
  ANTIGRAVITY_PROJECT_ID: z.string().optional(),
  ANTIGRAVITY_ENDPOINT: z.string().optional(),
  ANTIGRAVITY_TOKEN_STORE_PATH: z
    .string()
    .optional()
    .transform((val) =>
      val && val.trim().length > 0 ? val.trim() : "./.data/antigravity-token.json",
    ),

  // ---- v1.1 account dashboard (see architecture contract §14) ----

  DASHBOARD_ENABLED: z
    .enum(["auto", "true", "false"], {
      message: "DASHBOARD_ENABLED must be 'auto', 'true' or 'false'",
    })
    .default("auto"),

  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_PASSWORD_HASH: z.string().optional(),

  ADMIN_SESSION_TTL_MS: z
    .string()
    .or(z.number())
    .optional()
    .transform((val, ctx) => {
      if (val === undefined || val === null || val === "") return 43200000;
      const num = typeof val === "number" ? val : Number(String(val).trim());
      if (!Number.isInteger(num) || num <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ADMIN_SESSION_TTL_MS must be a positive integer, received "${val}"`,
        });
        return z.NEVER;
      }
      return num;
    }),

  ADMIN_LOGIN_WINDOW_MS: z
    .string()
    .or(z.number())
    .optional()
    .transform((val, ctx) => {
      if (val === undefined || val === null || val === "") return 300000;
      const num = typeof val === "number" ? val : Number(String(val).trim());
      if (!Number.isInteger(num) || num <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ADMIN_LOGIN_WINDOW_MS must be a positive integer, received "${val}"`,
        });
        return z.NEVER;
      }
      return num;
    }),

  ADMIN_LOGIN_MAX: z
    .string()
    .or(z.number())
    .optional()
    .transform((val, ctx) => {
      if (val === undefined || val === null || val === "") return 5;
      const num = typeof val === "number" ? val : Number(String(val).trim());
      if (!Number.isInteger(num) || num < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ADMIN_LOGIN_MAX must be a non-negative integer (0 disables the login gate), received "${val}"`,
        });
        return z.NEVER;
      }
      return num;
    }),

  CREDENTIAL_STORE: z
    .enum(["auto", "file", "redis"], {
      message: "CREDENTIAL_STORE must be 'auto', 'file' or 'redis'",
    })
    .default("auto"),

  REDIS_URL: z.string().optional(),

  CREDENTIAL_FILE_PATH: z
    .string()
    .optional()
    .transform((val) =>
      val && val.trim().length > 0 ? val.trim() : "./.data/credential-store.json",
    ),

  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),

  OAUTH_REDIRECT_BASE_URL: z.string().optional(),

  ANTIGRAVITY_OAUTH_SCOPES: z.string().optional(),

  ANTIGRAVITY_OAUTH_AUTH_ENDPOINT: z.string().optional(),

  ANTIGRAVITY_OAUTH_TOKEN_ENDPOINT: z.string().optional(),
});

function pickAntigravity(env: z.infer<typeof envSchema>): AntigravityCredentials {
  return {
    accessToken: env.ANTIGRAVITY_ACCESS_TOKEN?.trim() || undefined,
    refreshToken: env.ANTIGRAVITY_REFRESH_TOKEN?.trim() || undefined,
    clientId: env.ANTIGRAVITY_CLIENT_ID?.trim() || undefined,
    clientSecret: env.ANTIGRAVITY_CLIENT_SECRET?.trim() || undefined,
    projectId: env.ANTIGRAVITY_PROJECT_ID?.trim() || undefined,
    endpoint: env.ANTIGRAVITY_ENDPOINT?.trim() || undefined,
    tokenStorePath: env.ANTIGRAVITY_TOKEN_STORE_PATH,
  };
}

export interface ConfigDiagnostics {
  config: AppConfig;
  warnings: string[];
}

/**
 * Loads and validates application configuration from an environment map.
 * Returns both the validated AppConfig and any operational warnings.
 */
export function loadConfigWithDiagnostics(
  rawEnv: NodeJS.ProcessEnv = process.env,
): ConfigDiagnostics {
  const result = envSchema.safeParse(rawEnv);
  const issues: string[] = [];

  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path.join(".") || "env";
      issues.push(`${field}: ${issue.message}`);
    }
  }

  const parsed = result.success ? result.data : null;
  const warnings: string[] = [];

  const nodeEnv: NodeEnv = parsed ? (parsed.NODE_ENV as NodeEnv) : "development";
  const rawApiKeys = parsed?.API_KEYS ?? rawEnv.API_KEYS ?? "";
  const parsedApiKeys = rawApiKeys
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (nodeEnv === "production") {
    if (parsedApiKeys.length === 0) {
      issues.push("API_KEYS: REQUIRED in production (cannot be empty or unset). Refusing to start.");
    }
  }

  // ---- v1.1 dashboard fail-closed rules ----
  const adminPasswordRaw = parsed?.ADMIN_PASSWORD?.trim() || undefined;
  const adminPasswordHashRaw = parsed?.ADMIN_PASSWORD_HASH?.trim() || undefined;
  const encryptionKeyRaw = parsed?.CREDENTIAL_ENCRYPTION_KEY?.trim() || undefined;
  const dashboardEnabledExplicit = parsed?.DASHBOARD_ENABLED;
  const hasAdminSecret = Boolean(adminPasswordRaw || adminPasswordHashRaw);
  const dashboardEnabled =
    dashboardEnabledExplicit === "true"
      ? true
      : dashboardEnabledExplicit === "false"
        ? false
        : hasAdminSecret;

  if (adminPasswordHashRaw && !adminPasswordHashRaw.startsWith("scrypt$")) {
    issues.push(
      "ADMIN_PASSWORD_HASH: expected format 'scrypt$N$r$p$<saltB64>$<hashB64>' (generate with: node scripts/hash-admin-password.mjs)",
    );
  }
  if (dashboardEnabledExplicit === "true" && !hasAdminSecret) {
    issues.push("DASHBOARD_ENABLED=true requires ADMIN_PASSWORD or ADMIN_PASSWORD_HASH.");
  }
  if (dashboardEnabled && !encryptionKeyRaw) {
    issues.push(
      "CREDENTIAL_ENCRYPTION_KEY is REQUIRED when the admin dashboard is enabled (fail closed). Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  if (parsed?.CREDENTIAL_STORE === "redis" && !parsed.REDIS_URL?.trim()) {
    issues.push("CREDENTIAL_STORE=redis requires REDIS_URL.");
  }

  if (issues.length > 0) {
    throw new ConfigError(
      `Invalid environment configuration:\n  - ${issues.join("\n  - ")}`,
      issues,
    );
  }

  // Safe to assert non-null after check
  const validated = parsed!;

  let finalApiKeys = parsedApiKeys;
  if (finalApiKeys.length === 0) {
    finalApiKeys = [DEFAULT_DEV_API_KEY];
    warnings.push(
      `API_KEYS is unset or empty. Defaulting to development key: "${DEFAULT_DEV_API_KEY}". Set API_KEYS before running in production.`,
    );
  }

  const corsOrigins: string[] | "*" =
    !validated.CORS_ORIGINS || validated.CORS_ORIGINS === "*"
      ? "*"
      : (() => {
          const list = validated.CORS_ORIGINS.split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          return list.length > 0 ? list : "*";
        })();

  const rateLimit: RateLimitConfig = {
    windowMs: validated.RATE_LIMIT_WINDOW_MS,
    max: validated.RATE_LIMIT_MAX,
  };

  const provider: ProviderConfig = {
    mode: "antigravity",
    credentials: pickAntigravity(validated),
  };

  const scopesRaw = validated.ANTIGRAVITY_OAUTH_SCOPES?.trim();
  const oauthScopes = scopesRaw
    ? scopesRaw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_OAUTH_SCOPES];

  const config: AppConfig = {
    nodeEnv,
    host: validated.HOST,
    port: validated.PORT,
    logLevel: validated.LOG_LEVEL,
    apiKeys: finalApiKeys,
    rateLimit,
    corsOrigins,
    trustProxy: validated.TRUST_PROXY,
    provider,
    admin: {
      enabled: dashboardEnabled,
      password: adminPasswordRaw,
      passwordHash: adminPasswordHashRaw,
      sessionTtlMs: validated.ADMIN_SESSION_TTL_MS,
      loginWindowMs: validated.ADMIN_LOGIN_WINDOW_MS,
      loginMax: validated.ADMIN_LOGIN_MAX,
    },
    credentials: {
      backend: validated.CREDENTIAL_STORE,
      redisUrl: validated.REDIS_URL?.trim() || undefined,
      filePath: validated.CREDENTIAL_FILE_PATH,
      encryptionKey: encryptionKeyRaw,
    },
    oauth: {
      redirectBaseUrl: validated.OAUTH_REDIRECT_BASE_URL?.trim() || undefined,
      scopes: oauthScopes,
      authEndpoint: validated.ANTIGRAVITY_OAUTH_AUTH_ENDPOINT?.trim() || undefined,
      tokenEndpoint: validated.ANTIGRAVITY_OAUTH_TOKEN_ENDPOINT?.trim() || undefined,
    },
  };

  return { config, warnings };
}

/**
 * Convenience wrapper returning AppConfig directly, preserving frozen signature.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return loadConfigWithDiagnostics(env).config;
}
