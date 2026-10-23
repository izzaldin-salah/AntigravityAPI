# Execution ledger — tasks/plan.md

Baseline: bfcd716; only tasks/ planning documents were untracked at start.

Ruling: Execute in the user's current checkout and leave changes uncommitted, as the approved plan requests local testing and explicitly forbids commits/pushes/deployments. Historical contract ownership/team rules do not govern this maintenance pass.

Ruling: Use this durable ledger and checklist rather than shell-specific skill bookkeeping scripts; this Windows checkout has no committed per-task ranges because commits are prohibited.

Pre-flight: Tasks 1/9 share JSON-filter output; preserve push/finish interface. Tasks 2/3 share schema traversal; keep tool and response dialects distinct. Tasks 7/8/9 share cancellation/errors; use typed ProviderError and one caller/composed abort signal. Tasks 8/11 share outcome classification. Task 12 must cover both token-manager direct I/O and token-store helpers without overwriting account-store records.

Tasks 1–6: complete. Each regression was observed failing before its fix (Task 6 test import was corrected before the meaningful RED run). Task 1 focused/API tests initially hit localhost EACCES under sandbox; elevated local verification passed. Schema unions use the existing supported anyOf dialect (Google Schema docs: https://googleapis.github.io/js-genai/release_docs/interfaces/types.Schema.html); simultaneous type-union + anyOf is rejected explicitly. Task 4 validates named declarations before token refresh/network. Task 5 updates exact provider expectations to require correlation IDs.
Checkpoint A1: typecheck/build; 227 tests/24 files; smoke 17 + 32 checks passed.
Checkpoint A2: typecheck/build; 231 tests/25 files; smoke 17 + 32 checks passed.

Tasks 7–9: complete. Added strict event framing/UTF-8/protocol errors (16 MiB event bound), explicit candidate finish evidence, cancellable body reads, first/idle/total deadlines (120s/120s/600s), shared route deadline and pre-header timeout mapping, awaited drain handling, serialized/skipped heartbeats, numeric fallback token accounting, and configurable response cap (16 MiB default). New integration tests cover incomplete streams, 502 framing, 504 before SSE headers, byte caps and 25 MiB request cap. Positive completion fixtures were corrected to contain actual candidate STOP evidence; malformed/truncated behavior remains independently tested. Fake timers found and fixed a pre-aborted promise rejection leak.
Checkpoint B: typecheck/build; 247 tests/29 files; smoke 17 + 32 passed.

Task 10: complete. Official checkout/setup-node v6 tags resolved using git ls-remote to immutable SHAs; read-only workflow runs Node 24, npm ci, checks and both local smoke scripts. Fourteen synthetic stream/nonstream compatibility cases passed. Node engine metadata aligned with locked Vitest requirements; no dependency versions changed. npm ci passed (npm warned about esbuild postinstall approval; compiled/tsx checks subsequently worked).
Task 11: complete. Bounded first-output/completion percentile samples, active attempts and failure categories tested. Dashboard usage/storage copy verified in an isolated browser fixture with no error/warning console entries. Temporary fixture tab closed. The first load harness run exposed a fixture-only Promise.race listener leak; switching the fixture writer to the tested drain helper removed it. No runtime mock mode was added.
Task 12: complete. Shared encryption module preserves existing account file/Redis envelope behavior; token cache uses a separate kind marker. Token-manager direct plaintext I/O removed. Verified wrong key/tampering, keyless memory-only behavior, serial writes, legacy migration, migration failure preservation, restart and identity precedence. Temp-dir atomic rename is restricted by the Windows sandbox (EPERM); elevated local tests passed. No production credential file was read or migrated by these tests.
Ruling: Cache lifecycle testing reproduced a late-refresh/disconnect race and coupled caller cancellation. Added generation checks and independently cancellable waiters to the existing single-flight refresh; stale credentials cannot be restored after disconnect. Tests observed RED then GREEN.
Final review: fixed empty named choice, prototype-like schema property loss and response-limit metrics classification with failing regression tests. Added API adapter completion-integrity regression: missing/failed terminal events no longer become successful nonstream responses or successful SSE finish reasons. Contract amendment documents the new behavior.
Final verification: npm ci; typecheck; build; 271 tests across 31 files; 17 e2e + 32 account smoke checks; production dependency audit zero vulnerabilities. Local synthetic load checks passed (1/5/10 concurrency, slow reads, four intentional disconnects, 4 MiB requests, 512 KiB responses) with zero unexpected errors. Browser fixture displayed metrics and encrypted-cache copy with clean console. No live upstream/client generation, production load, GitHub workflow execution or deployment was performed. Git diff --check passed before final documentation update; final whitespace/status check follows.
No commits, pushes, deployment or Render changes. All work remains in the original local checkout for user review/testing. Evidence is retained here because commits were prohibited; no skill scratch directory is deleted.

Release update — 2026-10-24: After the OpenCode/REA tool-schema compatibility fix,
the user explicitly requested a GitHub push, superseding the earlier local-only
restriction. The release includes the reliability work above and the schema fix.
Pre-push verification: 290 tests/32 files, typecheck, build, 17 e2e + 32 account
smoke checks, and git diff --check passed. Source scan found no private-key or
common GitHub/Google API-key patterns. GitHub main matched baseline bfcd716.
Render's existing auto-deploy behavior was disclosed; no separate deployment
command or OpenCode configuration change is authorized or performed here.
