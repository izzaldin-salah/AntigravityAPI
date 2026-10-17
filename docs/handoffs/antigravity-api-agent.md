# Handoff — antigravity-api-agent

- Branch: `t3/e7d98298` @ `a05141f`
- Files created/modified:
  - Modified:
    - `src/app.ts`
    - `src/server.ts`
  - Created:
    - `src/core/usage-tracker.ts`
    - `src/core/errors.ts`
    - `src/core/id.ts`
    - `src/core/chunk-mapper.ts`
    - `src/core/index.ts`
    - `src/api/validation.ts`
    - `src/api/index.ts`
    - `src/routes/health.ts`
    - `src/routes/models.ts`
    - `src/routes/usage.ts`
    - `src/routes/chat.ts`
    - `src/routes/index.ts`
    - `tests/api/mock-provider.ts`
    - `tests/api/api.test.ts`
    - `tests/api/EXAMPLES.md`
    - `docs/handoffs/antigravity-api-agent.md`

## Features Implemented
1. **Core Utilities (`src/core/**`)**:
   - `UsageTracker`: In-memory usage accounting with total and per-model counts (`requests`, `prompt_tokens`, `completion_tokens`, `total_tokens`) and process start epoch timestamp (`since`).
   - `OpenAIErrorBody` formatting & `mapProviderErrorToHttp`: Complete mapping of canonical provider error codes (`invalid_request` -> 400, `unauthorized` -> 502 `provider_auth_error`, `not_found` -> 404 `model_not_found`, `rate_limited` -> 429 `rate_limit_exceeded`, `timeout` -> 504 `upstream_timeout`, `aborted` -> 499 `client_closed_request`, `upstream_error` -> 502 `upstream_error`, `not_implemented` -> 501 `not_implemented`, `unknown` -> 500 `internal_error`).
   - Chat completion ID generation (`chatcmpl-<uuid_no_hyphens>`) using `node:crypto.randomUUID()`.
   - Streaming SSE chunk transformers: role chunk (`delta: { role: "assistant" }`), content chunk, tool call chunk, finish reason chunk (mapping provider `error` finishReason to `stop`), and usage chunk when requested.

2. **API Validation & Normalization (`src/api/**`)**:
   - Hand-written strict validation returning OpenAI-standard `{ error: { message, type: "invalid_request_error", param, code } }`.
   - Normalizes messages (`developer` -> `system` role mapping; string or null content; tool call pass-through).
   - Validates ranges: `temperature` 0..2, `top_p` 0..1, positive integer `max_tokens` / `max_completion_tokens` (`max_completion_tokens` taking precedence).
   - `stop` normalization (string | string[] -> string[]).
   - Tool definitions and tool choice structural validation.
   - Enforces `n <= 1` (rejecting `n > 1` with 400 and code `unsupported_parameter`).
   - Ignores unknown fields per contract.

3. **Routes (`src/routes/**`)**:
   - `GET /health`: Lightweight endpoint returning 200 status, version, uptime, and provider mode with 0 provider calls.
   - `GET /v1/models`: Returns `{ object: "list", data: models }` from `provider.listModels()`.
   - `GET /usage`: Merges in-memory `UsageTracker.snapshot()` with `provider.getUsage()`. Degrades provider errors to `provider: null` and never returns 500.
   - `POST /v1/chat/completions`:
     - Non-stream: Aggregates provider deltas, tool calls, and usage; returns full OpenAI response; records token usage (estimating `ceil(chars/4)` if omitted by provider).
     - Stream (SSE): Emits compliant text/event-stream chunks; sends `: keep-alive` heartbeats every 15s; outputs usage chunk before `[DONE]` when `stream_options.include_usage: true`; formats mid-stream errors as `data: {"error":{...}}` followed by `data: [DONE]`.
     - Client disconnect: Creates an `AbortController`, binds to client socket close, passes `signal` to `NormalizedChatRequest`, and halts stream iteration on abort.

4. **App & Composition Root (`src/app.ts`, `src/server.ts`)**:
   - `buildApp({ config, provider, usageTracker })`: Configures Fastify with redacted structured logging (`REDACT_LOG_PATHS`), `genReqId: req_<uuid>`, sets `x-request-id` response header, sets error handler enforcing standard OpenAI envelope.
   - `server.ts`: Composition root connecting `loadConfig` -> `createProviderFromConfig` -> `buildApp` -> `registerSecurityPlugins` -> `listen({ host, port })`.

## Tests Performed
- `npm run typecheck`: TypeScript strict typecheck passed with 0 errors.
- `npm test`: Vitest test runner executed with 19/19 tests passing:
  - `tests/smoke.test.ts` (1 test): Scaffold baseline health check passes.
  - `tests/api/api.test.ts` (18 tests):
    - Health check 200 with 0 provider calls verified.
    - `x-request-id` header presence and format verified.
    - Model listing structure verified.
    - Non-stream completion happy path, role mapping, and usage recording verified.
    - Tool call accumulation across deltas verified.
    - Stream SSE chunk sequence (role -> content -> finish_reason -> `[DONE]`) verified.
    - Stream usage chunk emission with `include_usage: true` verified.
    - Validation 400s (missing model, empty messages, invalid temperature, n>1 unsupported parameter, top_p & token precedence) verified.
    - Error code mappings (unauthorized -> 502, not_found -> 404, mid-stream SSE error frame) verified.
    - Usage accumulation across multiple requests and provider error resilience verified.
    - Real-socket client disconnect test using port 0, `fetch`, and `AbortController` confirming `signal.aborted` observed within ~200ms verified.
- `npm run build`: Clean CommonJS compilation to `dist/`.

## Known Limitations
- Usage tracking is in-memory only (suitable for single-container deployment; resets across restarts).
- Security hooks (API-key auth, CORS, rate limiting) are registered via `registerSecurityPlugins` in `src/middleware/index.ts` (owned by deployment agent).

## Integration Requirements
- Frozen signatures respected: `buildApp({ config, provider, usageTracker })` provides an optional default for `usageTracker` to preserve backward compatibility with `smoke.test.ts`.
- No new npm packages or package.json changes required.

## Verified vs Unverified
- **Verified**: Fastify app setup, OpenAI request validation & normalization, SSE and non-streaming responses, tool calls, error handling, usage tracking, client disconnect cancellation, and test suite with offline mock provider.
- **Unverified**: Live Google Antigravity OAuth upstream communication (Antigravity OAuth is unofficial and experimental; live path relies on provider agent implementation and credentials).
