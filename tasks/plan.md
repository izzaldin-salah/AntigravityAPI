# Antigravity API correctness and reliability implementation plan

**Executor:** Sol 6.1. Implement sequentially using the executing-plans workflow if available. This document is the self-contained specification; no previous conversation is required.

**Goal:** Fix the six confirmed compatibility bugs, then improve stream integrity, resource handling, CI, operational visibility, and credential persistence.

**Architecture:** Keep the existing TypeScript/Fastify gateway, provider abstraction, normalized request types, encrypted credential store, and admin dashboard. Make focused changes within those boundaries. Extract small helpers only where they simplify the affected logic; do not rewrite the application.

**Stack:** Node.js, TypeScript, Fastify, Zod, Vitest. Inspect package.json/package-lock.json for the current supported runtime and dependency versions before execution.

## Baseline and constraints

- Review baseline: main at `bfcd716`, October 22, 2026. Recheck the current HEAD and working tree; preserve newer changes and reproduce each finding before fixing it.
- At review time: 223 tests across 24 files, typecheck, build, both smoke suites, and production dependency audit passed. Render reported the same commit. These are historical results, not a substitute for fresh verification.
- Work locally. Do not push, deploy, modify Render configuration, open a PR, or commit unless the user requests it. Leave changes available for the user's local testing.
- Preserve Antigravity as the runtime provider. Do not restore runtime mock mode or the removed Manual credentials UI. Test doubles and offline fixtures are allowed.
- Preserve model selection, thinking settings, OAuth, authentication, rate limits, usage reporting, and dashboard behavior.
- Never log or commit credentials, real prompts/replies, image payloads, or private production fixtures.
- Prefer existing libraries and Node APIs. Do not introduce a queue service, database, monitoring vendor, or broad refactor for this work.
- Read repository instructions and `docs/architecture-contract.md`; update relevant contracts when implementation changes them. User authorization and this scope take precedence over historical ownership annotations.
- No live upstream tests or production load tests are required. Keep optional real-client tests separately invoked and clearly report what was not exercised.

## Execution and review rules

For every task: add the named regression cases, run the focused test and confirm the intended failure, implement the smallest coherent fix, then rerun the focused tests and typecheck. Do not weaken existing assertions to make failures disappear. Record completion in `tasks/todo.md`.

Run the full checkpoint commands after Tasks 3, 6, 9, and 12. Keep the application working between tasks. If current HEAD already fixes a finding, verify it and retain/add the regression case rather than duplicating the change.

Review focus: arbitrary network chunk boundaries; repeated tool names with out-of-order results; property names that resemble schema keywords; cancellation during blocked reads/writes; interrupted credential migration. Each is tested in its owning task below.

## Phase A: Fix confirmed compatibility bugs

### Task 1 — Preserve JSON content across streaming boundaries

Files: `src/core/json-fence.ts`, `tests/api/json-fence.test.ts`; route integration coverage in `tests/api/api.test.ts` if needed.

- Preserve `createJsonFenceFilter(): JsonFenceFilter` and its `push(text): string` / `finish(): string` interface.
- Remove only an outer opening fence and its matching trailing fence. Never globally remove backticks. Share the recognized fence syntax with `stripJsonFence` so both paths agree.
- Buffer only the undecided prefix and potential closing suffix; do not accumulate the full response. Bound pathological undecided input and use a documented pass-through/error policy rather than unbounded buffering.
- Reproduce `['```json\n', '{"ok":true}\n', '``', '`']`: the final concatenated output must parse as `{ok:true}` with no fence remaining.
- Reproduce `['```json\n', '{"code":"```"}', '\n```']`: the parsed `code` value must still be three backticks.
- Cover every two-way split point plus character-by-character streaming of representative payloads, CRLF, whitespace, unlabelled fences, unfenced JSON, empty chunks, incomplete fences, and repeated `finish()` calls. Unfenced text must pass through unchanged; streamed/nonstream results must preserve identical JSON values.

Verify: `npm test -- tests/api/json-fence.test.ts tests/api/api.test.ts`.

### Task 2 — Separate JSON Schema nodes from property-name maps

Files: `src/providers/json-schema.ts`, `tests/providers/json-schema.test.ts`, `tests/providers/tools.test.ts`.

