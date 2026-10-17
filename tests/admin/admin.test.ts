import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { MockTestProvider as TestProvider } from "../api/mock-provider";
import { createCredentialStore } from "../../src/security/credential-store";
import { createSessionStore } from "../../src/security/session-store";
import type {
  AntigravityAccountStatus,
  OAuthService,
  OAuthTokenResult,
} from "../../src/types/admin";
import type { AppConfig } from "../../src/types/config";
import type { AIProvider } from "../../src/types/provider";

class FakeOAuthService implements OAuthService {
  configured = true;
  lastExchangeCodeInput?: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  };
  lastTestRefreshInput?: {
    refreshToken: string;
    clientId?: string;
    clientSecret?: string;
  };
  exchangeResult: OAuthTokenResult = {
    refreshToken: "fake-refresh-token",
    accountHint: "user@example.com",
    projectId: "demo-project",
  };
  refreshResult: OAuthTokenResult = {
    refreshToken: "refreshed-token",
    accountHint: "refreshed@example.com",
  };
  failRefresh = false;
  failRefreshEchoSentinel = false;
  failExchange = false;

  isConfigured(): boolean {
    return this.configured;
  }

  buildAuthorizeUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=fake-client&state=${input.state}&code_challenge=${input.codeChallenge}&redirect_uri=${encodeURIComponent(input.redirectUri)}`;
  }

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthTokenResult> {
    this.lastExchangeCodeInput = input;
    if (this.failExchange) {
      throw new Error("Google rejected code exchange");
    }
    return this.exchangeResult;
  }

  async testRefresh(input: {
    refreshToken: string;
    clientId?: string;
    clientSecret?: string;
  }): Promise<OAuthTokenResult> {
    this.lastTestRefreshInput = input;
    if (this.failRefresh) {
      if (this.failRefreshEchoSentinel) {
        throw new Error(`Upstream rejected refresh: ${input.refreshToken}`);
      }
      throw new Error("invalid_grant: Token has been expired or revoked.");
    }
    return this.refreshResult;
  }
}

function createTestConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3000,
    logLevel: "silent",
    apiKeys: ["test-api-key"],
    rateLimit: {
      windowMs: 60000,
      max: 60,
    },
    corsOrigins: "*",
    trustProxy: false,
    provider: {
      mode: "antigravity", credentials: {},
    },
    admin: {
      enabled: true,
      password: "admin-secret-password",
      sessionTtlMs: 3600000,
      loginWindowMs: 300000,
      loginMax: 3,
    },
    credentials: {
      backend: "file",
      // Unique temp path per test config: the real store persists to disk,
      // so a shared path would leak credentials across tests.
      filePath: join(tmpdir(), "agapi-admin-tests", `cred-${randomUUID()}.json`),
      encryptionKey: "test-encryption-key-for-credentials",
    },
    oauth: {
      scopes: ["openid", "email"],
      authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
    },
    ...overrides,
  };
}

describe("Admin Dashboard & Routes", () => {
  it("disabled-mode page: returns static not configured page when admin.enabled is false", async () => {
    const config = createTestConfig({
      admin: {
        enabled: false,
        sessionTtlMs: 3600000,
        loginWindowMs: 300000,
        loginMax: 5,
      },
    });
    const app = await buildApp({
      config,
      provider: new TestProvider(),
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Account Dashboard Not Configured");

    // Other admin endpoints should not be mounted
    const dashRes = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
    });
    expect(dashRes.statusCode).toBe(404);
  });

  it("login ok: logs in with correct password, creates session, sets cookie and redirects", async () => {
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "password=admin-secret-password",
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin/dashboard");
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("admin_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=3600");
  });

  it("login with scrypt hash: verifies scrypt$N$r$p$saltB64$hashB64 successfully", async () => {
    // Generate valid scrypt hash
    const { randomBytes, scryptSync } = await import("node:crypto");
    const salt = randomBytes(16);
    const hash = scryptSync("scrypt-secret", salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 256 * 16384 * 8,
    });
    const hashString = `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;

    const config = createTestConfig({
      admin: {
        enabled: true,
        passwordHash: hashString,
        sessionTtlMs: 3600000,
        loginWindowMs: 300000,
        loginMax: 5,
      },
    });
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "password=scrypt-secret",
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin/dashboard");
  });

  it("login wrong password: returns 401 and does not create session", async () => {
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      payload: "password=wrong-password",
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
    const body = res.json();
    expect(body.error.message).toBe("Invalid password");
  });

  it("login rate limit: returns 429 and Retry-After header after loginMax attempts", async () => {
    const config = createTestConfig({
      admin: {
        enabled: true,
        password: "secret",
        sessionTtlMs: 3600000,
        loginWindowMs: 300000,
        loginMax: 2, // limit to 2
      },
    });
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    // Attempt 1
    const res1 = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "password=wrong",
    });
    expect(res1.statusCode).toBe(401);

    // Attempt 2
    const res2 = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "password=wrong",
    });
    expect(res2.statusCode).toBe(401);

    // Attempt 3: should be rate-limited
    const res3 = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      payload: "password=wrong",
    });
    expect(res3.statusCode).toBe(429);
    expect(res3.headers["retry-after"]).toBeDefined();
    expect(Number(res3.headers["retry-after"])).toBeGreaterThan(0);
    expect(res3.json().error.code).toBe("rate_limit_exceeded");
  });

  it("cookie attributes: sets Secure iff protocol is https", async () => {
    const config = createTestConfig({ trustProxy: true });
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const resHttps = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-proto": "https",
      },
      payload: "password=admin-secret-password",
    });

    expect(resHttps.statusCode).toBe(302);
    expect(resHttps.headers["set-cookie"]).toContain("Secure");

    const resHttp = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-proto": "http",
      },
      payload: "password=admin-secret-password",
    });

    expect(resHttp.statusCode).toBe(302);
    expect(resHttp.headers["set-cookie"]).not.toContain("Secure");
  });

  it("CSRF 403: rejects state-changing POST requests when CSRF token is missing or invalid", async () => {
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const session = await sessionStore.create(config.admin.sessionTtlMs);
    const cookieHeader = `admin_session=${session.id}`;

    const endpoints = [
      { method: "POST" as const, url: "/admin/actions/connect" },
      {
        method: "POST" as const,
        url: "/admin/actions/manual-credentials",
        payload: { refreshToken: "test" },
      },
      { method: "POST" as const, url: "/admin/actions/reconnect" },
      { method: "POST" as const, url: "/admin/actions/disconnect" },
      { method: "POST" as const, url: "/admin/logout" },
    ];

    for (const ep of endpoints) {
      // 1. Missing CSRF token
      const resMissing = await app.inject({
        method: ep.method,
        url: ep.url,
        headers: {
          cookie: cookieHeader,
          accept: "application/json",
          ...(ep.payload ? { "content-type": "application/json" } : {}),
        },
        payload: ep.payload,
      });
      expect(
        resMissing.statusCode,
        `Expected 403 on missing CSRF for ${ep.url}`,
      ).toBe(403);

      // 2. Wrong CSRF token
      const resWrong = await app.inject({
        method: ep.method,
        url: ep.url,
        headers: {
          cookie: cookieHeader,
          "x-csrf-token": "wrong-csrf-token",
          accept: "application/json",
          ...(ep.payload ? { "content-type": "application/json" } : {}),
        },
        payload: ep.payload,
      });
      expect(
        resWrong.statusCode,
        `Expected 403 on wrong CSRF for ${ep.url}`,
      ).toBe(403);
    }
  });

  it("SENTINEL test: refreshToken never leaks in bodies or headers of ANY admin response", async () => {
    const SENTINEL = "SENTINEL_TOKEN_DO_NOT_LEAK";
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();
    oauthService.failRefresh = true;
    oauthService.failRefreshEchoSentinel = true;

    // Pre-save the sentinel token in the credential store
    await credentialStore.save({
      refreshToken: SENTINEL,
      accountHint: "sentinel-user@example.com",
      updatedAt: Date.now(),
    });

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const session = await sessionStore.create(config.admin.sessionTtlMs);
    const cookieHeader = `admin_session=${session.id}`;

    // 1. GET /admin/dashboard HTML
    const dashRes = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { cookie: cookieHeader },
    });
    expect(dashRes.body).not.toContain(SENTINEL);
    expect(JSON.stringify(dashRes.headers)).not.toContain(SENTINEL);

    // 2. GET /admin/api/status JSON
    const statusRes = await app.inject({
      method: "GET",
      url: "/admin/api/status",
      headers: { cookie: cookieHeader },
    });
    expect(statusRes.body).not.toContain(SENTINEL);
    expect(JSON.stringify(statusRes.headers)).not.toContain(SENTINEL);

    // 3. POST /admin/actions/manual-credentials error response
    const manualFailRes = await app.inject({
      method: "POST",
      url: "/admin/actions/manual-credentials",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
      payload: {
        refreshToken: SENTINEL,
      },
    });
    expect(manualFailRes.body).not.toContain(SENTINEL);
    expect(JSON.stringify(manualFailRes.headers)).not.toContain(SENTINEL);

    // 4. POST /admin/actions/reconnect error response
    const reconnectRes = await app.inject({
      method: "POST",
      url: "/admin/actions/reconnect",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
    });
    expect(reconnectRes.body).not.toContain(SENTINEL);
    expect(JSON.stringify(reconnectRes.headers)).not.toContain(SENTINEL);
  });

  it("status JSON whitelist & synthesized status when getAccountStatus is absent", async () => {
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    // TestProvider does not implement getAccountStatus
    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const session = await sessionStore.create(config.admin.sessionTtlMs);

    const res = await app.inject({
      method: "GET",
      url: "/admin/api/status",
      headers: { cookie: `admin_session=${session.id}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.providerMode).toBe("antigravity");
    expect(body.provider).toEqual({
      providerMode: "antigravity",
      connected: false,
      hasRefreshToken: false,
      needsReconnect: false,
    });
    expect(body.credentials.backend).toBe("file");
    expect(body.credentials.ok).toBe(true);
    expect(body.oauth.configured).toBe(true);
    expect(body.oauth.redirectUri).toBe(
      "http://localhost:80/admin/oauth/callback",
    );
  });

  it("status JSON returns actual provider getAccountStatus when present", async () => {
    const config = createTestConfig({ provider: { mode: "antigravity", credentials: {} } });
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const customStatus: AntigravityAccountStatus = {
      providerMode: "antigravity",
      connected: true,
      hasRefreshToken: true,
      needsReconnect: false,
      accountHint: "custom@example.com",
      accessTokenExpiresAt: Date.now() + 3600000,
    };

    const mock = new TestProvider();
    const providerWithStatus: AIProvider = {
      id: mock.id,
      listModels: () => mock.listModels(),
      chat: (req) => mock.chat(req),
      getUsage: () => mock.getUsage(),
      healthCheck: () => mock.healthCheck(),
      async getAccountStatus(): Promise<AntigravityAccountStatus> {
        return customStatus;
      },
    };

    const app = await buildApp({
      config,
      provider: providerWithStatus,
      admin: { sessionStore, credentialStore, oauthService },
    });

    const session = await sessionStore.create(config.admin.sessionTtlMs);

    const res = await app.inject({
      method: "GET",
      url: "/admin/api/status",
      headers: { cookie: `admin_session=${session.id}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider.connected).toBe(true);
    expect(body.provider.accountHint).toBe("custom@example.com");
  });

  it("connect not-configured vs configured", async () => {
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const session = await sessionStore.create(config.admin.sessionTtlMs);
    const cookieHeader = `admin_session=${session.id}`;

    // 1. Not configured case
    oauthService.configured = false;
    const resNotConfiguredJson = await app.inject({
      method: "POST",
      url: "/admin/actions/connect",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
    });
    expect(resNotConfiguredJson.statusCode).toBe(400);
    const notConfiguredBody = resNotConfiguredJson.json();
    expect(notConfiguredBody.error.message).toContain("ANTIGRAVITY_CLIENT_ID");
    expect(notConfiguredBody.error.message).toContain("manual");

    // Form version
    const resNotConfiguredHtml = await app.inject({
      method: "POST",
      url: "/admin/actions/connect",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
      },
    });
    expect(resNotConfiguredHtml.statusCode).toBe(400);
    expect(resNotConfiguredHtml.body).toContain("ANTIGRAVITY_CLIENT_ID");

    // 2. Configured case
    oauthService.configured = true;
    const resConfiguredJson = await app.inject({
      method: "POST",
      url: "/admin/actions/connect",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
    });
    expect(resConfiguredJson.statusCode).toBe(200);
    const configuredBody = resConfiguredJson.json();
    expect(configuredBody.authorizeUrl).toBeDefined();
    expect(configuredBody.authorizeUrl).toContain("state=");
    expect(configuredBody.authorizeUrl).toContain("code_challenge=");

    // Form redirect version
    const resConfiguredForm = await app.inject({
      method: "POST",
      url: "/admin/actions/connect",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
      },
    });
    expect(resConfiguredForm.statusCode).toBe(302);
    expect(resConfiguredForm.headers.location).toContain("accounts.google.com");
  });

  it("callback: handles bad state, expired state, single-use, google error and happy path", async () => {
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const session = await sessionStore.create(config.admin.sessionTtlMs);
    const cookieHeader = `admin_session=${session.id}`;

    // 1. Missing state
    const resNoState = await app.inject({
      method: "GET",
      url: "/admin/oauth/callback?code=abc",
      headers: { cookie: cookieHeader, accept: "application/json" },
    });
    expect(resNoState.statusCode).toBe(400);

    // 2. Bad/unknown state
    const resBadState = await app.inject({
      method: "GET",
      url: "/admin/oauth/callback?code=abc&state=unknown-state-key",
      headers: { cookie: cookieHeader, accept: "application/json" },
    });
    expect(resBadState.statusCode).toBe(400);
    expect(resBadState.json().error.code).toBe("invalid_oauth_state");

    // Start a real connect flow to generate a valid state
    const connectRes = await app.inject({
      method: "POST",
      url: "/admin/actions/connect",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
    });
    const authUrl = new URL(connectRes.json().authorizeUrl);
    const validState = authUrl.searchParams.get("state")!;
    expect(validState).toBeDefined();

    // 3. Google error param with valid state
    const resGoogleError = await app.inject({
      method: "GET",
      url: `/admin/oauth/callback?state=${validState}&error=access_denied&error_description=User+declined`,
      headers: { cookie: cookieHeader, accept: "application/json" },
    });
    expect(resGoogleError.statusCode).toBe(400);
    expect(resGoogleError.json().error.message).toContain("access_denied");
    expect(resGoogleError.json().error.message).toContain("User declined");

    // 4. Single-use check: state was consumed by the previous call! Reusing it fails.
    const resReuseState = await app.inject({
      method: "GET",
      url: `/admin/oauth/callback?state=${validState}&code=valid-code`,
      headers: { cookie: cookieHeader, accept: "application/json" },
    });
    expect(resReuseState.statusCode).toBe(400);
    expect(resReuseState.json().error.code).toBe("invalid_oauth_state");

    // 5. Happy path with fresh state
    const connectRes2 = await app.inject({
      method: "POST",
      url: "/admin/actions/connect",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
    });
    const validState2 = new URL(connectRes2.json().authorizeUrl).searchParams.get(
      "state",
    )!;

    const resHappy = await app.inject({
      method: "GET",
      url: `/admin/oauth/callback?state=${validState2}&code=google-auth-code`,
      headers: { cookie: cookieHeader },
    });

    expect(resHappy.statusCode).toBe(302);
    expect(resHappy.headers.location).toBe("/admin/dashboard");

    // Credential store should now contain the exchanged tokens
    const saved = await credentialStore.load();
    expect(saved).not.toBeNull();
    expect(saved?.refreshToken).toBe("fake-refresh-token");
    expect(saved?.accountHint).toBe("user@example.com");

    // Dashboard flash should show "Account connected"
    const dashRes = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { cookie: cookieHeader },
    });
    expect(dashRes.body).toContain("Account connected");
  });

  it("manual-credentials: failure does not touch store; success updates store", async () => {
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const session = await sessionStore.create(config.admin.sessionTtlMs);
    const cookieHeader = `admin_session=${session.id}`;

    // 1. Missing refreshToken -> 400
    const resMissing = await app.inject({
      method: "POST",
      url: "/admin/actions/manual-credentials",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
      payload: {},
    });
    expect(resMissing.statusCode).toBe(400);

    // 2. Validation failure -> 400, store untouched
    oauthService.failRefresh = true;
    const resFail = await app.inject({
      method: "POST",
      url: "/admin/actions/manual-credentials",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
      payload: { refreshToken: "bad-token" },
    });
    expect(resFail.statusCode).toBe(400);
    expect(resFail.json().error.code).toBe("invalid_credentials");
    expect(await credentialStore.load()).toBeNull();

    // 3. Validation success -> 302/200, store saved
    oauthService.failRefresh = false;
    const resSuccess = await app.inject({
      method: "POST",
      url: "/admin/actions/manual-credentials",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
      payload: {
        refreshToken: "good-token",
        clientId: "my-client",
        projectId: "my-project",
      },
    });
    expect(resSuccess.statusCode).toBe(200);

    const saved = await credentialStore.load();
    expect(saved).not.toBeNull();
    expect(saved?.refreshToken).toBe("good-token");
    expect(saved?.clientId).toBe("my-client");
    expect(saved?.projectId).toBe("my-project");
  });

  it("reconnect: without creds returns 400; with creds reports result", async () => {
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const session = await sessionStore.create(config.admin.sessionTtlMs);
    const cookieHeader = `admin_session=${session.id}`;

    // 1. Without credentials -> 400
    const resEmpty = await app.inject({
      method: "POST",
      url: "/admin/actions/reconnect",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
    });
    expect(resEmpty.statusCode).toBe(400);
    expect(resEmpty.json().error.message).toBe("No credentials stored");

    // Save initial credentials
    await credentialStore.save({
      refreshToken: "saved-token",
      accountHint: "initial@example.com",
      updatedAt: Date.now(),
    });

    // 2. Reconnect success
    const resSuccess = await app.inject({
      method: "POST",
      url: "/admin/actions/reconnect",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
    });
    expect(resSuccess.statusCode).toBe(200);
    expect(resSuccess.json().ok).toBe(true);
    expect(resSuccess.json().message).toContain("lazily on the next chat request");

    // 3. Reconnect failure reports failure without crashing
    oauthService.failRefresh = true;
    const resFail = await app.inject({
      method: "POST",
      url: "/admin/actions/reconnect",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
    });
    expect(resFail.statusCode).toBe(200);
    expect(resFail.json().ok).toBe(false);
    expect(resFail.json().error).toContain("expired or revoked");
  });

  it("disconnect: clears credential store and flashes message", async () => {
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    await credentialStore.save({
      refreshToken: "to-delete",
      updatedAt: Date.now(),
    });

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const session = await sessionStore.create(config.admin.sessionTtlMs);
    const cookieHeader = `admin_session=${session.id}`;

    const res = await app.inject({
      method: "POST",
      url: "/admin/actions/disconnect",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
      },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin/dashboard");
    expect(await credentialStore.load()).toBeNull();

    // Check flash message on dashboard
    const dashRes = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { cookie: cookieHeader },
    });
    expect(dashRes.body).toContain("Account disconnected");
  });

  it("logout: destroys session, clears cookie and redirects to /admin", async () => {
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const session = await sessionStore.create(config.admin.sessionTtlMs);
    const cookieHeader = `admin_session=${session.id}`;

    const res = await app.inject({
      method: "POST",
      url: "/admin/logout",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
      },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin");
    expect(res.headers["set-cookie"]).toContain("Max-Age=0");

    // Session is destroyed in the store
    expect(await sessionStore.get(session.id)).toBeNull();

    // Subsequent access to dashboard redirects to /admin
    const dashRes = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { cookie: cookieHeader },
    });
    expect(dashRes.statusCode).toBe(302);
    expect(dashRes.headers.location).toBe("/admin");
  });

  it("form-flow redirects: POST-redirect-GET pattern with CSRF form field", async () => {
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    // 1. Initial login form submission
    const loginRes = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "password=admin-secret-password",
    });
    expect(loginRes.statusCode).toBe(302);
    expect(loginRes.headers.location).toBe("/admin/dashboard");

    const rawCookie = loginRes.headers["set-cookie"];
    const cookieHeader =
      (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie)?.split(";")[0] ?? "";
    expect(cookieHeader).toContain("admin_session=");

    // 2. GET dashboard renders forms with csrf_token
    const dashRes = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { cookie: cookieHeader },
    });
    expect(dashRes.statusCode).toBe(200);
    expect(dashRes.body).toContain('name="csrf_token"');

    // Extract CSRF token from HTML
    const match = /name="csrf_token"\s+value="([^"]+)"/.exec(dashRes.body);
    expect(match).not.toBeNull();
    const csrfToken = match![1];

    // 3. Form POST manual-credentials using form-encoded body and csrf_token field
    const manualRes = await app.inject({
      method: "POST",
      url: "/admin/actions/manual-credentials",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf_token=${csrfToken}&refreshToken=form-token&clientId=form-client`,
    });
    expect(manualRes.statusCode).toBe(302);
    expect(manualRes.headers.location).toBe("/admin/dashboard");

    // 4. Follow redirect to dashboard, verify flash message is rendered
    const dashFollowRes = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { cookie: cookieHeader },
    });
    expect(dashFollowRes.statusCode).toBe(200);
    expect(dashFollowRes.body).toContain("Credentials saved");

    // 5. Subsequent GET does not show the flash message again (consume-once)
    const dashSecondRes = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { cookie: cookieHeader },
    });
    expect(dashSecondRes.statusCode).toBe(200);
    expect(dashSecondRes.body).not.toContain("Credentials saved");
  });

  it("localhost callback flow: rejects bad pasted URLs, isolates state, and completes valid sign-in", async () => {
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const session = await sessionStore.create(config.admin.sessionTtlMs);
    const cookieHeader = `admin_session=${session.id}`;
    const expectedRedirect = "http://127.0.0.1:51121/oauth-callback";

    // 1. connect-local without CSRF -> 403
    const resNoCsrf = await app.inject({
      method: "POST",
      url: "/admin/actions/connect-local",
      headers: { cookie: cookieHeader },
    });
    expect(resNoCsrf.statusCode).toBe(403);

    // 2. connect-local not configured -> 400
    oauthService.configured = false;
    const resNotConfigured = await app.inject({
      method: "POST",
      url: "/admin/actions/connect-local",
      headers: { cookie: cookieHeader, "x-csrf-token": session.csrfToken },
    });
    expect(resNotConfigured.statusCode).toBe(400);

    // 3. connect-local configured -> HTML page with authorize URL using the localhost redirect
    oauthService.configured = true;
    const startFlow = async () => {
      const res = await app.inject({
        method: "POST",
        url: "/admin/actions/connect-local",
        headers: { cookie: cookieHeader, "x-csrf-token": session.csrfToken },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain(encodeURIComponent(expectedRedirect));
      const match = /state=([A-Za-z0-9_-]+)/.exec(res.body);
      expect(match).not.toBeNull();
      return match![1];
    };
    const state1 = await startFlow();

    // 4. a state created for session A cannot be completed from session B
    const otherSession = await sessionStore.create(config.admin.sessionTtlMs);
    const resCrossSession = await app.inject({
      method: "POST",
      url: "/admin/actions/complete-local",
      headers: {
        cookie: `admin_session=${otherSession.id}`,
        "x-csrf-token": otherSession.csrfToken,
        accept: "application/json",
      },
      payload: {
        callbackUrl: `${expectedRedirect}?code=x&state=${state1}`,
      },
    });
    expect(resCrossSession.statusCode).toBe(400);

    const state2 = await startFlow();

    // 5. invalid or non-matching pasted URLs are rejected (and do not consume the state)
    const badUrls = [
      "not-a-url",
      `http://evil.example/oauth-callback?code=x&state=${state2}`,
      "http://127.0.0.1:51121/other-path?code=x&state=y",
      "http://user:pass@127.0.0.1:51121/oauth-callback?code=x&state=y",
      "http://127.0.0.1:51121/oauth-callback?code=x&state=y#fragment",
      `http://127.0.0.1:51121/oauth-callback?code=a&code=b&state=${state2}`,
      `http://127.0.0.1:51121/oauth-callback?state=${state2}`,
      "http://127.0.0.1:51121/oauth-callback?code=x&state=unknown-state",
    ];
    for (const callbackUrl of badUrls) {
      const res = await app.inject({
        method: "POST",
        url: "/admin/actions/complete-local",
        headers: {
          cookie: cookieHeader,
          "x-csrf-token": session.csrfToken,
          accept: "application/json",
        },
        payload: { callbackUrl },
      });
      expect(res.statusCode, `Expected 400 for ${callbackUrl}`).toBe(400);
    }

    // 6. a state from the normal (non-localhost) connect flow cannot be completed here
    const normalConnect = await app.inject({
      method: "POST",
      url: "/admin/actions/connect",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
    });
    const normalState = new URL(
      normalConnect.json().authorizeUrl,
    ).searchParams.get("state")!;
    const resCrossFlow = await app.inject({
      method: "POST",
      url: "/admin/actions/complete-local",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
      payload: {
        callbackUrl: `${expectedRedirect}?code=x&state=${normalState}`,
      },
    });
    expect(resCrossFlow.statusCode).toBe(400);

    // 7. happy path: paste the full localhost callback URL via the browser form (form-encoded)
    const callbackUrl = `${expectedRedirect}?code=google-code-local&state=${state2}`;
    const resComplete = await app.inject({
      method: "POST",
      url: "/admin/actions/complete-local",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf_token=${session.csrfToken}&callbackUrl=${encodeURIComponent(callbackUrl)}`,
    });
    expect(resComplete.statusCode).toBe(302);
    expect(resComplete.headers.location).toBe("/admin/dashboard");

    // Code exchange must use the localhost redirect URI; credentials persisted
    expect(oauthService.lastExchangeCodeInput?.redirectUri).toBe(
      expectedRedirect,
    );
    expect(oauthService.lastExchangeCodeInput?.code).toBe("google-code-local");
    const saved = await credentialStore.load();
    expect(saved).not.toBeNull();
    expect(saved?.refreshToken).toBe("fake-refresh-token");
    expect(saved?.accountHint).toBe("user@example.com");

    // 8. single-use: the same state cannot be completed twice
    const resReuse = await app.inject({
      method: "POST",
      url: "/admin/actions/complete-local",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
      payload: { callbackUrl },
    });
    expect(resReuse.statusCode).toBe(400);

    // 9. dashboard flash reflects the localhost connection
    const dashRes = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { cookie: cookieHeader },
    });
    expect(dashRes.body).toContain("Account connected using localhost callback");
  });

  it("localhost callback flow: exchange failure flashes an error without saving credentials or echoing the code", async () => {
    const config = createTestConfig();
    const sessionStore = createSessionStore();
    const credentialStore = createCredentialStore(config.credentials);
    const oauthService = new FakeOAuthService();

    const app = await buildApp({
      config,
      provider: new TestProvider(),
      admin: { sessionStore, credentialStore, oauthService },
    });

    const session = await sessionStore.create(config.admin.sessionTtlMs);
    const cookieHeader = `admin_session=${session.id}`;

    const startRes = await app.inject({
      method: "POST",
      url: "/admin/actions/connect-local",
      headers: { cookie: cookieHeader, "x-csrf-token": session.csrfToken },
    });
    const state = /state=([A-Za-z0-9_-]+)/.exec(startRes.body)![1];

    oauthService.failExchange = true;
    const resComplete = await app.inject({
      method: "POST",
      url: "/admin/actions/complete-local",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": session.csrfToken,
        accept: "application/json",
      },
      payload: {
        callbackUrl: `http://127.0.0.1:51121/oauth-callback?code=SENTINEL_CODE&state=${state}`,
      },
    });
    expect(resComplete.statusCode).toBe(302);
    expect(resComplete.headers.location).toBe("/admin/dashboard");
    expect(await credentialStore.load()).toBeNull();

    const dashRes = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: { cookie: cookieHeader },
    });
    expect(dashRes.body).toContain("OAuth code exchange failed");
    expect(dashRes.body).not.toContain("SENTINEL_CODE");
    expect(dashRes.body).not.toContain("Google rejected code exchange");
  });
});
