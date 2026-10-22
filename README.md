# Personal Antigravity API

Personal, OpenAI-compatible REST API gateway for an Antigravity provider.
TypeScript · Fastify 5 · SSE streaming · API-key auth · usage tracking.
Native Node.js deployment on **Render Free — no Docker**.

> **⚠️ Risk notice:** Antigravity OAuth integration through third-party
> applications is **unofficial**, may violate Google's Terms of Service, and
> carries **account-suspension risk**. This project does not attempt to
> circumvent provider restrictions. The live Antigravity path ships as
> **EXPERIMENTAL**. Antigravity is the only supported provider. See
> [`docs/security.md`](docs/security.md) and [`docs/omp-analysis.md`](docs/omp-analysis.md).

## Status

| Area | State |
| --- | --- |
| Build + typecheck (`strict`) | ✅ verified |
| Unit/integration tests | ✅ verified |
| End-to-end HTTP smoke (`npm run smoke:e2e`, 17 checks) | ✅ verified |
| Account dashboard e2e (`npm run smoke:account`, 32 checks) | ✅ verified |
| Account dashboard: login, CSRF, rate limiting, encrypted credential store | ✅ verified (offline, fake OAuth server) |
| Auth, rate limiting, CORS, log redaction | ✅ verified |
| Live Antigravity OAuth / upstream calls | 🧪 experimental; live-verified locally 2026-10-17 (OAuth connect, chat, SSE) — long-term refresh + deployed runtime still unverified |

## Quick start

```bash
npm ci
npm run build
npm test              # unit/integration tests (offline)
npm run smoke:e2e     # end-to-end check of the built server (needs build)
npm run smoke:account # full account-dashboard workflow vs a fake OAuth server
# Configure .env first (copy .env.example and fill in your credentials)
node --env-file=.env dist/server.js  # http://0.0.0.0:3000
# Without a .env file, export environment variables before npm start / npm run dev.
```

`PROVIDER_MODE` defaults to `antigravity`, the only supported provider.
Connect your account in `/admin` before sending chat requests. The server does
not load `.env` automatically; use the Node command above for local testing.
Outside production,
if `API_KEYS` is unset the implicit dev key is `dev-local-key`.

The gateway defaults to `gemini-3.8-flash-high` (upstream
`gemini-3.8-flash-tiered` with HIGH thinking). In `/admin`, open **Model &
thinking**, load your account models, choose a compatible text model and
thinking level, then save. New chat requests and connection tests use that
selection regardless of the model name the client sends; `GET /v1/models`
lists the active public model. Existing requests retain their original settings.

Thinking options depend on the model: Gemini 3/4 use supported LOW/MEDIUM/HIGH
levels; original Gemini 3 Pro offers LOW/HIGH. Gemini 2.5 and thinking-enabled
Claude models use gateway token-budget presets of 1,024 / 8,192 / 16,384 tokens;
their upstream output limit includes that budget plus the requested output allowance
(8,192 by default). Account capability metadata determines whether thinking
controls are available; models without thinking support use provider-default
behavior with no override. Image/audio models and unknown families are excluded.
Model discovery and saving validate account availability but do not guarantee
quota or a successful generation; use the connection test to verify access.

Selections are stored independently of credentials: Redis uses
`antigravity:model-settings:v1`; file storage uses
`<CREDENTIAL_FILE_PATH>.model-settings.json`. File durability depends on the
deployment disk and Redis durability on its configuration. Each server process
loads its selection at startup/first use; a dashboard save updates that process
immediately. This remains a single-instance gateway, not a synchronized
multi-instance settings system. Invalid stored settings fail closed rather than
silently routing requests to another model. The model-discovery and settings
POST endpoints require an admin session and CSRF and return `no-store`.

### Example requests (dev defaults)