- Fix the recursive sanitizer: process each value of `properties` as a schema while preserving the map's keys verbatim. Apply the same distinction to supported schema-map keywords, including definitions used by local references.
- Filter unsupported schema keywords only at schema-node level. Preserve existing reference resolution and cycle/depth protections; do not mutate the input schema.
- Test required parameters named `readOnly`, `const`, `$schema`, and ordinary names; their property definitions and required entries must survive, including nested objects and referenced definitions.
- Test that an actual unsupported keyword inside a parameter's schema is still removed and that recursive references terminate safely.

Verify: `npm test -- tests/providers/json-schema.test.ts tests/providers/tools.test.ts`.

### Task 3 — Preserve structured-output union semantics

Files: `src/providers/json-schema.ts`, `src/api/validation.ts` if early rejection is required; `tests/providers/json-schema.test.ts`, `tests/api/api.test.ts`.

- Stop choosing the first non-null member of a type array. Preserve all supported branches, using the backend's supported union representation after checking repository protocol evidence and authoritative documentation where needed.
- Cover `["string","integer"]`, nullable unions, a three-type union, and nested unions. Retain relevant constraints in each branch; do not silently widen or narrow the accepted value set.
- If faithful representation is unsupported, return a clear client-facing 400 identifying the unsupported schema feature before making an upstream call. Do not claim local strict-schema enforcement unless it is actually implemented.
- Keep ordinary single-type JSON Schema and JSON-object mode compatible.

Verify: `npm test -- tests/providers/json-schema.test.ts tests/api/api.test.ts`. Run checkpoint.

### Task 4 — Enforce named tool choice on the effective wire payload

Files: `src/providers/tools.ts`, `src/api/validation.ts` if necessary; `tests/providers/tools.test.ts`, `tests/providers/antigravity.test.ts`, `tests/api/api.test.ts` as needed.

- For a named choice, restrict forwarded function declarations to the selected declared function and identify it in the existing fallback directive. Retain supported `toolConfig`, but do not rely on it alone on routes that ignore it.
- Reject an undeclared selected function with 400 before the upstream call.
- With two tools `get_weather` and `get_time`, selecting each must produce different effective payloads even after removing `toolConfig`; only the chosen function may be declared.
- Cover `auto`, `none`, `required`, and named modes. Preserve existing behavior for modes not affected by this fix and clearly document that model compliance cannot be guaranteed solely by instructions.

Verify: `npm test -- tests/providers/tools.test.ts tests/providers/antigravity.test.ts tests/api/api.test.ts`.

### Task 5 — Preserve correlation for parallel tool results

Files: `src/providers/tools.ts`, related upstream part types if needed; `tests/providers/tools.test.ts`, `tests/providers/antigravity.test.ts`.

- Carry each valid incoming `tool_call_id` into `functionResponse.id`, using the same identifier sent for the corresponding upstream function call. Inspect any ID generation/remapping so both sides agree. Repository evidence is recorded in `docs/omp-analysis.md`.
- Preserve grouped consecutive tool-result turns, function names, payloads, and thought-signature replay.
- Test two calls to `get_weather` with distinct IDs/cities and reversed result order. Each result must remain attached to its original call; swapping assignments must change the wire payload.
- Cover separate tool names and the existing supported legacy/no-ID behavior without inventing identifiers that misassociate results.

Verify: `npm test -- tests/providers/tools.test.ts tests/providers/antigravity.test.ts`.

### Task 6 — Validate image base64 and enforce decoded byte limits

Files: `src/api/validation.ts`, `tests/api/api.test.ts`; optionally extract a focused image-validation helper/test if it makes the existing large file simpler.

- Use one validator for every accepted inline image shape: OpenAI data URLs, Anthropic base64 sources, and extracted inline images.
- Validate alphabet, padding placement/count, and legal encoded length before relying on permissive `Buffer.from`. Accept standard padded base64 and valid unpadded base64 after normalization; reject embedded whitespace, invalid characters, impossible lengths, and malformed padding with the existing validation error format.
- Calculate actual decoded size correctly, including padding. Avoid unnecessary large decoded copies when validated encoded length is sufficient.
- Preserve the 8 MiB per-image limit and existing 25 MiB HTTP body limit. Do not introduce server-side fetching of remote image URLs.
- Test invalid `!!!!!`, correct one/two/no-padding cases, exactly 8 MiB accepted, 8 MiB + 1 byte rejected, and valid small images across supported request shapes. Include the HTTP body-size limit independently of the image limit.

Verify: `npm test -- tests/api/api.test.ts`. Run checkpoint.

## Phase B: Make failures and resource use predictable

### Task 7 — Detect incomplete or malformed upstream streams

Files: `src/providers/sse.ts`, `src/providers/antigravity.ts`; new `tests/providers/sse.test.ts`, existing provider/API tests.

