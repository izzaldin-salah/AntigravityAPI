# Personal Antigravity API

Personal, OpenAI-compatible REST API gateway for an Antigravity provider.
TypeScript + Fastify + SSE. Native Node.js deployment on Render Free (no Docker).

> **Status: under construction.** This repository is being built by a coordinator
> plus three delegated agents (provider / API / deployment). The frozen
> architecture and interfaces live in [`docs/architecture-contract.md`](docs/architecture-contract.md).

> **Risk notice:** Antigravity OAuth integration through third-party applications is
> unofficial, may violate Google's Terms of Service, and carries account-suspension
> risk. This project does not attempt to circumvent provider restrictions.
> See `docs/security.md` once published.

## Documentation

| Document | Description |
| --- | --- |
| `docs/architecture-contract.md` | Frozen architecture, shared interfaces, API contract, ownership |
| `docs/omp-analysis.md` | Oh My Pi (OMP) analysis — auth, streaming, usage (provider agent) |
| `docs/deployment.md` | Render Free + UptimeRobot deployment guide (deployment agent) |
| `docs/security.md` | Security model and limitations (deployment agent) |

## Quick start

Documented commands will be finalized in the delivery stage:

```bash
npm ci
npm run build
npm test
npm start        # http://localhost:3000
```

The default `PROVIDER_MODE=mock` runs fully offline with a deterministic mock provider.
The `antigravity` mode is experimental and unverified until live credentials are tested.
