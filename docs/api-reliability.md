# API reliability and local verification

Antigravity OAuth through third-party applications is unofficial and may violate
Google's Terms of Service; account suspension is possible. This maintenance work
uses offline fixtures and does not establish live upstream/client compatibility.

## Compatibility behavior

- JSON-mode streaming removes only outer Markdown fences and preserves literal
  backticks inside JSON values across network chunk boundaries. Undecided fence
  prefixes are bounded at 4 KiB; pathological prefixes pass through. An oversized
  candidate closing suffix fails instead of buffering indefinitely.
- Tool schema parameter names survive sanitization, including names resembling
  schema keywords. Named tool choice restricts declarations and names the selected
  function in its fallback directive. Instructions still cannot guarantee model
  compliance. Parallel results preserve function call IDs.
- Supported response-schema type unions use `anyOf` and nullable handling. A type
  array combined with `anyOf` at the same node is rejected explicitly. This remains
  translation to a provider subset, not full local JSON Schema `strict` enforcement.
  Reference: [Google Schema](https://googleapis.github.io/js-genai/release_docs/interfaces/types.Schema.html).
- Standard padded and valid unpadded image base64 are accepted; malformed alphabet,
  padding, impossible lengths and embedded whitespace are rejected. The decoded
  limit remains 8 MiB per image, with 25 MiB per HTTP request. Remote image URLs
  are forwarded upstream without a gateway fetch.

## Deadlines, integrity and memory

| Setting | Default | Meaning |
| --- | --- | --- |
| `ANTIGRAVITY_FIRST_RESPONSE_TIMEOUT_MS` | 120000 | First valid model/usage event; headers and comments do not count |
| `ANTIGRAVITY_IDLE_TIMEOUT_MS` | 120000 | No meaningful upstream progress after the first event |
| `ANTIGRAVITY_REQUEST_TIMEOUT_MS` | 600000 | Whole chat, including preparation and the permitted auth retry |
| `ANTIGRAVITY_MAX_RESPONSE_BYTES` | 16777216 | Text/tool payload cap in either mode; at most 256 MiB |

Timeouts require positive integer milliseconds, at most 2147483647. These defaults
are conservative starting values for thinking requests, not measured production
limits. SSE events have a separate 16 MiB cap. Malformed JSON/UTF-8 and EOF without
a model finish reason fail explicitly. A transport `[DONE]` alone is insufficient.

Before response headers, timeout returns HTTP 504. Midstream errors produce one
error frame and `[DONE]` when writable; a blocked connection is closed. Writes
await backpressure and skip keepalives while blocked. Streamed response text is
not retained in full. Missing provider usage retains the approximate
`ceil(characters / 4)` fallback, using a numeric counter. Reported provider usage
continues to take precedence.

The dashboard and authenticated `/admin/api/operations` expose active requests,
failure categories and p50/p95 completion/first-output latency. First output means
the first visible text/tool delta; no-output attempts have no first-output sample.
The rolling window covers the last 50 completed attempts including connection
tests. Counters and samples are process-local and reset on restart. Metadata never
retains prompts, replies, images, tokens or raw error messages. This remains a
single-instance gateway.

## Encrypted token cache and migration

The configured token cache is separate from the account store and uses its
AES-256-GCM envelope with a distinct payload marker. Both helper and token-manager
write paths use `CREDENTIAL_ENCRYPTION_KEY`. Without a key, disk caching is disabled
and environment-backed operation uses memory only with a nonsecret warning. The
dashboard still requires its encryption key and fails closed when misconfigured.

First use with a key migrates a valid legacy plaintext cache: write encrypted
data to a same-directory temporary file, read/decrypt/verify it, then atomically
rename it over the original. Before that rename, any failure preserves the
original. Wrong-key, corrupted or unrelated records are not overwritten. No
plaintext backups are created; old filesystem blocks are not securely erased.
Only the configured path is examined. File operations are opportunistic; failures
are reported without disabling otherwise valid environment credentials.

Keep the key stable. Wrong-key data is preserved for recovery, but cannot be read
until its original key is restored or an intentional migration is performed.
Writes are serialized within one process; do not share the cache file across
processes. Environment identity takes precedence over a different cached account.
Dashboard account storage stays authoritative, and stale caches/late refreshes
cannot restore a disconnected account. Shared refresh callers cancel independently.
File caches remain ephemeral on Render Free; the existing encrypted Redis account
store is the durable option. This work does not change Render configuration.

## Local and CI checks

Use Node 24 LTS. Run:

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run smoke:e2e
npm run smoke:account
npm audit --omit=dev
npm run load:local
```

The load script starts loopback gateway/upstream fixtures, accepts no production
URL, and is bounded to 30 seconds. It tests concurrency 1/5/10, slow readers,
disconnects and large valid prompts, reporting p50/p95, errors, cancellations and
process RSS. Both servers run in one process: numbers are synthetic, include fixture
costs, and cannot establish production capacity. Start with the existing personal
usage pattern and measure the actual deployment before choosing concurrency caps.

CI `API checks / checks` uses pinned official actions, read-only permissions, Node
24, clean install, typecheck, build, full tests and both offline smoke suites.
To enforce it, make this status required in GitHub branch rules and configure
deployment checks separately. Adding a workflow does not itself gate Render
auto-deploy. GitHub execution is unverified until the user pushes these files.

Synthetic client fixtures cover SDK text, Cline/5ire array content, OpenAI and
Anthropic images, JSON formats and parallel tools in both API modes. Existing
model-setting tests cover model/thinking changes. Real client/upstream checks are
separate, explicitly opt-in work.

For manual testing, run the server with your local environment, open `/admin`,
check the usage/storage summaries, change model/thinking settings, and send both
streaming and nonstreaming requests from your client. Watch for the documented
validation and timeout errors. All changes remain local until you choose to push.