- Parse SSE events correctly across arbitrary UTF-8/network boundaries, CRLF/LF, comments, multiline data, and final buffered data. Bound an individual event buffer; use a configurable or documented conservative limit that accommodates real tool argument payloads.
- Throw a typed upstream protocol error for malformed data instead of silently discarding it. Ignore legitimate keepalive/comment frames.
- Track actual completion evidence. Remove the implicit assumption that clean EOF means `stop`; define valid terminal evidence from the repository's protocol fixtures and documented backend behavior. Do not require a marker the backend never sends, and do not treat a transport marker alone as proof of a valid completed model response.
- Distinguish normal completion, explicit upstream error, truncated output, and caller cancellation. Preserve existing supported finish reasons, tool calls, usage trailers, and refusal/safety outcomes.
- Test EOF before any output, EOF after partial text, valid terminal completion, malformed JSON, truncated UTF-8/data, oversized events, and tool-only responses.
- In both API modes, failures must not become successful assistant completions. Streaming errors must follow the existing compatible error framing with no success finish reason after the error.

Verify: `npm test -- tests/providers/sse.test.ts tests/providers/antigravity.test.ts tests/api/api.test.ts`.

### Task 8 — Add request deadlines with reliable cancellation

Files: focused deadline helper plus provider integration; config/env/types and their tests. Split config and provider wiring into small substeps if needed.

- Add validated positive millisecond settings: `ANTIGRAVITY_FIRST_RESPONSE_TIMEOUT_MS=120000`, `ANTIGRAVITY_IDLE_TIMEOUT_MS=120000`, `ANTIGRAVITY_REQUEST_TIMEOUT_MS=600000`. These are conservative starting defaults for long thinking requests, not measured production limits. Document tuning in `.env.example`/README if present.
- Total time covers the chat lifecycle, including token/project preparation and permitted retries. First-response time ends at the first valid model/usage event, not merely HTTP headers or comments; idle time is reset by meaningful upstream progress. Total time remains a hard cap.
- Compose deadline cancellation with the caller signal without losing the reason. Apply cancellation to fetch, blocked body reads, and any retry waits. Do not add automatic retries after output has been emitted.
- Before response headers, map timeout to the established typed error envelope with HTTP 504. After streaming begins, send one compatible timeout error when the connection is writable and terminate; never try to change HTTP status then.
- Clear timers/listeners/readers in every completion path. Classify timeout as failure and client disconnect as cancellation in tracking.
- Use fake timers and controlled streams: stalled headers, headers without events, comments-only response, midstream stall, continuously active stream hitting total limit, early success, client cancellation, and cancellation during preparation.

Verify focused deadline, config, provider, API, and tracker tests. No real multi-minute sleeps.

### Task 9 — Respect response backpressure and cap buffering

Files: `src/routes/chat.ts`, optional focused SSE writer helper; `tests/api/api.test.ts` plus a focused writer test. Depends on Tasks 7–8.

- Await `drain` when `reply.raw.write()` returns false. Stop awaiting on connection close/error/cancellation; stop consuming upstream output while downstream is blocked.
- Serialize data and keepalive writes through one flow so heartbeats cannot create an unbounded side queue. Clean up listeners and heartbeat timers.
- Ensure the total deadline can break a blocked write. Test completion/error framing is emitted at most once.
- Remove avoidable full-response accumulation in streaming mode. Inspect token-usage fallback: preserve documented accounting using bounded incremental state, or explicitly mark estimates; do not silently change usage semantics.
- Preserve full collection for nonstream responses only within a documented configurable response-size bound. Bound tool argument/event accumulation too; report a typed limit error instead of exhausting memory.
- Test repeated backpressure/drain, close/error before drain, timeout while blocked, heartbeat behavior, large output, and cleanup. A controlled slow-reader test must prove upstream consumption pauses and buffers stay bounded.

Verify API/writer/provider tests. Run checkpoint.

## Phase C: Guard future changes and improve operations

### Task 10 — Add repeatable CI and client compatibility fixtures

Files: new `.github/workflows/ci.yml`; focused compatibility fixtures/tests, README/test docs; package scripts only if needed.

