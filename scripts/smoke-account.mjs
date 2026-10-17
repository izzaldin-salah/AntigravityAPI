#!/usr/bin/env node
/**
 * Coordinator acceptance harness for the v1.1 account-management dashboard.
 *
 * Boots the BUILT server (dist/server.js, run `npm run build` first) with a fake
 * Google OAuth token endpoint and exercises the COMPLETE account workflow over HTTP:
 *   admin login -> status disconnected -> connect start (PKCE) -> callback (code
 *   exchange) -> connected (encrypted store) -> reconnect -> disconnect ->
 *   manual credentials -> login rate limit -> logout -> Bearer isolation.
 *
 * Requires: Node >= 20 (fetch + getSetCookie). No external services, no real
 * credentials: everything is localhost + sentinel values.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const APP_PORT = 39182;
const ADMIN_PASSWORD = "e2e-admin-password"; // throwaway, local-only
const API_KEY = "e2e-api-key";
const SENTINEL = `SENTINEL_REFRESH_TOKEN_DO_NOT_LEAK_${randomBytes(6).toString("hex")}`;
const ACCESS_SENTINEL = `SENTINEL_ACCESS_TOKEN_${randomBytes(6).toString("hex")}`;
const BAD_TOKEN = "revoked-refresh-token-for-tests";

const results = [];
const responseSweep = [];
const check = (name, ok, detail = "") =>
  results.push({ ok: Boolean(ok), name, detail: String(detail).slice(0, 300) });

function fakeIdToken(email) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ email })}.signature-not-verified`;
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
}

async function startFakeGoogle() {
  const state = { challenge: null, tokenRequests: [] };
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/token")) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    const grant = params.get("grant_type");
    state.tokenRequests.push({
      grant,
      code: params.get("code"),
      hasVerifier: Boolean(params.get("code_verifier")),
      refreshToken: params.get("refresh_token"),
      clientId: params.get("client_id"),
    });

    if (grant === "authorization_code") {
      if (params.get("code") !== "good-code") {
        sendJson(res, 400, { error: "invalid_grant", error_description: "bad code" });
        return;
      }
      const verifier = params.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!state.challenge || challenge !== state.challenge) {
        sendJson(res, 400, {
          error: "invalid_request",
          error_description: "PKCE verification failed",
        });
        return;
      }
      sendJson(res, 200, {
        access_token: ACCESS_SENTINEL,
        expires_in: 3600,
        refresh_token: SENTINEL,
        token_type: "Bearer",
        id_token: fakeIdToken("operator@example.com"),
        project_id: "e2e-project",
      });
      return;
    }

    if (grant === "refresh_token") {
      if (params.get("refresh_token") === BAD_TOKEN) {
        sendJson(res, 400, {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        });
        return;
      }
      sendJson(res, 200, {
        access_token: ACCESS_SENTINEL,
        expires_in: 3600,
        token_type: "Bearer",
      });
      return;
    }

    sendJson(res, 400, { error: "unsupported_grant_type" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  state.tokenUrl = `http://127.0.0.1:${port}/token`;
  state.authUrl = `http://127.0.0.1:${port}/authorize`;
  state.close = () => new Promise((resolve) => server.close(resolve));
  return state;
}

async function startApp(env) {
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs = (logs + d.toString()).slice(-6000)));
  child.stderr.on("data", (d) => (logs = (logs + d.toString()).slice(-6000)));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${APP_PORT}/health`);
      if (res.ok) return { child, logs: () => logs };
    } catch {
      /* not up yet */
    }
    await delay(300);
  }
  child.kill();
  throw new Error(`server did not become healthy. logs:\n${logs}`);
}

