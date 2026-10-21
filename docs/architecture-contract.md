# Architecture Contract — personal-antigravity-api

Version: 1.1 (frozen for the 3-agent build + account-dashboard wave) · Owner: coordinator · Status: FROZEN

## 0. How to use this document

Every agent MUST read this document fully before writing code. It is the single
source of truth for interfaces, ownership, conventions and deliverables.

- You are the sole owner of your file zone (see §3). Do not create, edit or delete
  files outside it — one exception: `docs/handoffs/<your-agent-id>.md` (yours only).
- "Frozen" files belong to the coordinator. Never modify them. If you believe a
  change is required, put it in your handoff under "Integration requirements".
- If this contract and your task prompt conflict, the contract wins; note the
  conflict in your handoff.
- Never silently deviate. A documented blocker beats a silent workaround.

## 1. Project objective and non-goals

Objective: a personal, OpenAI-compatible REST gateway backed by an Antigravity
provider, inspired by the architecture of Oh My Pi (OMP,
https://github.com/can1357/oh-my-pi). TypeScript + Fastify + SSE, deployed natively
(no Docker) to Render Free with UptimeRobot heartbeats.

Non-goals: no frontend, no Docker/Docker Compose, no paid services, no database,
no multi-tenant auth, no circumvention of provider restrictions.

Hard risk statement (repeat it in docs you write): Antigravity OAuth through
third-party applications is unofficial and may violate Google's Terms of Service;
account suspension is possible. The live Antigravity path ships as
EXPERIMENTAL/UNVERIFIED unless actually tested against live credentials. Antigravity is the only supported runtime provider.

## 2. Stack and conventions

| Item | Decision |
| --- | --- |
| Runtime | Node.js >= 20 (dev machine: Node 24, Windows) |
| Language | TypeScript, `strict: true`; emits CommonJS (`module: Node16` in tsconfig — relative imports without extension are fine) |
| HTTP | Fastify 5 (+ @fastify/cors, @fastify/rate-limit preinstalled) |
| Validation | zod (env config); hand-written validation in the API layer |
| Tests | Vitest (`npm test` = `vitest run`), files `tests/**/*.test.ts` |
| Build | `npm run build` -> `dist/` (tsc); `npm start` -> `node dist/server.js` |
| Deps | Preinstalled and frozen in package.json / package-lock.json. Do NOT add deps or edit package.json — request changes via handoff. |
| Style | 2-space indent, named exports only, `import type` for types, no `any` (use `unknown` + narrowing), no `console.log` in src (use `app.log`/injected logger) |
| Secrets | Never in code, logs, tests, commits or docs. Env vars only. |

All agents share the same scripts: `npm run typecheck`, `npm test`, `npm run build`.

## 3. File ownership map (frozen)

| Zone | Owner | Notes |
| --- | --- | --- |
| package.json, package-lock.json, tsconfig.json, tsconfig.build.json, .gitignore, README.md, docs/architecture-contract.md, src/types/** | coordinator | FROZEN for agents |
| src/app.ts, src/server.ts, src/api/**, src/routes/**, src/core/**, src/admin/**, tests/api/**, tests/admin/** | antigravity-api-agent | replaces scaffold placeholders src/app.ts + src/server.ts; owns the dashboard routes/UI |
| src/providers/**, tests/providers/**, docs/omp-analysis.md | antigravity-provider-agent | replaces stub src/providers/index.ts; owns account credential lifecycle + OAuth service |
| src/config/**, src/middleware/**, src/security/**, tests/config/**, tests/security/**, docs/deployment.md, docs/security.md, render.yaml, .env.example | antigravity-deployment-agent | replaces stubs src/config/env.ts + src/middleware/index.ts; owns credential-store backends, session store, CSRF, login limiter |
| scripts/smoke-account.mjs (v1.1) | coordinator | new e2e script; scripts/** coordinator-owned |
| docs/handoffs/<agent-id>.md | each agent | your own file only |
| tests/smoke.test.ts | coordinator | do not modify |

Files marked PLACEHOLDER/STUB in their header belong to the zone that replaces
them. Everything else stays.

## 4. Runtime architecture

Composition root (src/server.ts):

1. `loadConfig()` (src/config/env.ts) -> AppConfig
2. `createProviderFromConfig(config.provider)` (src/providers/index.ts) -> AIProvider
3. `buildApp({ config, provider, usageTracker })` (src/app.ts) -> FastifyInstance (routes only)
4. `registerSecurityPlugins(app, config)` (src/middleware/index.ts) -> CORS, auth, rate limit, error handler
5. `app.listen({ host: config.host, port: config.port })` — host `"0.0.0.0"`, port `Number(process.env.PORT || 3000)`

Request flow (chat): genReqId `req_<uuid>` -> security hooks -> route validation ->
normalize to NormalizedChatRequest (AbortSignal bound to client disconnect) ->
`provider.chat()` event stream -> SSE frames (stream) or aggregation (non-stream) ->
`usageTracker.record()` -> response.

Directory intent:
- `src/api/**` — OpenAI wire handling: validation, normalization, response/SSE encoding, error envelope
- `src/routes/**` — route registration: /v1/chat/completions, /v1/models, /usage, /health
- `src/core/**` — plumbing: UsageTracker, id generation, event-to-chunk mapping, error mapping
- `src/providers/**` — AIProvider implementation (antigravity) and registry
- `src/middleware/**`, `src/security/**`, `src/config/**` — security, env validation, credential handling

## 5. Shared types

Authoritative definitions: `src/types/provider.ts`, `src/types/config.ts`,
`src/types/openai.ts` — read them; never duplicate them.

Key rules:
- `AIProvider.chat()` returns `AsyncIterable<ProviderEvent>` with strict ordering:
  one `start` first; then `delta`/`tool_call_delta`; optional `usage`; exactly one
  terminal `done` or `error`; nothing after a terminal event; safe to abandon
  iteration early (client disconnect / cancellation).
- Cancellation: the API layer creates an AbortController, passes `signal` inside the
  NormalizedChatRequest, aborts it on client disconnect. Providers must stop
  upstream work when the signal fires.
- Errors: providers either throw `ProviderError` or yield a terminal `error` event
  with a canonical `code` (mapping in §8). The API layer maps, never leaks raw 500s
  when a mapping exists.
- Usage counts are camelCase in ProviderEvents (`promptTokens`, ...); the API layer
  converts to OpenAI snake_case on the wire.

## 6. Environment variables (frozen names/defaults)

| Var | Default | Notes |
| --- | --- | --- |
| NODE_ENV | development | `production` enforces API_KEYS |
| HOST | 0.0.0.0 | Render requires 0.0.0.0 |
| PORT | 3000 | Render injects its own |
| LOG_LEVEL | info | pino level |
| API_KEYS | (unset) | comma-separated; REQUIRED in production (fail fast); unset in dev -> implicit `dev-local-key` + warning |
| RATE_LIMIT_WINDOW_MS | 60000 | fixed window |
| RATE_LIMIT_MAX | 60 | `0` disables rate limiting |
| CORS_ORIGINS | * | comma list or `*` |
| TRUST_PROXY | false | set `true` on Render |
| PROVIDER_MODE | antigravity | `antigravity` only |
| ANTIGRAVITY_ACCESS_TOKEN | — | optional, short-lived |
| ANTIGRAVITY_REFRESH_TOKEN | — | preferred persistent credential (Render env var) |
| ANTIGRAVITY_CLIENT_ID | — | optional |
| ANTIGRAVITY_CLIENT_SECRET | — | optional |
| ANTIGRAVITY_PROJECT_ID | — | optional |
| ANTIGRAVITY_ENDPOINT | provider default | base URL override |
| ANTIGRAVITY_TOKEN_STORE_PATH | ./.data/antigravity-token.json | optional on-disk cache; Render disk is EPHEMERAL |

`AppConfig` in src/types/config.ts mirrors this exactly.

## 7. HTTP API contract (OpenAI-compatible)

Public route: `GET /health` (no auth; cheap; NO provider calls; 200 while the
process lives). Every other route requires `Authorization: Bearer <apiKey>`.
CORS preflight (OPTIONS) is always public.

Error envelope (all routes):
HTTP status + `{"error":{"message":string,"type":string,"param":string|null,"code":string|null}}`.

Endpoints:
1. `POST /v1/chat/completions` — OpenAI-compatible request/response; SSE when body `stream:true`.
2. `GET /v1/models` -> `{"object":"list","data":[...ModelInfo]}`
3. `GET /usage` -> `{"object":"usage","data":{"requests":n,"prompt_tokens":n,"completion_tokens":n,"total_tokens":n,"by_model":{"<model>":{"requests":n,"prompt_tokens":n,"completion_tokens":n,"total_tokens":n}},"since":<epoch ms>,"provider":<UsageInfo|null>}}`
4. `GET /health` -> `{"status":"ok","version":"0.1.0","uptime":<sec>,"timestamp":<iso>,"provider":{"mode":"antigravity"}}`

Request validation (POST /v1/chat/completions):
- `model`: required non-empty string.
- `messages`: required non-empty array; roles system|user|assistant|tool|developer
  (developer -> system); content string | array of content parts | null; text
  parts in an array are flattened to a string, image parts are kept as
  multimodal parts (audio is rejected — the upstream is text+image only);
  `tool_calls` / `tool_call_id` accepted.
- `response_format`: optional; `json_object` or `json_schema` (with
  `json_schema.schema` as a JSON Schema). Anything else -> 400 code
  `invalid_request`.
- `stream`: boolean, default false.
- `temperature` 0..2; `top_p` 0..1; `max_tokens`/`max_completion_tokens` positive
  int (`max_completion_tokens` wins if both); `stop` string|string[] normalized to
  string[]; `tools`/`tool_choice` validated structurally, passed through.
- Tool messages (`role: "tool"`) must carry `tool_call_id` (or `name`) so the
  upstream function name can be resolved; otherwise the provider rejects the
  request with code `invalid_request`.
- Unknown fields ignored. `n > 1` -> 400 code `unsupported_parameter`.
- 400 envelope: type `invalid_request_error`, `param` names the offending field.

SSE format (stream:true):
Headers `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache`,
`X-Accel-Buffering: no`. Frames `data: <json>\n\n`, final `data: [DONE]\n\n`.
Chunks are OpenAI `chat.completion.chunk` (see src/types/openai.ts): first chunk
`delta:{"role":"assistant"}`; then content deltas; final content chunk carries
`finish_reason`; with `stream_options.include_usage:true` one extra chunk with empty
`choices` + `usage` before `[DONE]`. Optional `: keep-alive\n\n` heartbeat every
~15s. Mid-stream failure: `data: {"error":{...}}\n\n` then `[DONE]`.

Non-stream response: `{id,object:"chat.completion",created,model,choices:[{index:0,message:{role:"assistant",content,tool_calls?},finish_reason}],usage:{prompt_tokens,completion_tokens,total_tokens}}`.

Auth & rate limiting semantics (implemented by deployment agent; assumed by API agent):
- Missing/incorrect key -> 401, type `invalid_request_error`, code `invalid_api_key`.
- Limit exceeded -> 429, type `rate_limit_error`, code `rate_limit_exceeded`,
  `Retry-After` seconds; per-key when authenticated, else per-IP; `RATE_LIMIT_MAX=0`
  disables. All responses set `x-request-id` (fastify reqId).

## 8. Mapping rules

ProviderEvent -> OpenAI chunk (streaming): `start` -> first chunk; `delta` ->
`delta:{content}`; `tool_call_delta` -> `delta:{tool_calls:[...]}`; `usage` ->
recorded (emitted only with include_usage); `done` -> chunk with `finish_reason`
(map `error`->`stop`) then `[DONE]`; `error` -> error path.

Tool calling (Antigravity provider; live-verified 2026-10-21):
- `tools` -> one upstream `tools: [{ functionDeclarations: [...] }]` group;
  parameters are sanitized first (local `$ref`s inlined, keywords the Cloud
  Code Assist schema proto rejects removed).
- `tool_choice`: `auto`/unset -> `toolConfig.functionCallingConfig.mode =
  "VALIDATED"`; `required` and a named function -> mode `"ANY"` (plus
  `allowedFunctionNames` for the named form) and a forced-tool directive
  appended to the transcript, because the backend drops `toolConfig` on its
  Gemini routes; `none` -> the tools are not declared at all, because the
  backend ignores mode `"NONE"` and still emits calls.
- assistant `tool_calls` -> upstream `functionCall` parts (name, args, id);
  `role: "tool"` messages -> `functionResponse` parts (`response.output`) in a
  single user turn.
- upstream `functionCall` parts -> `tool_call_delta` events with an incrementing
  index; a turn that emitted tool calls finishes with `finish_reason:
  "tool_calls"` (the upstream itself reports `STOP`).
- the upstream signs every function call with a `thoughtSignature` that must be
  replayed as a SIBLING of `functionCall` — nesting it inside `functionCall` is
  rejected ("Unknown name thoughtSignature") and omitting it is rejected
  ("Function call is missing a thought_signature"). The provider keeps the
  signature in memory, keyed by tool call id, and replays it with the follow-up
  request.

Vision and structured output (Antigravity provider; live-verified 2026-10-22):
- an image content part becomes an upstream `inlineData` part (base64 data URL)
  or a `fileData` part (http(s) URL — the upstream fetches it; the gateway
  never fetches a client-supplied URL). Limits: 8 MB per image, 25 MB request.
- `response_format: json_object` -> `generationConfig.responseMimeType =
  "application/json"`; `json_schema` additionally sends
  `generationConfig.responseSchema`, converted to the provider's schema
  dialect (uppercase type names, fields outside the schema proto dropped,
  local `$ref`s inlined, at most 5 levels of nesting).
- in JSON mode the gateway strips a Markdown fence the upstream may add around
  the payload, so `JSON.parse(message.content)` succeeds as with OpenAI.

Provider error code -> HTTP:

| Provider code | HTTP | type | code |
| --- | --- | --- | --- |
| invalid_request | 400 | invalid_request_error | as given |
| unauthorized | 502 | api_error | provider_auth_error (upstream creds problem) |
| not_found | 404 | invalid_request_error | model_not_found |
| rate_limited | 429 | rate_limit_error | rate_limit_exceeded |
| timeout | 504 | api_error | upstream_timeout |
| aborted | 499 or just close if streaming | — | client_closed_request |
| upstream_error | 502 | api_error | upstream_error |
| not_implemented | 501 | server_error | not_implemented |
| unknown | 500 | server_error | internal_error |

## 9. Integration seams (frozen signatures)

- `loadConfig(env?: NodeJS.ProcessEnv): AppConfig` — src/config/env.ts (deployment agent).
- `createProviderFromConfig(config: ProviderConfig): AIProvider` — src/providers/index.ts (provider agent).
- `buildApp(options: BuildAppOptions): Promise<FastifyInstance>` with
  `BuildAppOptions = { config: AppConfig; provider: AIProvider; usageTracker: UsageTracker }`
  — src/app.ts (api agent); `UsageTracker` lives in src/core/ and is exported for server.ts.
- `registerSecurityPlugins(app: FastifyInstance, config: AppConfig): Promise<void>` —
  src/middleware/index.ts (deployment agent). Called AFTER buildApp, BEFORE listen;
  root-scope hooks apply globally even to already-registered routes. Auth applies to
  all routes except `GET /health` and `OPTIONS *`.
- API agent: src/app.ts must NOT implement auth/CORS/rate limiting itself; tests call
  routes without auth headers.

Worktrees are isolated, so agents test cross-zone seams against scaffold stubs where
necessary; the coordinator re-runs the full matrix after merge-back.

## 10. Testing rules

- Vitest only; no network in tests (inject fetch stubs for provider HTTP; `app.inject()` for routes).
- No live credentials, no paid calls, no sleeps > 100ms; deterministic.
- Minimums per agent:
  - provider (>= 8): Antigravity behavior (stream deltas, usage, abort), token refresh
    with fake fetch, upstream SSE parsing, error mapping, abort behavior.
  - api (>= 10): /v1/models, non-stream chat, stream chunk sequence + [DONE],
    validation 400s (3+), mid-stream error frame, /usage accumulation, one real-port
    disconnect test (AbortController + fetch).
  - deployment (>= 12): auth 401/200, rate limit 429 + window reset + disable flag,
    env validation (production without API_KEYS fails fast; bad numbers fail), CORS
    preflight, observable log redaction, token store roundtrip in a temp dir.

## 11. Git, delivery, handoff

- You work in your own git worktree on your own branch. Commit with messages
  `feat(<agent-id>): ...` / `test(<agent-id>): ...`.
- Do NOT merge, rebase, push, switch branches, or touch files outside your zone.
- Do NOT modify frozen files (§3). Do NOT run `npm install <pkg>`.
- Before finishing: `npm run typecheck`, `npm test`, `npm run build` must pass in
  your worktree — or the failures go in your handoff.
- Write your handoff to `docs/handoffs/<agent-id>.md` AND return it as your final
  message (under ~80 lines):

# Handoff — <agent-id>
- Branch: <branch> @ <sha>
- Files created/modified
- Features implemented
- Tests performed (commands + observed results)
- Known limitations
- Integration requirements (incl. requested dependency/config changes)
- Verified vs unverified

## 12. Quota discipline, honesty, safety

- Exactly the delegated work: no sub-agents, no delegation, no team simulation.
- Two retries max per failing command, then stop and document the blocker + partial
  result. No autonomous fix loops.
- Research budget: provider agent <= 15 OMP fetches; other agents make none.
- "Verified" = you ran it and saw it pass. Never claim untested behavior works —
  especially live Antigravity OAuth, which is UNVERIFIED here. Provider behavior must be
  covered using isolated test fixtures.
- The Google ToS/account-risk statement must appear in docs touching the live path.
- No Docker, no paid services, no cloud resources, no publishing/deploying.

---

## 13. Amendment v1.1 — Account Management Dashboard (FROZEN)

Minimal, secure admin dashboard for managing the personal Antigravity account
connection. No frontend framework and no build step: server-rendered HTML strings
with plain forms (POST-redirect-GET) plus JSON responses for automation.

### 13.1 Hard rules
- NEVER expose access tokens, refresh tokens, client secrets, or encryption keys
  to the browser or to any API client. Status payloads use a whitelist of fields.
  Tests MUST assert that a sentinel secret never appears in any response
  body or header.
- The dashboard is DISABLED (a static "not configured" page for `/admin`) unless
  an admin password is configured (`ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH`).
- Admin auth = password + server-side session cookie. Bearer API keys are NOT
  valid for `/admin`; the admin session is NOT valid for `/v1/**` or `/usage`.
- Browser account connect uses only standard Google OAuth 2.0 mechanics
  (Authorization Code + PKCE) with the operator's own OAuth client. When Google
  rejects the client/scopes, show the provider error clearly ("browser connect
  not technically supported for this client") and keep the manual refresh-token
  path available. Never bypass or evade provider restrictions.

### 13.2 Endpoints (same-origin; `session` = admin cookie; `csrf` = required on state-changing POSTs)
| Route | Method | Auth | CSRF | Purpose |
| --- | --- | --- | --- | --- |
| `/admin` | GET | none | — | login page, or redirect to `/admin/dashboard` when session exists |
| `/admin/login` | POST (form) | none (rate-limited per IP) | — | verify password, create session (new id + CSRF token), set cookie, redirect |
| `/admin/logout` | POST | session | ✅ | destroy session, clear cookie, redirect |
| `/admin/dashboard` | GET | session | — | HTML status page + action forms + flash |
| `/admin/api/status` | GET | session | — | JSON: account/provider status, credential store health, OAuth config state (no tokens) |
| `/admin/actions/connect` | POST | session | ✅ | start browser OAuth: create one-time state + PKCE verifier (server-side), 302 to authorize URL (or JSON `{authorizeUrl}` when `Accept: application/json`) |
| `/admin/oauth/callback` | GET | session + valid one-time state | — | exchange code server-side, store credentials, redirect to dashboard with flash |
| `/admin/actions/manual-credentials` | POST | session | ✅ | save operator-supplied {refreshToken, clientId?, clientSecret?, projectId?} AFTER validating via test refresh; clear error on failure |
| `/admin/actions/reconnect` | POST | session | ✅ | force token refresh now; report result |
| `/admin/actions/disconnect` | POST | session | ✅ | delete stored credentials (store + provider runtime state) |

POSTs answer HTML redirects (form flow) or JSON when `Accept: application/json`.
Flash messages are one-time (server-side, in-memory).

### 13.3 Account states shown on the dashboard
- `disconnected` — nothing stored; chat calls return mapped `provider_auth_error`.
- `connected` — refresh token stored; access token auto-refreshes (60 s skew).
- `needs_reconnect` — refresh rejected (`invalid_grant`/401); dashboard shows a
  clear "Reconnect required" banner + last error; chat calls keep failing with a
  message pointing to the dashboard.
- Access-token expiry is displayed when known; account change (switch) =
  `disconnect` then `connect` again — NO redeploy required when the credential
  store is durable (redis backend).

### 13.4 Browser connect workflow (when technically supported)
1. `POST /admin/actions/connect` (session + CSRF) → server creates `state` +
   PKCE `code_verifier` (stored in-memory, TTL 10 min, single-use) and returns the
   Google authorize URL (PKCE S256, scope list from configuration).
2. Browser navigates to Google; operator consents.
3. Google redirects to `GET /admin/oauth/callback?code&state` (redirect URI =
   `OAUTH_REDIRECT_BASE_URL` + `/admin/oauth/callback`, or derived from the
   request host when unset).
4. Server validates `state` (session-bound, single-use), exchanges code server-
   side, derives `accountHint` (masked email from the id_token payload — no
   token is forwarded anywhere), stores credentials via the CredentialStore.
5. Redirect to dashboard with flash "Account connected".
6. If `code`/`error` from Google: show the exact provider error message; keep
   the manual path available.

### 13.5 Manual credential path (always available)
Paste refresh token (+ optional clientId/clientSecret/projectId). The server
validates by attempting one refresh against the token endpoint; only on success
is anything stored. Failures produce clear, redacted messages.

### 13.6 Persistence requirements
- Credential blob is AES-256-GCM encrypted at rest (key from
  `CREDENTIAL_ENCRYPTION_KEY` via scrypt with a per-record salt); the plaintext
  refresh token MUST never hit disk or Redis.
- Backends: `file` (local dev; `CREDENTIAL_FILE_PATH`, best-effort chmod 600) and
  `redis` (any Redis-compatible URL in `REDIS_URL` — e.g. a free Render Key Value
  instance; survives restarts/sleeps/redeploys → enables account changes without
  redeploy). `auto` = redis when `REDIS_URL` is set, else file. The deployment
  docs must state that `file` on Render Free is ephemeral (credentials lost on
  restart → reconnect via dashboard) and that `redis` is the durable option.
- Sessions are in-memory (lost on restart → re-login; acceptable, documented).

## 14. Amendment v1.1 — new environment variables (frozen names)

| Var | Default | Notes |
| --- | --- | --- |
| `DASHBOARD_ENABLED` | `auto` | `auto` = enabled iff an admin password is set; `true`/`false` force it |
| `ADMIN_PASSWORD` | — | plaintext admin password (dev convenience / simple deploys) |
| `ADMIN_PASSWORD_HASH` | — | preferred: `scrypt$N$r$p$<saltB64>$<hashB64>`; generate with `node scripts/hash-admin-password.mjs` |
| `ADMIN_SESSION_TTL_MS` | `43200000` | session + cookie TTL (12 h), sliding |
| `ADMIN_LOGIN_WINDOW_MS` | `300000` | login-attempt rate-limit window |
| `ADMIN_LOGIN_MAX` | `5` | max login attempts per window per IP, then 429 |
| `CREDENTIAL_STORE` | `auto` | `auto` \| `file` \| `redis` (auto = redis iff `REDIS_URL` set) |
| `REDIS_URL` | — | `redis://` or `rediss://`; free Render Key Value instance or any external Redis |
| `CREDENTIAL_FILE_PATH` | `./.data/credential-store.json` | file backend path (local dev) |
| `CREDENTIAL_ENCRYPTION_KEY` | — | base64 32 bytes or passphrase; REQUIRED when the dashboard is enabled (fail closed) |
| `OAUTH_REDIRECT_BASE_URL` | derived from request host | public base URL for the OAuth callback (set on Render, e.g. `https://app.onrender.com`) |
| `ANTIGRAVITY_OAUTH_SCOPES` | documented default set | space/comma list; default `openid email https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email` (UNVERIFIED — adjust per account) |
| `ANTIGRAVITY_OAUTH_AUTH_ENDPOINT` | `https://accounts.google.com/o/oauth2/v2/auth` | override (test seam) |
| `ANTIGRAVITY_OAUTH_TOKEN_ENDPOINT` | `https://oauth2.googleapis.com/token` | override (test seam); replaces the TokenManager hard-coded const when set |

Fail-closed rules (deployment agent implements in zod schema):
- dashboard enabled (explicit `true`, or `auto` + password present) requires `CREDENTIAL_ENCRYPTION_KEY`.
- `DASHBOARD_ENABLED=true` requires `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH`.
- `CREDENTIAL_STORE=redis` requires `REDIS_URL`.
- `AppConfig` gains `admin`, `credentials`, `oauth` sections (src/types/config.ts).

## 15. Amendment v1.1 — new integration seams (frozen signatures)

- `createCredentialStore(config: CredentialStoreConfig, logger?: AppLogger): CredentialStore`
  — src/security/credential-store.ts (deployment agent). `CredentialStore` interface in
  src/types/admin.ts. Stub in scaffold: in-memory.
- `createSessionStore(): SessionStore` — src/security/session-store.ts (deployment agent).
  In-memory, TTL + sliding refresh, cap 1000, id + csrfToken via crypto randomness.
- src/security/csrf.ts (deployment agent) exports:
  `generateCsrfToken(): string`, `verifyCsrfToken(expected: string, provided: string | undefined): boolean` (timing-safe).
- `createFixedWindowLimiter(opts: { windowMs: number; max: number }): (key: string) => { allowed: boolean; retryAfterSeconds: number; remaining: number; limit: number }`
  — exported from src/middleware/rate-limit.ts (deployment agent); used by the global
  hook AND by the admin login gate.
- `createOAuthService(opts: OAuthServiceOptions): OAuthService` — src/providers/oauth.ts
  (provider agent). Options: `{ clientId?, clientSecret?, scopes: string[],
  authEndpoint?, tokenEndpoint?, fetch? }`. Google endpoints, PKCE S256. Stub in
  scaffold: throws `not_implemented`.
- `createProviderFromConfig(config: ProviderConfig, deps?: { credentialStore?: CredentialStore }): AIProvider`
  — additive 2nd param (provider agent). Runtime credential changes via the store must
  take effect without restart.
- `AIProvider.getAccountStatus?(): Promise<AntigravityAccountStatus>` — OPTIONAL additive
  method (types in src/types/admin.ts); implemented by AntigravityProvider; the admin
  layer falls back to mode-based status when absent (e.g. injected test providers).
- **Auth hook bypass rule**: the Bearer auth hook skips exactly: `GET /health`,
  `OPTIONS *`, and ALL `/admin*` paths. `/admin` has its own session auth inside the
  admin plugin (login page + `POST /admin/login` + `GET /admin/oauth/callback` are the
  only session-less endpoints and are strictly rate-limited). `/v1/**` and `/usage`
  keep requiring the Bearer key. `BuildAppOptions` gains optional
  `admin?: { sessionStore: SessionStore; credentialStore: CredentialStore; oauthService: OAuthService }`
  — mounted only when provided AND `config.admin.enabled`.
- Admin routes answer HTML by default and JSON when `Accept: application/json` for
  `/admin/api/*` GETs (status is JSON-only) and the action POSTs.

## 16. Amendment v1.1 — test minimums and e2e

- provider (>= +10 new): authorize URL shape (endpoint/scope/state/challenge), PKCE
  S256 verifier/challenge, code exchange with fake fetch (incl. id_token accountHint
  decode), test-refresh success/failure mapping, credential swap via store without
  restart, needs_reconnect transitions, token-endpoint env override respected.
- api (>= +14 new, tests/admin/**): login ok/wrong password/rate-limit 429, session
  cookie attributes (HttpOnly, SameSite=Lax, Path=/), CSRF 403 on every POST without
  token, status JSON field whitelist + sentinel-token never in body/headers of ALL
  admin responses, connect start (configured vs not configured), callback state
  mismatch/expired rejected, manual-credentials validation failure keeps store
  untouched, disconnect clears, dashboard disabled mode, redirect-after-POST flows.
- deployment (>= +12 new): credential-store file roundtrip + ciphertext-at-rest
  (plaintext sentinel must NOT appear in the file), clear(), redis-lite against a
  scripted fake RESP TCP server (PING/GET/SET/DEL/AUTH; `redis://` URL parse; error
  surfacing), session store lifecycle + TTL + regenerate, csrf verify mismatch,
  limiter window reset, auth bypass matrix (/admin passthrough, /v1 still 401
  without key, /usage still 401), new env fail-closed cases.
- coordinator e2e (`scripts/smoke-account.mjs`): boots the built server with a fake
  Google OAuth server (token endpoint override), runs the COMPLETE account workflow:
  admin login → status disconnected → connect start → callback with state+code →
  connected (store updated; plaintext token nowhere) → status shows accountHint →
  reconnect (fake token endpoint hit again) → disconnect → status disconnected →
  CSRF 403 → login 429 → Bearer still required on /v1. This is the user-required
  "complete account-management workflow" test.

Also update §12's no-new-deps rule note: this wave still adds ZERO dependencies
(node:crypto/net/tls/fetch only).

## Admin model routing settings (2026-10-21)

The admin-selected model and thinking level now replace the fixed model route.
AIProvider exposes optional getModelSettings, discoverModels, and updateModelSettings
methods. GET /v1/models lists the current public model; client model fields remain
overridden by the gateway selection. Each chat snapshots settings before token
resolution, preserving its selection through retries and streaming.

POST /admin/actions/models discovers compatible account text models.
POST /admin/actions/model-settings validates the selection against that catalog,
persists it, then activates it. Both require an admin session plus CSRF and
return Cache-Control: no-store. Failed validation or persistence retains the
previous selection. Settings use a separate non-secret file or Redis key and
do not change credential payloads. Saves are serialized per process; multiple
server instances are not synchronized. See README.md for model-specific thinking
behavior and persistence limitations.
