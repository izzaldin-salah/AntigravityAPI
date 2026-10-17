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

    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(
      renderDashboardPage({
        status,
        credentialStoreHealth: credHealth,
        oauthConfigured: oauthService.isConfigured(),
        csrfToken: session.csrfToken,
        flash,
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

    const redirectUri = getRedirectUri(request);

    try {
      const result = await oauthService.exchangeCode({
        code,
        codeVerifier: consumed.codeVerifier,
        redirectUri,
      });

      const clientId =
        config.provider.mode === "antigravity"
          ? config.provider.credentials.clientId
          : undefined;
      const clientSecret =
        config.provider.mode === "antigravity"
          ? config.provider.credentials.clientSecret
          : undefined;

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