```bash
curl http://localhost:3000/health

curl -H "Authorization: Bearer dev-local-key" http://localhost:3000/v1/models

curl -H "Authorization: Bearer dev-local-key" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.8-flash-high","messages":[{"role":"user","content":"hello"}]}' \
  http://localhost:3000/v1/chat/completions

curl -N -H "Authorization: Bearer dev-local-key" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.8-flash-high","messages":[{"role":"user","content":"hello"}],"stream":true}' \
  http://localhost:3000/v1/chat/completions

curl -H "Authorization: Bearer dev-local-key" http://localhost:3000/usage
```

More: [`tests/api/EXAMPLES.md`](tests/api/EXAMPLES.md).

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/health` | public | lightweight, no provider calls |
| GET | `/v1/models` | ✅ | OpenAI list format |
| POST | `/v1/chat/completions` | ✅ | streaming + non-streaming, tool calling |
| GET | `/usage` | ✅ | local counters + provider usage |
| GET/POST | `/admin*` | session | account dashboard (own login, CSRF, rate limiting) |

### Tool calling (function calling)

`POST /v1/chat/completions` accepts the standard OpenAI tool fields and
exchanges them with the Antigravity backend:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer dev-local-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash-high",
    "messages": [{"role": "user", "content": "Weather in Paris?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }]
  }'
```

The model answers with a normal OpenAI tool call — `message.tool_calls[]` with
`finish_reason: "tool_calls"` (streaming emits `delta.tool_calls[]` chunks).
Send the result back as a `role: "tool"` message carrying the same
`tool_call_id`, and the model produces the final answer.

What the gateway does for you:

- **Wire mapping** — `tools` become the upstream `functionDeclarations` group;
  JSON Schemas are cleaned of the keywords the Cloud Code Assist schema proto
  rejects (and local `$ref`s are inlined), so strict schemas from real clients
  are accepted.
- **`tool_choice`** — `auto`/unset uses the backend's default `VALIDATED` mode;
  `required` and a named function use `ANY` plus a transcript directive (the
  backend drops `toolConfig` on its Gemini routes, so a forced choice has to be
  restated in the conversation); `none` does not declare the tools at all,
  because the backend ignores `NONE` and would still call them.
- **Tool results** — mapped to upstream `functionResponse` parts in a single
  user turn, which is what the backend requires.
- **Thought signatures** — the backend signs each function call and rejects a
  replayed call whose signature is missing, so the gateway keeps the signature
  with the call and replays it with your follow-up request.

Limits worth knowing: the signature is held in memory for the lifetime of the
process, so a tool loop that spans a gateway restart is rejected by the
backend (re-issue the call). Tool calls are forwarded for the active model
only; a model without tool support is not advertised in the dashboard model
list. The unofficial Antigravity path remains experimental.

### Vision (image input)

Image parts are forwarded to the provider, so screenshot-driven agents work.
Three published shapes are accepted and normalized to the same upstream
payload — use whichever one your client speaks:

```json
{ "type": "image_url",  "image_url": { "url": "data:image/png;base64,iVBORw0…" } }
{ "type": "input_image", "image_url": "data:image/png;base64,iVBORw0…" }
{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0…" } }
```

- `image_url` — OpenAI chat completions (`image_url` as an object or a string);
- `input_image` — OpenAI Responses API (`image_url` string or object);
- `image` — Anthropic Messages, with `source` of
  `{type:"base64", media_type, data}` (raw base64, no `data:` prefix) or
  `{type:"url", url}`; a bare `url`/`image_url` field works too.

Every shape is validated the same way:

- a **base64 data URL** is sent as an inline image payload;
- an **http(s) URL** is passed through for the provider to fetch — the gateway
  never fetches a client-supplied URL itself, so it cannot be used to reach
  internal network addresses; private and local addresses (`localhost`,
  `127.x`, `10.x`, `192.168.x`, …) are rejected up front with guidance,
  because the provider cannot reach them either;
- limits: 8 MB per image (decoded) and 25 MB per request — an inline data URL
  has no character cap (base64 is 4/3 of the bytes), while a remote URL is
  capped at 8 KB to keep the request sane;
