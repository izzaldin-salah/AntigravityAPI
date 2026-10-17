# Handoff — antigravity-api-agent

- Branch: `t3/7f7f9b33` @ `6e1ddea`
- Files created/modified:
  - `src/admin/auth.ts` (created): password verification (plaintext SHA-256 + scrypt), session cookie helpers
  - `src/admin/oauth-state.ts` (created): in-memory single-use PKCE/state manager with 10m TTL
  - `src/admin/pages.ts` (created): HTML templates (disabled, login, dashboard, error), inline CSS, XSS escaping
  - `src/admin/routes.ts` (created): 10 endpoints for account management, CSRF validation, rate limiting, flash
  - `src/admin/index.ts` (created): plugin entry point registering contract §13.2 endpoints
  - `src/app.ts` (modified): Fastify x-www-form-urlencoded parser, admin plugin mounting and disabled fallback
  - `src/server.ts` (modified): wiring credential store, session store, OAuth service, provider deps, startup warning
  - `tests/admin/admin.test.ts` (created): 17 comprehensive tests for admin dashboard, sentinel leak, CSRF, auth

## Features Implemented
- **Account Management Dashboard (`src/admin/**`)**:
  - `GET /admin`: Static disabled page when disabled; login form or 302 redirect to `/admin/dashboard` when active.
  - `POST /admin/login`: Fixed-window IP rate limit (`429` + `Retry-After`); constant-time timing-safe password verification (plaintext SHA-256 & `scrypt$N$r$p$<saltB64>$<hashB64>`); session cookie issuance (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when HTTPS).
  - `POST /admin/logout`: Requires session + CSRF (`x-csrf-token` header or `csrf_token` body); destroys session, clears cookie (`Max-Age=0`), 302 redirect.
  - `GET /admin/dashboard`: Server-rendered HTML dashboard with status badge, metadata grid, action forms, flash banner, and unverified OAuth risk notice. No client JS or external assets.
  - `GET /admin/api/status`: Strict field whitelist (`enabled`, `providerMode`, `provider`, `credentials`, `oauth`). Synthesizes status when provider lacks `getAccountStatus`. Zero tokens exposed.
  - `POST /admin/actions/connect`: Validates OAuth service config (returns clear 400 listing options if unconfigured); generates 24-byte state + PKCE S256 code verifier/challenge; answers 302 redirect or JSON `{authorizeUrl}`.
  - `GET /admin/oauth/callback`: Validates and consumes single-use state; handles Google error params; exchanges code server-side and persists credentials to store; flashes status and redirects.
  - `POST /admin/actions/manual-credentials`: Validates refresh token with `oauthService.testRefresh` before storing; never stores on failure; redacts tokens in error messages; persists on success.
  - `POST /admin/actions/reconnect`: Re-validates stored credentials via `testRefresh` and reports status without leaking tokens.
  - `POST /admin/actions/disconnect`: Clears credential store and flashes disconnection confirmation.
- **Wiring & Integration (`src/app.ts`, `src/server.ts`)**:
  - Registered core `application/x-www-form-urlencoded` parser using Node `URLSearchParams`.
  - Wired `createCredentialStore`, `createSessionStore`, `createOAuthService`, and passed admin deps to `buildApp`.
  - Added Render ephemeral file-storage startup warning in production when `REDIS_URL` is unset.

## Tests Performed
- `npm run typecheck`: Passed with 0 errors (`tsc -p tsconfig.json --noEmit`).
- `npm run build`: Passed cleanly (`tsc -p tsconfig.build.json` -> `dist/`).
- `npm test`: 13 test files passed, 88/88 tests passed:
  - 17 new tests in `tests/admin/admin.test.ts`: disabled page (200/404), login success & cookie attributes, scrypt hash login, invalid password (401), rate-limit gate (429 + Retry-After), CSRF validation (403 on missing/wrong tokens across all POSTs), SENTINEL leak prevention (asserts `SENTINEL_TOKEN_DO_NOT_LEAK` never appears in bodies/headers), status JSON whitelist & synthesis, connect flow (unconfigured vs configured), callback (state validation, single-use consume, Google errors, code exchange), manual credentials (failure does not touch store, success updates store), reconnect, disconnect, logout, and form-flow POST-redirect-GET with flash consume-once.
  - All 71 existing test cases in `tests/api/**`, `tests/security/**`, `tests/providers/**`, `tests/config/**`, and `tests/smoke.test.ts` remain green.

## Known Limitations
- Session store and pending OAuth state map are in-memory (sessions invalidate across server restarts).
- Provider credential re-reads rely on provider agent implementing lazy refresh via the store on next chat request.

## Integration Requirements
- Zero new dependencies added (uses Node built-ins: `crypto`, `URLSearchParams`).
- Provider agent's `createProviderFromConfig` signature accepts optional `deps: { credentialStore, tokenEndpoint }`.
- Deployment agent's auth hook bypasses `/admin*` routes per architecture contract §15.

## Verified vs Unverified
- **Verified**: Fastify admin dashboard, password/scrypt auth, CSRF, IP rate-limiting, cookie lifecycle, OAuth state/PKCE lifecycle, sentinel secrecy, error redaction, and in-memory credential persistence workflows under automated mock testing.
- **UNVERIFIED / EXPERIMENTAL**: Live Google OAuth and Antigravity provider integration. Antigravity OAuth through third-party applications is unofficial and may violate Google's Terms of Service; account suspension is possible.
