import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getClientIp, createFixedWindowLimiter } from "../middleware/rate-limit";
import { verifyCsrfToken } from "../security/csrf";
import type {
  AntigravityAccountStatus,
  CredentialStore,
  OAuthService,
  OAuthTokenResult,
  SessionRecord,
  SessionStore,
} from "../types/admin";
import type { AppConfig } from "../types/config";
import type { AIProvider } from "../types/provider";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  parseCookie,
  verifyAdminPassword,
} from "./auth";
import { OAuthStateManager } from "./oauth-state";
import { RequestTracker } from "../core/request-tracker";
import { registerOperations } from "./operations";
import {
  renderDashboardPage,
  renderErrorPage,
  renderLoginPage,
} from "./pages";

export interface AdminDashboardDeps {
  config: AppConfig;
  provider: AIProvider;
  sessionStore: SessionStore;
  credentialStore: CredentialStore;
  oauthService: OAuthService;
  requestTracker?: RequestTracker;
}

interface FlashMessage {
  type: "success" | "error";
  message: string;
}

export function createAdminRoutes(
  app: FastifyInstance,
  deps: AdminDashboardDeps,
): void {
  const { config, provider, sessionStore, credentialStore, oauthService } =
    deps;
  const oauthStateManager = new OAuthStateManager();
  const requestTracker = deps.requestTracker ?? new RequestTracker();
  registerOperations(app, { config, provider, sessionStore, requestTracker });
  const flashMessages = new Map<string, FlashMessage>();

  const loginLimiter = createFixedWindowLimiter({
    windowMs: config.admin.loginWindowMs,
    max: config.admin.loginMax,
  });

  function setFlash(
    sessionId: string,
    type: "success" | "error",
    message: string,
  ): void {
    flashMessages.set(sessionId, { type, message });
  }

  function popFlash(sessionId: string): FlashMessage | null {
    const flash = flashMessages.get(sessionId) ?? null;
    if (flash) {
      flashMessages.delete(sessionId);
    }
    return flash;
  }

  function getRedirectUri(request: FastifyRequest): string {
    if (config.oauth.redirectBaseUrl) {
      return `${config.oauth.redirectBaseUrl.replace(/\/+$/, "")}/admin/oauth/callback`;
    }
    return `${request.protocol}://${request.host}/admin/oauth/callback`;
  }

  async function resolveSession(
    request: FastifyRequest,
  ): Promise<SessionRecord | null> {
    const sessionId = parseCookie(request.headers.cookie, "admin_session");
    if (!sessionId) {
      return null;
    }
    return sessionStore.get(sessionId);
  }

  function checkCsrf(
    request: FastifyRequest,
    session: SessionRecord,
  ): boolean {
    const headerToken = request.headers["x-csrf-token"];
    if (typeof headerToken === "string" && headerToken) {
      return verifyCsrfToken(session.csrfToken, headerToken);
    }
    const body = request.body as Record<string, unknown> | undefined;
    const bodyToken =
      typeof body?.csrf_token === "string" ? body.csrf_token : undefined;
    if (bodyToken) {
      return verifyCsrfToken(session.csrfToken, bodyToken);
    }
    return false;
  }

  // 1. GET /admin — Login page or redirect to dashboard
  app.get("/admin", async (request, reply) => {
    const session = await resolveSession(request);
    if (session) {
      return reply.redirect("/admin/dashboard");
    }
    const sessionId = parseCookie(request.headers.cookie, "admin_session");
    const flash = sessionId ? popFlash(sessionId) : null;
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(renderLoginPage({ flash: flash?.message }));
  });

  // 2. POST /admin/login — Login with password & rate limiting per IP
  app.post("/admin/login", async (request, reply) => {
    const ip = getClientIp(request, config.trustProxy);
    const limitCheck = loginLimiter(`admin-login:${ip}`);

    if (!limitCheck.allowed) {
      reply.header("Retry-After", String(limitCheck.retryAfterSeconds));
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(429).send({
          error: {
            message: "Too many login attempts. Please try again later.",
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply
        .status(429)
        .send(
          renderLoginPage({
            error: "Too many login attempts. Please try again later.",
          }),
        );
    }

    const body = request.body as Record<string, unknown> | undefined;
    const password =
      typeof body?.password === "string" ? body.password : "";

    const isValid = verifyAdminPassword(password, config.admin);
    if (!isValid) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(401).send({
          error: {
            message: "Invalid password",
            type: "authentication_error",
            code: "invalid_password",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply.status(401).send(
        renderLoginPage({
          error: "Invalid password",
        }),
      );
    }

    const session = await sessionStore.create(config.admin.sessionTtlMs);
    const cookie = buildSessionCookie(
      session.id,
      config.admin.sessionTtlMs,
      request.protocol === "https",
    );
    reply.header("Set-Cookie", cookie);

    if (request.headers.accept?.includes("application/json")) {
      return reply.status(200).send({ ok: true, redirect: "/admin/dashboard" });
    }
    return reply.redirect("/admin/dashboard");
  });

  // 3. POST /admin/logout — Destroy session & clear cookie
  app.post("/admin/logout", async (request, reply) => {
    const session = await resolveSession(request);
    if (!session) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "authentication_error",
            code: "unauthorized",
          },
        });
      }
      return reply.redirect("/admin");
    }

    if (!checkCsrf(request, session)) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(403).send({
          error: {
            message: "Invalid or missing CSRF token",
            type: "invalid_request_error",
            code: "invalid_csrf_token",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply
        .status(403)
        .send(renderErrorPage("Forbidden", "Invalid or missing CSRF token."));
    }

    await sessionStore.destroy(session.id);
    reply.header(
      "Set-Cookie",
      buildClearSessionCookie(request.protocol === "https"),
    );

    if (request.headers.accept?.includes("application/json")) {
      return reply.send({ ok: true });
    }
    return reply.redirect("/admin");
  });

  // 4. GET /admin/dashboard — Status page + action forms + flash
  app.get("/admin/dashboard", async (request, reply) => {
    const session = await resolveSession(request);
    if (!session) {
      return reply.redirect("/admin");
    }

    let status: AntigravityAccountStatus;
    if (typeof provider.getAccountStatus === "function") {
      status = await provider.getAccountStatus();
    } else {
      status = {
        providerMode: config.provider.mode,
        connected: false,
        hasRefreshToken: false,
        needsReconnect: false,
      };
    }

    const credHealth = await credentialStore.health();
    const flash = popFlash(session.id);
    const models = await provider.listModels().catch(() => []);
    const modelSettings = await provider.getModelSettings?.().catch(() => undefined);
    let baseUrl = `${request.protocol}://${request.host}`;
    if (config.oauth.redirectBaseUrl) {
      try {
        const configured = new URL(config.oauth.redirectBaseUrl);
        if (["http:", "https:"].includes(configured.protocol) && !configured.username && !configured.password) baseUrl = configured.origin;
      } catch { /* Use the current request origin when configuration is invalid. */ }
    }

    reply.header("Cache-Control", "no-store");
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(
      renderDashboardPage({
        status,
        credentialStoreHealth: credHealth,
        oauthConfigured: oauthService.isConfigured(),
        csrfToken: session.csrfToken,
        flash,
        operations: {
          snapshot: requestTracker.snapshot(), baseUrl, models: models.map(model => model.id),
          apiKeyCount: config.apiKeys.length, isRender: process.env.RENDER === "true",
          encryptedStore: Boolean(config.credentials.encryptionKey),
          hasTokenCache: Boolean(config.provider.credentials.tokenStorePath),
          modelSettings,
          modelSettingsAvailable: Boolean(provider.getModelSettings),
        },
      }),
    );
  });

  // 5. GET /admin/api/status — JSON status whitelist (no secrets)
  app.get("/admin/api/status", async (request, reply) => {
    const session = await resolveSession(request);
    if (!session) {
      return reply.status(401).send({
        error: {
          message: "Unauthorized",
          type: "authentication_error",
          code: "unauthorized",
        },
      });
    }

    let providerStatus: AntigravityAccountStatus;
    if (typeof provider.getAccountStatus === "function") {
      providerStatus = await provider.getAccountStatus();
    } else {
      providerStatus = {
        providerMode: config.provider.mode,
        connected: false,
        hasRefreshToken: false,
        needsReconnect: false,
      };
    }

    const credHealth = await credentialStore.health();
    const redirectUri = getRedirectUri(request);

    return reply.send({
      enabled: true,
      providerMode: config.provider.mode,
      provider: providerStatus,
      credentials: {
        backend: credHealth.backend,
        ok: credHealth.ok,
        ...(credHealth.detail ? { detail: credHealth.detail } : {}),
      },
      oauth: {
        configured: oauthService.isConfigured(),
        redirectUri,
      },
    });
  });

  // 6. POST /admin/actions/connect — Start OAuth flow
  app.post("/admin/actions/connect", async (request, reply) => {
    const session = await resolveSession(request);
    if (!session) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "authentication_error",
            code: "unauthorized",
          },
        });
      }
      return reply.redirect("/admin");
    }

    if (!checkCsrf(request, session)) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(403).send({
          error: {
            message: "Invalid or missing CSRF token",
            type: "invalid_request_error",
            code: "invalid_csrf_token",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply
        .status(403)
        .send(renderErrorPage("Forbidden", "Invalid or missing CSRF token."));
    }

    if (!oauthService.isConfigured()) {
      const msg =
        "Browser OAuth is not configured. Either configure ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET, or use the manual refresh-token option.";
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(400).send({
          error: {
            message: msg,
            type: "invalid_request_error",
            code: "oauth_not_configured",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply
        .status(400)
        .send(renderErrorPage("OAuth Not Configured", msg));
    }

    const { state, codeChallenge } = oauthStateManager.create(session.id);
    const redirectUri = getRedirectUri(request);
    const authorizeUrl = oauthService.buildAuthorizeUrl({
      state,
      codeChallenge,
      redirectUri,
    });

    if (request.headers.accept?.includes("application/json")) {
      return reply.send({ authorizeUrl });
    }
    return reply.redirect(authorizeUrl);
  });


  // Copy-URL login for a registered localhost callback (the browser need not host a server).
  // This does not grant access to upstream services; it still requires an authorized OAuth client.
  app.post("/admin/actions/connect-local", async (request, reply) => {
    const session = await resolveSession(request);
    if (!session) return reply.redirect("/admin");
    if (!checkCsrf(request, session)) {
      return reply.status(403).send(renderErrorPage("Forbidden", "Invalid or missing CSRF token."));
    }
    if (!oauthService.isConfigured()) {
      return reply.status(400).send(renderErrorPage("OAuth Not Configured", "OAuth client credentials are missing."));
    }
    const redirectUri = "http://127.0.0.1:51121/oauth-callback";
    const { state, codeChallenge } = oauthStateManager.create(session.id, redirectUri);
    const authorizeUrl = oauthService.buildAuthorizeUrl({ state, codeChallenge, redirectUri });
    // Let the original dashboard tab remain open for pasting the returned URL.
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Continue Google sign-in</title></head><body style="font-family:system-ui;max-width:680px;margin:4rem auto;padding:1rem"><h1>Google sign-in</h1><p>Open the Google authorization page, complete sign-in, then copy the entire localhost callback URL from the address bar. The browser may say it cannot connect to localhost; that is expected.</p><p><a href="${authorizeUrl.replaceAll("&", "&amp;").replaceAll('"', '&quot;')}" target="_blank" rel="noopener noreferrer">Open Google sign-in</a></p><p><a href="/admin/dashboard">Return to dashboard to paste the callback URL</a></p></body></html>`);
  });

  app.post("/admin/actions/complete-local", async (request, reply) => {
    const session = await resolveSession(request);
    if (!session) return reply.redirect("/admin");
    if (!checkCsrf(request, session)) {
      return reply.status(403).send(renderErrorPage("Forbidden", "Invalid or missing CSRF token."));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const pasted = typeof body.callbackUrl === "string" ? body.callbackUrl.trim() : "";
    if (!pasted || pasted.length > 8192) {
      return reply.status(400).send(renderErrorPage("Invalid URL", "Paste the full localhost callback URL (maximum 8192 characters)."));
    }
    let callback: URL;
    try {
      callback = new URL(pasted);
    } catch {
      return reply.status(400).send(renderErrorPage("Invalid URL", "The pasted value is not a valid URL."));
    }
    const expected = "http://127.0.0.1:51121/oauth-callback";
    if (`${callback.origin}${callback.pathname}` !== expected || callback.username || callback.password || callback.hash) {
      return reply.status(400).send(renderErrorPage("Invalid URL", "Only the expected localhost OAuth callback URL is accepted."));
    }
    if (callback.searchParams.getAll("state").length !== 1 || callback.searchParams.getAll("code").length !== 1) {
      return reply.status(400).send(renderErrorPage("Invalid Callback", "The callback must contain exactly one state and one code."));
    }
    const state = callback.searchParams.get("state") ?? "";
    const code = callback.searchParams.get("code") ?? "";
    if (!state || !code) {
      return reply.status(400).send(renderErrorPage("Invalid Callback", "OAuth state or authorization code is missing."));
    }
    const pending = oauthStateManager.consume(state, session.id);
    if (!pending || pending.redirectUri !== expected) {
      return reply.status(400).send(renderErrorPage("Invalid State", "The sign-in request has expired, was already used, or belongs to another session. Start again."));
    }
    try {
      const result = await oauthService.exchangeCode({ code, codeVerifier: pending.codeVerifier, redirectUri: expected });
      const clientId = config.provider.credentials.clientId;
      const clientSecret = config.provider.credentials.clientSecret;
      await credentialStore.save({
        refreshToken: result.refreshToken,
        clientId,
        clientSecret,
        projectId: result.projectId,
        accountHint: result.accountHint,
        updatedAt: Date.now(),
      });
      // Provider token state is read from the credential store by the adapter.
      setFlash(session.id, "success", "Account connected using localhost callback");
      return reply.redirect("/admin/dashboard");
    } catch {
      // Do not echo upstream errors, pasted URLs, or authorization codes into HTML or logs.
      setFlash(session.id, "error", "OAuth code exchange failed. Start a fresh sign-in and try again.");
      return reply.redirect("/admin/dashboard");
    }
  });

  // 7. GET /admin/oauth/callback — Exchange OAuth code & persist
  app.get("/admin/oauth/callback", async (request, reply) => {
    const session = await resolveSession(request);
    if (!session) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "authentication_error",
            code: "unauthorized",
          },
        });
      }
      return reply.redirect("/admin");
    }

    const query = request.query as Record<string, string | undefined>;
    const state = query.state;

    if (!state) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(400).send({
          error: {
            message: "Missing OAuth state parameter",
            type: "invalid_request_error",
            code: "invalid_oauth_state",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply
        .status(400)
        .send(
          renderErrorPage("Invalid State", "Missing OAuth state parameter."),
        );
    }

    const consumed = oauthStateManager.consume(state, session.id);
    if (!consumed) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(400).send({
          error: {
            message: "Invalid, expired, or mismatching OAuth state parameter",
            type: "invalid_request_error",
            code: "invalid_oauth_state",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply
        .status(400)
        .send(
          renderErrorPage(
            "Invalid State",
            "Invalid, expired, or mismatching OAuth state parameter.",
          ),
        );
    }

    if (query.error) {
      const errorMsg = query.error_description
        ? `Google OAuth error: ${query.error} - ${query.error_description}`
        : `Google OAuth error: ${query.error}`;
      setFlash(session.id, "error", errorMsg);
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(400).send({
          error: {
            message: errorMsg,
            type: "oauth_error",
            code: "provider_oauth_error",
          },
        });
      }
      return reply.redirect("/admin/dashboard");
    }

    const code = query.code;
    if (!code) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(400).send({
          error: {
            message: "Missing authorization code from OAuth callback",
            type: "invalid_request_error",
            code: "missing_code",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply
        .status(400)
        .send(
          renderErrorPage(
            "Missing Code",
            "Missing authorization code from OAuth callback.",
          ),
        );
    }

    const redirectUri = consumed.redirectUri ?? getRedirectUri(request);

    try {
      const result = await oauthService.exchangeCode({
        code,
        codeVerifier: consumed.codeVerifier,
        redirectUri,
      });

      const clientId =
        config.provider.credentials.clientId;
      const clientSecret =
        config.provider.credentials.clientSecret;

      await credentialStore.save({
        refreshToken: result.refreshToken,
        clientId,
        clientSecret,
        projectId: result.projectId,
        accountHint: result.accountHint,
        updatedAt: Date.now(),
      });

      setFlash(session.id, "success", "Account connected");
      if (request.headers.accept?.includes("application/json")) {
        return reply.send({ ok: true, accountHint: result.accountHint });
      }
      return reply.redirect("/admin/dashboard");
    } catch (err: unknown) {
      const rawMessage =
        err instanceof Error ? err.message : "OAuth code exchange failed";
      setFlash(session.id, "error", `Connection failed: ${rawMessage}`);
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(400).send({
          error: {
            message: `Connection failed: ${rawMessage}`,
            type: "oauth_error",
            code: "exchange_failed",
          },
        });
      }
      return reply.redirect("/admin/dashboard");
    }
  });

  // 8. POST /admin/actions/manual-credentials — Validate & save manual credentials
  app.post("/admin/actions/manual-credentials", async (request, reply) => {
    const session = await resolveSession(request);
    if (!session) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "authentication_error",
            code: "unauthorized",
          },
        });
      }
      return reply.redirect("/admin");
    }

    if (!checkCsrf(request, session)) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(403).send({
          error: {
            message: "Invalid or missing CSRF token",
            type: "invalid_request_error",
            code: "invalid_csrf_token",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply
        .status(403)
        .send(renderErrorPage("Forbidden", "Invalid or missing CSRF token."));
    }

    const body = (request.body as Record<string, unknown>) || {};
    const refreshToken =
      typeof body.refreshToken === "string" ? body.refreshToken.trim() : "";
    const clientId =
      typeof body.clientId === "string" && body.clientId.trim()
        ? body.clientId.trim()
        : undefined;
    const clientSecret =
      typeof body.clientSecret === "string" && body.clientSecret.trim()
        ? body.clientSecret.trim()
        : undefined;
    const projectId =
      typeof body.projectId === "string" && body.projectId.trim()
        ? body.projectId.trim()
        : undefined;

    if (!refreshToken) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(400).send({
          error: {
            message: "refreshToken is required",
            type: "invalid_request_error",
            code: "missing_refresh_token",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply
        .status(400)
        .send(
          renderErrorPage("Invalid Request", "Refresh token is required."),
        );
    }

    let tokenResult: OAuthTokenResult;
    try {
      tokenResult = await oauthService.testRefresh({
        refreshToken,
        clientId,
        clientSecret,
      });
    } catch (err: unknown) {
      const rawMessage =
        err instanceof Error ? err.message : "Token refresh failed";
      // Redact refreshToken in case the error message echoed it
      const safeMessage = rawMessage.split(refreshToken).join("[REDACTED]");
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(400).send({
          error: {
            message: safeMessage,
            type: "provider_error",
            code: "invalid_credentials",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply
        .status(400)
        .send(renderErrorPage("Validation Failed", safeMessage));
    }

    await credentialStore.save({
      refreshToken,
      clientId,
      clientSecret,
      projectId: tokenResult.projectId || projectId,
      accountHint: tokenResult.accountHint,
      updatedAt: Date.now(),
    });

    setFlash(session.id, "success", "Credentials saved");
    if (request.headers.accept?.includes("application/json")) {
      return reply.send({ ok: true, accountHint: tokenResult.accountHint });
    }
    return reply.redirect("/admin/dashboard");
  });

  // 9. POST /admin/actions/reconnect — Force test refresh now & report result
  app.post("/admin/actions/reconnect", async (request, reply) => {
    const session = await resolveSession(request);
    if (!session) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "authentication_error",
            code: "unauthorized",
          },
        });
      }
      return reply.redirect("/admin");
    }

    if (!checkCsrf(request, session)) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(403).send({
          error: {
            message: "Invalid or missing CSRF token",
            type: "invalid_request_error",
            code: "invalid_csrf_token",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply
        .status(403)
        .send(renderErrorPage("Forbidden", "Invalid or missing CSRF token."));
    }

    const creds = await credentialStore.load();
    if (!creds || !creds.refreshToken) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(400).send({
          error: {
            message: "No credentials stored",
            type: "invalid_request_error",
            code: "no_credentials",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply
        .status(400)
        .send(renderErrorPage("No Credentials", "No credentials stored."));
    }

    try {
      const result = await oauthService.testRefresh({
        refreshToken: creds.refreshToken,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      });

      if (result.accountHint && result.accountHint !== creds.accountHint) {
        await credentialStore.save({
          ...creds,
          accountHint: result.accountHint,
          updatedAt: Date.now(),
        });
      }

      const msg =
        "Reconnected successfully. The provider refreshes lazily on the next chat request.";
      setFlash(session.id, "success", msg);

      if (request.headers.accept?.includes("application/json")) {
        return reply.send({
          ok: true,
          message: msg,
          accountHint: result.accountHint,
        });
      }
      return reply.redirect("/admin/dashboard");
    } catch (err: unknown) {
      const rawMsg =
        err instanceof Error ? err.message : "Reconnect refresh failed";
      const safeMsg = rawMsg.split(creds.refreshToken).join("[REDACTED]");
      setFlash(session.id, "error", safeMsg);

      if (request.headers.accept?.includes("application/json")) {
        return reply.send({ ok: false, error: safeMsg });
      }
      return reply.redirect("/admin/dashboard");
    }
  });

  // 10. POST /admin/actions/disconnect — Clear stored credentials & flash
  app.post("/admin/actions/disconnect", async (request, reply) => {
    const session = await resolveSession(request);
    if (!session) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "authentication_error",
            code: "unauthorized",
          },
        });
      }
      return reply.redirect("/admin");
    }

    if (!checkCsrf(request, session)) {
      if (request.headers.accept?.includes("application/json")) {
        return reply.status(403).send({
          error: {
            message: "Invalid or missing CSRF token",
            type: "invalid_request_error",
            code: "invalid_csrf_token",
          },
        });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply
        .status(403)
        .send(renderErrorPage("Forbidden", "Invalid or missing CSRF token."));
    }

    await credentialStore.clear();
    setFlash(session.id, "success", "Account disconnected");

    if (request.headers.accept?.includes("application/json")) {
      return reply.send({ ok: true });
    }
    return reply.redirect("/admin/dashboard");
  });
}
