# Architecture Contract — personal-antigravity-api

Version: 1.0 (frozen for the 3-agent build) · Owner: coordinator · Status: FROZEN

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
EXPERIMENTAL/UNVERIFIED unless actually tested against live credentials. Mock mode
is the fully verified default.

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
| src/app.ts, src/server.ts, src/api/**, src/routes/**, src/core/**, tests/api/** | antigravity-api-agent | replaces scaffold placeholders src/app.ts + src/server.ts |
| src/providers/**, tests/providers/**, docs/omp-analysis.md | antigravity-provider-agent | replaces stub src/providers/index.ts; may extend src/types/provider.ts additively only |
| src/config/**, src/middleware/**, src/security/**, tests/config/**, tests/security/**, docs/deployment.md, docs/security.md, render.yaml, .env.example | antigravity-deployment-agent | replaces stubs src/config/env.ts + src/middleware/index.ts |
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
- `src/providers/**` — AIProvider implementations (mock + antigravity) and registry
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
| PROVIDER_MODE | mock | `mock` or `antigravity` |
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
4. `GET /health` -> `{"status":"ok","version":"0.1.0","uptime":<sec>,"timestamp":<iso>,"provider":{"mode":"mock|antigravity"}}`

Request validation (POST /v1/chat/completions):
- `model`: required non-empty string.
- `messages`: required non-empty array; roles system|user|assistant|tool|developer
  (developer -> system); content string|null; `tool_calls` / `tool_call_id` accepted.
- `stream`: boolean, default false.
- `temperature` 0..2; `top_p` 0..1; `max_tokens`/`max_completion_tokens` positive
  int (`max_completion_tokens` wins if both); `stop` string|string[] normalized to
  string[]; `tools`/`tool_choice` validated structurally, passed through.
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
  - provider (>= 8): mock determinism (stream deltas, usage, abort), token refresh
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
  especially live Antigravity OAuth, which is UNVERIFIED here. Mock mode must be
  fully tested.
- The Google ToS/account-risk statement must appear in docs touching the live path.
- No Docker, no paid services, no cloud resources, no publishing/deploying.