let sessionCookie = null;
async function req(path, { method = "GET", csrf, json, accept } = {}) {
  const headers = {};
  if (sessionCookie) headers.cookie = sessionCookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (accept) headers.accept = accept;
  let body;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${path}`, {
    method,
    headers,
    body,
    redirect: "manual",
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const m = /^admin_session=([^;]*)/.exec(sc);
    if (m) sessionCookie = `admin_session=${m[1]}`;
  }
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* empty body */
  }
  responseSweep.push(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, headers: res.headers, text, json: parsed, setCookies: res.headers.getSetCookie?.() ?? [] };
}

const extractCsrf = (html) => {
  const m1 = /name=["']csrf_token["'][^>]*value=["']([^"']+)["']/.exec(html);
  const m2 = /value=["']([^"']+)["'][^>]*name=["']csrf_token["']/.exec(html);
  return m1?.[1] ?? m2?.[1] ?? null;
};

async function main() {
  if (!existsSync(join(process.cwd(), "dist", "server.js"))) {
    console.error("dist/server.js missing - run `npm run build` first.");
    process.exit(1);
  }

  const storeDir = await mkdtemp(join(tmpdir(), "agapi-account-e2e-"));
  const credFile = join(storeDir, "credential-store.json");
  const fake = await startFakeGoogle();

  const env = { ...process.env };
  for (const k of ["ANTIGRAVITY_REFRESH_TOKEN", "ANTIGRAVITY_ACCESS_TOKEN", "REDIS_URL"]) delete env[k];
  Object.assign(env, {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(APP_PORT),
    LOG_LEVEL: "warn",
    API_KEYS: API_KEY,
    PROVIDER_MODE: "antigravity",
    ANTIGRAVITY_CLIENT_ID: "e2e-client-id.apps.googleusercontent.com",
    ANTIGRAVITY_CLIENT_SECRET: "e2e-client-secret",
    ANTIGRAVITY_TOKEN_STORE_PATH: join(storeDir, "token-cache.json"),
    ANTIGRAVITY_OAUTH_TOKEN_ENDPOINT: fake.tokenUrl,
    ANTIGRAVITY_OAUTH_AUTH_ENDPOINT: fake.authUrl,
    OAUTH_REDIRECT_BASE_URL: `http://127.0.0.1:${APP_PORT}`,
    ADMIN_PASSWORD,
    ADMIN_LOGIN_MAX: "5",
    ADMIN_LOGIN_WINDOW_MS: "60000",
    CREDENTIAL_STORE: "file",
    CREDENTIAL_FILE_PATH: credFile,
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    RATE_LIMIT_MAX: "1000",
  });

  let app = null;
  try {
    app = await startApp(env);

    // 1. Public health
    const health = await req("/health");
    check("server starts; /health public", health.status === 200, `status=${health.status}`);

    // 2. Login page
    const adminPage = await req("/admin");
    check(
      "/admin serves the login page",
      adminPage.status === 200 && adminPage.text.includes('name="password"'),
      `status=${adminPage.status}`,
    );

    // 3. Dashboard requires a session
    const noSession = await req("/admin/dashboard");
    check(
      "/admin/dashboard without session redirects",
      noSession.status === 302 || noSession.status === 303,
      `status=${noSession.status}`,
    );

    // 4. Wrong password -> 401, no cookie
    const wrong1 = await req("/admin/login", {
      method: "POST",
      json: { password: "definitely-wrong" },
      accept: "application/json",
    });
    check("login wrong password -> 401", wrong1.status === 401, `status=${wrong1.status}`);
    check(
      "login failure sets no session cookie",
      !wrong1.setCookies.some((c) => c.startsWith("admin_session=")),
      wrong1.setCookies.join(" | ").slice(0, 80),
    );

    // 5. Correct login -> session cookie with flags
    const login = await req("/admin/login", {
      method: "POST",
      json: { password: ADMIN_PASSWORD },
      accept: "application/json",
    });
    const cookie = login.setCookies.find((c) => c.startsWith("admin_session=")) ?? "";
    // Form flow answers 302; JSON mode answers 200 with the cookie set. Both are valid.
    check(
      "login success -> session cookie issued (302 form / 200 JSON)",
      (login.status === 302 || login.status === 303 || login.status === 200) && cookie.length > 0,
      `status=${login.status}`,
    );
    check(
      "cookie flags HttpOnly + SameSite=Lax + Path=/ (no Secure on http)",
      /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie) && /Path=\//i.test(cookie) && !/Secure/i.test(cookie),
      cookie.slice(0, 120),
    );

    // 6. Dashboard page + CSRF token
    const dashboard = await req("/admin/dashboard");
    const csrf = extractCsrf(dashboard.text);
    check(
      "dashboard renders with CSRF token",
      dashboard.status === 200 && Boolean(csrf),
      `status=${dashboard.status}`,
    );

    // 7. Status: disconnected, file backend, oauth configured
    const status0 = await req("/admin/api/status");
    check(
      "status: disconnected / file backend / oauth configured",
      status0.status === 200 &&
        status0.json?.provider?.connected === false &&
        status0.json?.credentials?.backend === "file" &&
        status0.json?.oauth?.configured === true,
      JSON.stringify(status0.json ?? {}).slice(0, 200),
    );

    // 8. CSRF enforcement
    const noCsrf = await req("/admin/actions/connect", { method: "POST", json: {}, accept: "application/json" });
    const badCsrf = await req("/admin/actions/connect", {
      method: "POST",
      csrf: "not-the-token",
      json: {},
      accept: "application/json",
    });
    check("CSRF: missing token -> 403", noCsrf.status === 403, `status=${noCsrf.status}`);
    check("CSRF: wrong token -> 403", badCsrf.status === 403, `status=${badCsrf.status}`);

    // 9. Connect start -> authorize URL (PKCE)
    const connect = await req("/admin/actions/connect", {
      method: "POST",
      csrf,
      json: {},
      accept: "application/json",
    });
    const authorizeUrl =
      connect.json?.authorizeUrl ?? (connect.status >= 300 && connect.status < 400 ? connect.headers.get("location") : null);
    const auth = authorizeUrl ? new URL(authorizeUrl) : null;
    check(
      "connect start -> authorize URL with state + PKCE S256",
      Boolean(auth) &&
        authorizeUrl.startsWith(fake.authUrl) &&
        auth.searchParams.get("code_challenge_method") === "S256" &&
        Boolean(auth.searchParams.get("code_challenge")) &&
        Boolean(auth.searchParams.get("state")) &&
        (auth.searchParams.get("scope") ?? "").includes("cloud-platform"),
      String(authorizeUrl).slice(0, 160),
    );
    const oauthState = auth?.searchParams.get("state") ?? "";
    fake.challenge = auth?.searchParams.get("code_challenge") ?? null;

    // 10. Callback: wrong state rejected
    const badState = await req(`/admin/oauth/callback?code=good-code&state=state-tampered`);
    check("callback with bad state -> 400", badState.status === 400, `status=${badState.status}`);

    // 11. Callback: happy path (fake Google validates PKCE)
    const callback = await req(
      `/admin/oauth/callback?code=good-code&state=${encodeURIComponent(oauthState)}`,
    );
    check(
      "callback happy path -> redirect to dashboard",
      callback.status === 302 || callback.status === 303 || callback.status === 200,
      `status=${callback.status}`,
    );
    const exchange = fake.tokenRequests.find((t) => t.grant === "authorization_code");
    check(
      "token exchange hit fake Google with PKCE verifier",
      Boolean(exchange) && exchange.hasVerifier && exchange.code === "good-code",
      JSON.stringify(exchange ?? null),
    );

    // 12. Status: connected + masked account hint
    const status1 = await req("/admin/api/status");
    const hint = status1.json?.provider?.accountHint ?? "";
    check(
      "status: connected with refresh token",
      status1.status === 200 && status1.json?.provider?.connected === true && status1.json?.provider?.hasRefreshToken === true,
      JSON.stringify(status1.json?.provider ?? {}).slice(0, 200),
    );
    check(
      "account hint masked (no full email, domain kept)",
      hint.includes("@example.com") && !hint.includes("operator@example.com"),
      hint,
    );

    // 13. Credential file: encrypted at rest, no plaintext sentinel
    let fileText = "";
    try {
      fileText = await readFile(credFile, "utf8");
    } catch {
      fileText = "";
    }
    check(
      "credential file exists and has envelope shape",
      fileText.includes('"v"') && fileText.includes("scrypt"),
      fileText.slice(0, 120),
    );
    check(
      "credential file: NO plaintext refresh/access token",
      fileText.length > 0 && !fileText.includes(SENTINEL) && !fileText.includes(ACCESS_SENTINEL),
      `len=${fileText.length}`,
    );

    // 14. Dashboard page after connect leaks nothing
    const dashboard2 = await req("/admin/dashboard");
    check(
      "dashboard after connect leaks no sentinel",
      dashboard2.status === 200 && !dashboard2.text.includes(SENTINEL) && !dashboard2.text.includes(ACCESS_SENTINEL),
      `status=${dashboard2.status}`,
    );

    // 15. Reconnect -> refresh grant issued
    const before = fake.tokenRequests.filter((t) => t.grant === "refresh_token").length;
    const reconnect = await req("/admin/actions/reconnect", { method: "POST", csrf, json: {}, accept: "application/json" });
    const after = fake.tokenRequests.filter((t) => t.grant === "refresh_token").length;
    check(
      "reconnect -> 2xx and refresh grant exercised",
      reconnect.status >= 200 && reconnect.status < 400 && after > before,
      `status=${reconnect.status} refreshGrants=${before}->${after}`,
    );

    // 16. Disconnect -> store cleared, status disconnected
    const disconnect = await req("/admin/actions/disconnect", { method: "POST", csrf, json: {}, accept: "application/json" });
    const status2 = await req("/admin/api/status");
    check(
      "disconnect clears credentials",
      disconnect.status >= 200 && disconnect.status < 400 && status2.json?.provider?.connected === false,
      `status=${disconnect.status} connected=${status2.json?.provider?.connected}`,
    );

    // 17. Manual credentials: invalid token rejected, store untouched
    const manualBad = await req("/admin/actions/manual-credentials", {
      method: "POST",
      csrf,
      json: { refreshToken: BAD_TOKEN },
      accept: "application/json",
    });
    const status3 = await req("/admin/api/status");
    check(
      "manual credentials: invalid refresh token -> 4xx, not stored",
      manualBad.status >= 400 && manualBad.status < 500 && status3.json?.provider?.connected === false,
      `status=${manualBad.status}`,
    );

    // 18. Manual credentials: valid token stored (validated via test refresh)
    const manualGood = await req("/admin/actions/manual-credentials", {
      method: "POST",
      csrf,
      json: { refreshToken: SENTINEL, projectId: "e2e-manual-project" },
      accept: "application/json",
    });
    const status4 = await req("/admin/api/status");
    check(
      "manual credentials: valid token stored, status connected",
      manualGood.status >= 200 && manualGood.status < 400 && status4.json?.provider?.connected === true,
      `status=${manualGood.status}`,
    );
    let fileText2 = "";
    try {
      fileText2 = await readFile(credFile, "utf8");
    } catch {
      fileText2 = "";
    }
    check(
      "manual credential also encrypted at rest (sentinel absent)",
      fileText2.length > 0 && !fileText2.includes(SENTINEL),
      `len=${fileText2.length}`,
    );

    // 19. Login rate limit: keep attempting wrong passwords -> eventually 429
    const attempts = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await req("/admin/login", { method: "POST", json: { password: `wrong-${i}` }, accept: "application/json" });
      attempts.push(r.status === 429 ? "429" : String(r.status));
      if (r.status === 429) {
        check("rate limit: 429 carries Retry-After", r.headers.get("retry-after") !== null, `retry-after=${r.headers.get("retry-after")}`);
        break;
      }
    }
    check(
      "login rate limit: attempts blocked after max",
      attempts.includes("401") && attempts.includes("429"),
      `attempts=${attempts.join(",")}`,
    );

    // 20. Logout -> session destroyed
    const logout = await req("/admin/logout", { method: "POST", csrf, json: {}, accept: "application/json" });
    sessionCookie = null;
    check(
      "logout -> 2xx and session gone",
      logout.status >= 200 && logout.status < 400 || logout.status === 302 || logout.status === 303,
      `status=${logout.status}`,
    );
    const afterLogout = await req("/admin/api/status");
    check(
      "status after logout is not public",
      afterLogout.status === 401 || afterLogout.status === 302 || afterLogout.status === 303,
      `status=${afterLogout.status}`,
    );

    // 21. Bearer isolation: /admin session does NOT unlock /v1, API key still required
    const v1NoKey = await req("/v1/models");
    const v1Key = await fetch(`http://127.0.0.1:${APP_PORT}/v1/models`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    check("auth isolation: /v1/models without key -> 401", v1NoKey.status === 401, `status=${v1NoKey.status}`);
    check("auth isolation: /v1/models with key -> 200", v1Key.status === 200, `status=${v1Key.status}`);

    // 22. Global sweep: no response ever contained a token sentinel
    check(
      "global sweep: no response body leaked tokens",
      responseSweep.every((t) => !t.includes(SENTINEL) && !t.includes(ACCESS_SENTINEL)),
      `responses=${responseSweep.length}`,
    );
  } catch (error) {
    check("harness completed without fatal error", false, error instanceof Error ? error.message : String(error));
    if (app) console.error("server logs (tail):\n" + app.logs());
  } finally {
    if (app) app.child.kill();
    await fake.close();
    await rm(storeDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log("\n=== Account dashboard e2e results ===");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "ALL PASSED" : `${failed.length} FAILED`} (${results.length} checks)`);
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