- audio input is not supported and is rejected with a clear error;
- an OpenAI `file_id` cannot be resolved — send the bytes or a URL;
- if the provider rejects a request, **its own explanation is returned**
  (for example *"Cannot fetch content from the provided URL"*) instead of a
  bare status code, so a rejected image tells you what was wrong.

Clients that inline an image into the message text are handled too: an
`<img src="data:image/…">` tag (5ire writes one when its model has no
**Vision** capability), a Markdown `![alt](data:image/…)`, or a bare data-URL
string as the whole content. The data URL is lifted out of the text and sent
as a real image part, so the model sees the picture instead of reading base64
characters. Only `data:` URLs are lifted — a plain http(s) reference stays
text.

> The upstream requires the conversation to **end with a user turn**, and it
> ignores turns that carry no content. The gateway compensates: a trailing
> assistant message gets a whitespace-only user turn, an empty user message
> gets a whitespace part, and an empty assistant message is dropped — so a
> request like *"…assistant, user (empty)"* is accepted instead of failing with
> *"Requests ending with a model turn are not supported"*.

### Structured output (`response_format`)

```json
{ "response_format": { "type": "json_object" } }
```

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "city",
      "schema": { "type": "object", "properties": { "capital": { "type": "string" } }, "required": ["capital"] }
    }
  }
}
```

`json_object` asks for JSON only; `json_schema` additionally pins the shape —
the schema is translated to the provider's schema dialect (type names
uppercased, unsupported keywords dropped, local `$ref`s inlined, at most 5
levels of nesting). The provider sometimes wraps the payload in a Markdown
fence; the gateway strips it, so `JSON.parse(message.content)` works exactly
like OpenAI's API.

## Account dashboard (`/admin`)

A minimal, password-protected dashboard for managing the Antigravity account
connection — account changes take effect without redeploying.

```bash
# 1. Generate an admin password hash (preferred) and an encryption key
node scripts/hash-admin-password.mjs "your admin password"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 2. Start with the dashboard enabled (or ADMIN_PASSWORD for a plaintext dev password)
ADMIN_PASSWORD_HASH='scrypt$...' CREDENTIAL_ENCRYPTION_KEY='...' npm start
```

Open `http://localhost:3000/admin`, log in, and you can:

- see account status: `disconnected` / `connected` / `needs_reconnect` (plus
  access-token expiry, project, masked account hint, store health);
- **connect with browser OAuth** (Authorization Code + PKCE) when your own
  Google OAuth client is configured (`ANTIGRAVITY_CLIENT_ID`, optional secret) —
  if Google rejects the client or scopes, the exact error is shown and the
  dashboard shows connection guidance;
- **copy-URL localhost sign-in** — for OAuth clients registered with a
  localhost redirect only (e.g. on Render, where an `onrender.com` callback
  cannot be registered): start sign-in, complete it in Google (the browser then
  fails to load the localhost page — expected), and paste the entire
  `http://127.0.0.1:51121/oauth-callback?...` URL from the address bar back into
  the dashboard to finish the exchange server-side;
- reconnect, switch accounts (disconnect → connect), and log out.
- **test a live response** with a fixed short prompt, latency, a 30-second timeout, and a cooldown;
- **copy client setup**: API base URL, model, and cURL/Python examples with an environment-variable key placeholder; reveal the first configured API key only on demand;
- **inspect usage and recent requests**: provider attempts, reported input/output tokens, failures, cancellations, average duration, and the latest 50 metadata rows;
- **check account and storage health**: expiry, last refresh, last successful request, credential-store availability, and persistence limitations.

The usage panel charts request volume over time and response latency, both derived
from the same recorded request metadata shown in the recent-requests table. The
charts cover the retained request history only and are not estimated.

