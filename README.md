# Personal Antigravity API

Personal, OpenAI-compatible REST API gateway for an Antigravity provider.
TypeScript · Fastify 5 · SSE streaming · API-key auth · usage tracking.
Native Node.js deployment on **Render Free — no Docker**.

> **⚠️ Risk notice:** Antigravity OAuth integration through third-party
> applications is **unofficial**, may violate Google's Terms of Service, and
> carries **account-suspension risk**. This project does not attempt to
> circumvent provider restrictions. The live Antigravity path ships as
> **EXPERIMENTAL / UNVERIFIED** (no live credentials were exercised); the
> `mock` provider is the fully verified default. See
> [`docs/security.md`](docs/security.md) and [`docs/omp-analysis.md`](docs/omp-analysis.md).

## Status

| Area | State |
| --- | --- |
| Build + typecheck (`strict`) | ✅ verified |
| Unit/integration tests (12 files, 71 tests) | ✅ verified |
| End-to-end HTTP smoke (`npm run smoke:e2e`, 16 checks) | ✅ verified |
| Mock provider mode (`PROVIDER_MODE=mock`) | ✅ verified end-to-end |
| Auth, rate limiting, CORS, log redaction | ✅ verified |
| Live Antigravity OAuth / upstream calls | 🧪 experimental, unverified |

## Quick start

```bash
npm ci
npm run build
npm test              # 71 unit/integration tests (offline)
npm run smoke:e2e     # end-to-end check of the built server (needs build)
npm start             # http://0.0.0.0:3000  (mock provider by default)
# or: npm run dev     # tsx watch, same behavior
```

`PROVIDER_MODE` defaults to `mock`, which runs fully offline with a
deterministic provider (`mock-fast`, `mock-smart`). Outside production,
if `API_KEYS` is unset the implicit dev key is `dev-local-key`.

### Example requests (dev defaults)

```bash
curl http://localhost:3000/health

curl -H "Authorization: Bearer dev-local-key" http://localhost:3000/v1/models

curl -H "Authorization: Bearer dev-local-key" -H "Content-Type: application/json" \
  -d '{"model":"mock-fast","messages":[{"role":"user","content":"hello"}]}' \
  http://localhost:3000/v1/chat/completions

curl -N -H "Authorization: Bearer dev-local-key" -H "Content-Type: application/json" \
  -d '{"model":"mock-fast","messages":[{"role":"user","content":"hello"}],"stream":true}' \
  http://localhost:3000/v1/chat/completions

curl -H "Authorization: Bearer dev-local-key" http://localhost:3000/usage
```

More: [`tests/api/EXAMPLES.md`](tests/api/EXAMPLES.md).

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/health` | public | lightweight, no provider calls |
| GET | `/v1/models` | ✅ | OpenAI list format |
| POST | `/v1/chat/completions` | ✅ | streaming + non-streaming |
| GET | `/usage` | ✅ | local counters + provider usage |

## Configuration

All configuration is environment-variable based — start from
[`.env.example`](.env.example). Key switches: `PROVIDER_MODE` (`mock` |
`antigravity`), `API_KEYS` (comma-separated; required in production),
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
├── core/        # usage tracker, chunk mapping, error envelope, ids
├── routes/      # /v1/chat/completions, /v1/models, /usage, /health
├── providers/   # AIProvider implementations: mock + antigravity (+ SSE, tokens)
├── middleware/  # auth, rate limit, CORS, error handler
├── security/    # redaction, ephemeral token store
├── config/      # zod-validated environment loader
├── types/       # frozen shared contracts (provider/config/openai)
├── app.ts       # Fastify app builder (routes only)
└── server.ts    # composition root
tests/           # vitest: api/, providers/, security/, config/, smoke
scripts/         # smoke-e2e.mjs (coordinator end-to-end check)
```

## License

UNLICENSED — personal use. The Antigravity integration is a clean-room,
OMP-inspired implementation; review `docs/omp-analysis.md` for the
license/reuse verdict before redistributing.