- Run `npm ci`, typecheck, build, full tests, and both smoke scripts for pushes and pull requests, without production credentials. Choose a currently supported Node LTS version compatible with the lockfile after verifying runtime requirements; align documentation rather than silently assuming the existing minimum works.
- Use read-only workflow permissions and supported, pinned action revisions. Do not create a deployment job or change remote branch protection.
- Add sanitized fixtures for the request forms already supported by the gateway: OpenAI-style SDK payloads, array content from Cline/5ire, inline images, structured output, parallel tool results, and model/thinking settings. Exercise stream and nonstream modes with deterministic upstream doubles.
- Keep any optional real-client or upstream checks opt-in and clearly separate from CI. Fixture tests demonstrate gateway compatibility, not certification of every client version.
- Document how the user can make this CI status required in GitHub; do not claim CI blocks Render deployments without that repository/deployment configuration.

Verify the workflow commands locally; inspect workflow syntax and trigger/permission settings. GitHub execution remains unverified until pushed by the user.

### Task 11 — Extend existing bounded metrics and add a local load harness

Files: `src/core/request-tracker.ts`, relevant admin operations types/view, focused tracker/admin tests; separate local load script/documentation substep.

- Extend the existing tracker rather than building a new metrics service. Record active requests, first-output latency, completion latency, and bounded counters for timeout, protocol error, upstream failure, success, and client cancellation.
- Define first output as the first user-visible text/tool delta; keep it absent for no-output failures. Maintain bounded rolling samples for p50/p95, labeled as process-local and windowed, with correct reset/restart semantics.
- Show a compact read-only summary in the existing operations dashboard. Escape output and expose neither content nor raw upstream errors. Label metrics consistently with existing API/connection-test source distinctions.
- Test counts/gauges return to correct values after every success/error/abort path, empty samples, bounded retention, and percentile calculations.
- Add an explicitly local, bounded-duration load harness using a deterministic upstream server. Exercise concurrency 1/5/10, slow readers, disconnects, and large valid payloads. Report p50/p95, errors, and peak RSS with fixture details.
- Do not load-test Render or infer production capacity from local synthetic numbers. Use measurements to recommend concurrency/resource limits; do not invent a performance target or silently add restrictive admission controls.

Verify focused tracker/admin tests and run the local harness once, recording its environment and limits.

### Task 12 — Remove plaintext token persistence with a safe migration

Files to inspect: `src/security/token-store.ts`, `src/security/credential-store.ts`, `src/providers/token-manager.ts`, configuration/provider construction; token-store, token-manager, and credential-store tests. Implement as three small substeps: persistence adapter, legacy migration, integration/docs.

- Audit all cache readers/writers. The token manager has its own direct file I/O in addition to the token-store helper; both must stop writing plaintext. Preserve environment-first credential precedence and existing OAuth refresh behavior.
- Reuse the existing encrypted store/AES-GCM envelope instead of creating another crypto format. Do not accidentally overwrite account-store records with a different cache shape; define a compatible adapter or isolated encrypted cache record and test the mapping.
- Without an encryption key, allow environment-backed operation with memory-only cache and a nonsecret warning. Never fall back to plaintext writes. Preserve existing stricter requirements when the admin dashboard is enabled.
- Support migration of the configured legacy cache only: validate its shape, encrypt/write atomically, verify readback, then retire/replace the plaintext source. If anything fails, preserve the original recoverable source, avoid plaintext copies/backups, and report migration failure without pretending success. Do not scan unrelated paths.
- Keep opportunistic cache writes best-effort; preserve persistent-store errors where the existing contract requires them. Serialize refresh persistence to avoid stale concurrent overwrites.
- Test normal round-trip, wrong key, tampered envelope, no key, malformed legacy data, successful migration, write/rename failure, restart, concurrent refresh, environment precedence, and both file/Redis store compatibility where applicable.
- Assert access/refresh token sentinel values do not appear in newly written disk/Redis data or logs. Do not promise secure erasure of old filesystem blocks or make permission assumptions that fail on Windows.

Verify token-store, credential-store, token-manager, OAuth/account tests. Run final checkpoint.

## Checkpoint commands and final handoff

Run sequentially:

```powershell
npm run typecheck
npm run build
npm test
npm run smoke:e2e
npm run smoke:account
```

At the final checkpoint also run `npm audit --omit=dev`, the bounded local load harness, and `git diff --check`. Inspect the final diff and working tree for accidental secrets, generated artifacts, and unrelated changes. If a check is blocked, report the exact limitation instead of marking it passed.

Deliver: completed task checklist; concise changes and compatibility decisions; test counts/results; local load measurements with limitations; new configuration defaults; migration behavior; and local testing instructions. Explicitly distinguish automated fixture coverage from live upstream/client verification. Leave all implementation changes local for the user's review. Do not push or deploy.