Dashboard counters cover provider attempts from API calls and connection tests. They reset
on restart, are local to this server instance, and omit requests rejected before reaching
the provider. History stores no prompts, responses, credentials, or raw error messages.
The live test consumes account quota; its response is displayed only for that request.
API-key reveal and live tests require an admin session plus CSRF and return `Cache-Control: no-store`.
Redis restart durability is not assumed; local file durability depends on the deployment disk.

Security invariants: OAuth tokens are never exposed to the browser or API
clients (sentinel-tested in the suite), the credential blob is AES-256-GCM
encrypted at rest, admin sessions are HttpOnly/SameSite=Lax with per-session
CSRF tokens, login attempts are rate-limited (429 + `Retry-After`), and
`/admin` uses session auth only — API keys stay required for `/v1/**` and
`/usage`. Sessions are in-memory (lost on restart → log in again).

Durability on Render Free: the `file` store is **ephemeral** — credentials are
lost on restart (reconnect via the dashboard). Set `REDIS_URL` (a free Render
Key Value instance, or any external Redis-compatible URL) for durable storage
and account switching without redeploys. Full setup:
[`docs/deployment.md`](docs/deployment.md) · threat model:
[`docs/security.md`](docs/security.md).

## Configuration

All configuration is environment-variable based — start from
[`.env.example`](.env.example). Key switches: `PROVIDER_MODE` (`antigravity` only), `API_KEYS` (comma-separated; required in production),
`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` (`0` disables), `CORS_ORIGINS`,
`TRUST_PROXY` (set `true` on Render). Antigravity mode additionally reads
`ANTIGRAVITY_*` credentials — see the contract §6 in
[`docs/architecture-contract.md`](docs/architecture-contract.md).

## Deployment (Render Free, no Docker)

Push this repo to your own GitHub, then create a **native Node** Web Service
(free plan) — or apply [`render.yaml`](render.yaml) as a Blueprint.
Build: `npm ci && npm run build` · Start: `npm start` · Health check:
`/health`. Secrets (`API_KEYS`, `ANTIGRAVITY_*`) are set in the Render
Dashboard, never in Git. Pair with a free [UptimeRobot](https://uptimerobot.com)
HTTP monitor on `https://<app>.onrender.com/health` every 5 minutes — this
*reduces* inactivity sleeping but cannot prevent every spin-down; cold starts
can take 30–60 s. Full guide: [`docs/deployment.md`](docs/deployment.md).

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/architecture-contract.md`](docs/architecture-contract.md) | Frozen architecture, AIProvider interface, API/SSE contract, ownership |
| [`docs/omp-analysis.md`](docs/omp-analysis.md) | Oh My Pi (OMP) analysis: auth, token lifecycle, streaming, usage, licenses |
| [`docs/deployment.md`](docs/deployment.md) | Render Free + UptimeRobot guide, ephemeral-disk strategy, platform limits |
| [`docs/security.md`](docs/security.md) | Security model, credential handling, threat notes, ToS risk |
| [`docs/handoffs/`](docs/handoffs/) | Per-agent handoff reports from the 3-agent build |

## Repository layout

```
src/
├── api/         # OpenAI request validation + normalization
├── admin/       # account dashboard: routes, sessions, CSRF use, HTML pages
├── core/        # usage tracker, chunk mapping, error envelope, ids
├── routes/      # /v1/chat/completions, /v1/models, /usage, /health
├── providers/   # Antigravity provider (+ OAuth, SSE, tokens)
├── middleware/  # auth, rate limit, CORS, error handler
├── security/    # redaction, token store, encrypted credential store, redis-lite
├── config/      # zod-validated environment loader
├── types/       # frozen shared contracts (provider/config/openai/admin)
├── app.ts       # Fastify app builder (routes only)
└── server.ts    # composition root
tests/           # vitest: api/, admin/, providers/, security/, config/, smoke
scripts/         # smoke-e2e.mjs + smoke-account.mjs + hash-admin-password.mjs
```

## License

UNLICENSED — personal use. The Antigravity integration is a clean-room,
OMP-inspired implementation; review `docs/omp-analysis.md` for the
license/reuse verdict before redistributing.
