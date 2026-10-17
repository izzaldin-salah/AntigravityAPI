import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadConfig,
  loadConfigWithDiagnostics,
} from "../../src/config/env";
import { DEFAULT_DEV_API_KEY } from "../../src/types/config";

describe("Environment Configuration (tests/config/env.test.ts)", () => {
  it("production without API_KEYS -> loadConfig throws ConfigError", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        API_KEYS: "",
      }),
    ).toThrowError(ConfigError);

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
      }),
    ).toThrowError(/API_KEYS: REQUIRED in production/);
  });

  it("production with valid API_KEYS -> loads configuration successfully", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      API_KEYS: "prod-key-1, prod-key-2",
    });

    expect(config.nodeEnv).toBe("production");
    expect(config.apiKeys).toEqual(["prod-key-1", "prod-key-2"]);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3000);
  });

  it("dev implicit dev-local-key + warning via loadConfigWithDiagnostics", () => {
    const { config, warnings } = loadConfigWithDiagnostics({
      NODE_ENV: "development",
      API_KEYS: "",
    });

    expect(config.nodeEnv).toBe("development");
    expect(config.apiKeys).toEqual([DEFAULT_DEV_API_KEY]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain(DEFAULT_DEV_API_KEY);
  });

  it("dev with explicit API_KEYS -> loads keys with no warning", () => {
    const { config, warnings } = loadConfigWithDiagnostics({
      NODE_ENV: "development",
      API_KEYS: "custom-dev-key",
    });

    expect(config.apiKeys).toEqual(["custom-dev-key"]);
    expect(warnings).toHaveLength(0);
  });

  it("invalid PORT numbers -> throws ConfigError", () => {
    expect(() =>
      loadConfig({
        PORT: "not-a-number",
      }),
    ).toThrowError(ConfigError);

    expect(() =>
      loadConfig({
        PORT: "-1",
      }),
    ).toThrowError(/PORT must be an integer between 1 and 65535/);

    expect(() =>
      loadConfig({
        PORT: "70000",
      }),
    ).toThrowError(/PORT must be an integer between 1 and 65535/);
  });

  it("invalid RATE_LIMIT numbers -> throws ConfigError", () => {
    expect(() =>
      loadConfig({
        RATE_LIMIT_MAX: "-5",
      }),
    ).toThrowError(ConfigError);

    expect(() =>
      loadConfig({
        RATE_LIMIT_WINDOW_MS: "0",
      }),
    ).toThrowError(ConfigError);

    expect(() =>
      loadConfig({
        RATE_LIMIT_WINDOW_MS: "invalid",
      }),
    ).toThrowError(ConfigError);
  });

  it("invalid NODE_ENV -> throws ConfigError with aggregated issues", () => {
    try {
      loadConfig({
        NODE_ENV: "staging" as unknown as string,
        PORT: "bad-port",
      });
      expect.unreachable("Should have thrown ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const confErr = err as ConfigError;
      expect(confErr.issues.length).toBeGreaterThanOrEqual(2);
      expect(confErr.message).toContain("NODE_ENV");
      expect(confErr.message).toContain("PORT");
    }
  });

  it("CORS_ORIGINS parsing -> wildcard or origin list", () => {
    const wildcard = loadConfig({ CORS_ORIGINS: "*" });
    expect(wildcard.corsOrigins).toBe("*");

    const custom = loadConfig({
      CORS_ORIGINS: "http://localhost:3000, https://app.example.com",
    });
    expect(custom.corsOrigins).toEqual([
      "http://localhost:3000",
      "https://app.example.com",
    ]);

    const empty = loadConfig({ CORS_ORIGINS: "" });
    expect(empty.corsOrigins).toBe("*");
  });

  it("TRUST_PROXY parsing -> boolean", () => {
    expect(loadConfig({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: "1" }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(loadConfig({}).trustProxy).toBe(false);
  });

  it("defaults to Antigravity and rejects the removed mock mode", () => {
    expect(loadConfig({}).provider.mode).toBe("antigravity");
    expect(() => loadConfig({ PROVIDER_MODE: "mock" })).toThrowError(ConfigError);
  });

  it("loads Antigravity credentials", () => {
    const ag = loadConfig({
      PROVIDER_MODE: "antigravity",
      ANTIGRAVITY_REFRESH_TOKEN: "refresh-xyz",
      ANTIGRAVITY_CLIENT_ID: "client-id",
    });
    expect(ag.provider.mode).toBe("antigravity");
    if (ag.provider.mode === "antigravity") {
      expect(ag.provider.credentials.refreshToken).toBe("refresh-xyz");
      expect(ag.provider.credentials.clientId).toBe("client-id");
      expect(ag.provider.credentials.tokenStorePath).toBe("./.data/antigravity-token.json");
    }
  });

  // ---- v1.1 dashboard fail-closed tests (docs/architecture-contract.md §14, §16) ----

  it("DASHBOARD_ENABLED=true without password -> throws ConfigError", () => {
    expect(() =>
      loadConfig({
        DASHBOARD_ENABLED: "true",
      }),
    ).toThrowError(/DASHBOARD_ENABLED=true requires ADMIN_PASSWORD or ADMIN_PASSWORD_HASH/);
  });

  it("dashboard enabled (auto + password) without CREDENTIAL_ENCRYPTION_KEY -> throws ConfigError", () => {
    expect(() =>
      loadConfig({
        ADMIN_PASSWORD: "plain-secret-password",
      }),
    ).toThrowError(/CREDENTIAL_ENCRYPTION_KEY is REQUIRED when the admin dashboard is enabled/);

    expect(() =>
      loadConfig({
        DASHBOARD_ENABLED: "true",
        ADMIN_PASSWORD: "plain-secret-password",
      }),
    ).toThrowError(/CREDENTIAL_ENCRYPTION_KEY is REQUIRED when the admin dashboard is enabled/);
  });

  it("ADMIN_PASSWORD_HASH not starting with scrypt$ -> throws ConfigError", () => {
    expect(() =>
      loadConfig({
        ADMIN_PASSWORD_HASH: "bcrypt$12$invalid",
      }),
    ).toThrowError(/ADMIN_PASSWORD_HASH: expected format 'scrypt\$N\$r\$p\$<saltB64>\$<hashB64>'/);
  });

  it("CREDENTIAL_STORE=redis without REDIS_URL -> throws ConfigError", () => {
    expect(() =>
      loadConfig({
        CREDENTIAL_STORE: "redis",
      }),
    ).toThrowError(/CREDENTIAL_STORE=redis requires REDIS_URL/);
  });

  it("DASHBOARD_ENABLED=false with password stays disabled without requiring CREDENTIAL_ENCRYPTION_KEY", () => {
    const config = loadConfig({
      DASHBOARD_ENABLED: "false",
      ADMIN_PASSWORD: "dev-password-here",
    });

    expect(config.admin.enabled).toBe(false);
    expect(config.admin.password).toBe("dev-password-here");
  });

  it("dashboard enabled with valid password and encryption key loads correctly", () => {
    const config = loadConfig({
      DASHBOARD_ENABLED: "auto",
      ADMIN_PASSWORD_HASH: "scrypt$16384$8$1$saltb64$hashb64",
      CREDENTIAL_ENCRYPTION_KEY: "my-valid-base64-or-passphrase-key",
      CREDENTIAL_STORE: "file",
    });

    expect(config.admin.enabled).toBe(true);
    expect(config.admin.passwordHash).toBe("scrypt$16384$8$1$saltb64$hashb64");
    expect(config.credentials.backend).toBe("file");
    expect(config.credentials.encryptionKey).toBe("my-valid-base64-or-passphrase-key");
  });
});
