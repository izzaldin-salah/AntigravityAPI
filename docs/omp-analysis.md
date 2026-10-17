# Oh My Pi (OMP) Architecture Analysis: Google Antigravity Provider

> **Risk Notice & Google Terms of Service Warning:**
> Antigravity OAuth integration through third-party applications is unofficial and may violate Google's Terms of Service; account suspension is possible. This project does not attempt to circumvent provider restrictions. The live Antigravity path in this gateway ships as **EXPERIMENTAL / UNVERIFIED** unless validated against live credentials. Antigravity is the only supported runtime provider; tests use isolated local fixtures.

---

## 1. Executive Summary & Context

This document analyzes the architecture, authentication, protocol wire format, streaming semantics, and credential management found in the [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) repository for the Google Antigravity provider. It maps these findings onto the `AIProvider` contract for `personal-antigravity-api`.

OMP implements Antigravity access by authenticating against Google Cloud Code Assist (`daily-cloudcode-pa.googleapis.com`) using Google OAuth credentials, enabling access to Gemini and Claude models hosted within Google's developer infrastructure.

---

## 2. Cited Sources (Actually Read)

During the bounded research phase, the following upstream files from `https://github.com/can1357/oh-my-pi` (branch `HEAD`) were inspected:

1. `packages/ai/src/registry/oauth/google-antigravity.ts` — Cloud Code Assist account discovery, free-tier provisioning (`loadCodeAssist`, `onboardUser`), project resolution.
2. `packages/ai/src/providers/google-gemini-cli.ts` — Antigravity request generation, session envelope formatting, endpoint routing (`streamGenerateContent`), SSE response parsing, error handling, leak prevention.
3. `packages/ai/src/providers/google-shared.ts` — Content/part conversion, thought signature management, usage metadata mapping (`mapGoogleUsage`), finish reason mapping.
4. `packages/ai/src/auth-storage.ts` — Credential storage architecture, namespaces, key cascade, session affinity.
5. `packages/ai/src/registry/oauth/google-oauth-shared.ts` — Provisioning timeouts, OAuth fetch wrapping, login cancellation.
6. `packages/ai/src/usage/google-antigravity.ts` — Quota discovery endpoints (`/v1internal:retrieveUserQuotaSummary`, `/v1internal:fetchAvailableModels`), window classification, quota deduction.
7. `packages/coding-agent/src/config/model-provider-discovery.ts` — Dynamic model discovery, OAuth multi-account handling, token and project ID extraction.
8. `packages/ai/src/auth/refresh.ts` — Single-flighted token refresh leases, 60s expiry skew (`OAUTH_REFRESH_SKEW_MS`), credential merging.
9. `packages/ai/src/registry/oauth/index.ts` — Provider registration, structured JSON credential serialization, expiry normalization.
10. `packages/ai/src/registry/index.ts` & `packages/ai/src/registry/registry.ts` — Provider definitions and registry tables.
11. `packages/ai/src/registry/build.ts` — KDL policy materialization and transport compilation.
12. `packages/ai/src/registry/engine/refresh.ts` — OAuth token POST refresh mechanics (`grant_type: "refresh_token"`).
13. `LICENSE` — Project licensing (MIT License).

*(Note: `packages/catalog/rules/auth/google-antigravity.kdl` returned 404, with logic residing in compiled KDL/TypeScript modules).*

---

## 3. Auth Architecture & Token Lifecycle

### 3.1 OAuth Mechanics
- **Grant Types:** Initial interactive login uses Google Authorization Code flow. Token refreshing uses `grant_type: "refresh_token"` against Google's standard OAuth2 token endpoint (`https://oauth2.googleapis.com/token`).
- **Required Credentials:**
  - `refreshToken`: The primary persistent secret.
  - `clientId` & `clientSecret`: Google OAuth client credentials (application credentials).
  - `accessToken`: Ephemeral bearer token minted for requests.
  - `projectId`: Google Cloud companion project identifier (`cloudaicompanionProject`) returned by the Code Assist API.

### 3.2 State Management & Token Skew
- **Expiration Skew:** OMP enforces an `OAUTH_REFRESH_SKEW_MS` of 60,000 ms (60 seconds). A token is proactively refreshed if `now + 60s >= expiresAt` to prevent mid-flight token expiration.
- **Refresh Flow:**
  - POST to `https://oauth2.googleapis.com/token` (or configured auth endpoint).
  - Content-Type: `application/x-www-form-urlencoded` or `application/json`.
  - Body: `grant_type=refresh_token&client_id=<id>&client_secret=<secret>&refresh_token=<token>`.
  - Upstream responds with `{ access_token, expires_in, token_type: "Bearer" }`.
- **401 Handling:** If an upstream call returns HTTP 401 Unauthorized, the provider attempts a single token refresh and replays the request. To prevent infinite loops, at most one refresh is permitted per request.
- **Storage & Caching:**
  - In our architecture, `config.credentials.tokenStorePath` optionally persists token JSON (e.g., `{ accessToken, refreshToken, expiresAt, projectId }`).
  - Read/write operations to this file are best-effort: failures never crash the server. Render Free disk is ephemeral, so persistent credentials come via environment variables (`ANTIGRAVITY_REFRESH_TOKEN`).

### 3.3 Security & Secret Redaction
- Secrets (`accessToken`, `refreshToken`, `clientSecret`) must never appear in logs, error objects, or stack traces.
- Error messages must redact tokens and provide high-level error messages (e.g., "OAuth token refresh failed").

---

## 4. Upstream Request Implementation (Endpoints, Headers, Body)

### 4.1 Base Endpoints
- **Primary Daily Endpoint:** `https://daily-cloudcode-pa.googleapis.com`
- **Fallback Sandbox Endpoint:** `https://daily-cloudcode-pa.sandbox.googleapis.com`
- **Standard Endpoint:** `https://cloudcode-pa.googleapis.com`
- **Streaming RPC Path:** `/v1internal:streamGenerateContent?alt=sse`
- **Model Discovery Path:** `/v1internal:fetchAvailableModels`
- **Quota Summary Path:** `/v1internal:retrieveUserQuotaSummary`

### 4.2 Request Headers
```http
POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1
Host: daily-cloudcode-pa.googleapis.com
Authorization: Bearer <accessToken>
Content-Type: application/json
Accept: text/event-stream
User-Agent: antigravity
```

### 4.3 Request Body Shape
OMP packages requests inside a Cloud Code Assist wrapper:
```json
{
  "project": "<projectId>",
  "model": "<wireModelId>",
  "request": {
    "contents": [
      {
        "role": "user",
        "parts": [{ "text": "Hello world" }]
      }
    ],
    "systemInstruction": {
      "role": "user",
      "parts": [{ "text": "You are a helpful assistant." }]
    },
    "generationConfig": {
      "temperature": 0.7,
      "maxOutputTokens": 2048
    },
    "sessionId": "session_1234567890",
    "labels": {
      "trajectory_id": "traj_abc",
      "last_step_index": "1"
    }
  },
  "userAgent": "antigravity",
  "requestType": "agent",
  "requestId": "agent/gw/1234567890/abc/1"
}
```

---

## 5. Streaming Semantics & Event Normalization

### 5.1 Upstream Server-Sent Events (SSE) Wire Format
Upstream streams frames of the form:
```
data: {"response":{"responseId":"...","candidates":[{"content":{"parts":[{"text":"chunk"}]},"finishReason":"STOP"}]}}
```
OMP inspects `candidate.finishReason` and filters `thought: true` parts during ordinary user generation.

### 5.2 Stream Events Mapping to `ProviderEvent`
1. **Start:** Emit `{ type: "start", id, model, created }` upon receiving first valid response chunk.
2. **Deltas:**
   - Text parts with `thought: false` or omitted `thought` -> `{ type: "delta", text }`.
   - Tool calls inside parts (`functionCall`) -> `{ type: "tool_call_delta", index, id, name, argumentsDelta }`.
3. **Usage:** Extracted from `usageMetadata` -> `{ type: "usage", usage: { promptTokens, completionTokens, totalTokens } }`.
4. **Done:** Emitted when `finishReason` is encountered (`STOP` -> `stop`, `MAX_TOKENS` -> `length`) -> `{ type: "done", finishReason, usage }`.
5. **Errors:** Mid-stream error objects (`chunk.error`) or disconnects emit terminal `{ type: "error", error: { code, message } }`.

---

## 6. Bun vs. Node / OMP Package Dependencies

OMP is written specifically for the Bun runtime with tight internal monorepo dependencies:
- Monorepo packages: `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`, `@oh-my-pi/pi-utils`, `@oh-my-pi/omptype`.
- Runtime dependencies: `Bun.sleep`, `bun:sqlite`.

**Translation for `personal-antigravity-api` (Node 24 + TypeScript):**
- Use standard `node:crypto` (`randomUUID`, `createHash`, `randomBytes`) for ID generation, PKCE pairs, and secret hashing.
- Use native `timers/promises` for timeouts/delays.
- Use global `fetch` (with dependency injection for testing).
- Use Node 16 CommonJS output module resolution.
- Keep dependencies zero-additional (adhering strictly to frozen `package.json`).

---

## 7. Model Discovery & Static Fallback

Cloud Code Assist allows querying models via `POST /v1internal:fetchAvailableModels` with `{ project: "<projectId>" }`.
However, because live credentials may be absent or network access restricted, `AntigravityProvider` supplies a verified static fallback model list derived from OMP:
- `gemini-2.5-flash`
- `gemini-2.5-pro`
- `gemini-3-flash`
- `gemini-3-pro`
- `claude-3-5-sonnet`

---

## 8. License & Reuse Verdict

- **Repository License:** MIT License (Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük, Copyright (c) 2026 Stencil Labs, Inc.).
- **Verdict:** Fully permissible for clean-room implementation and architectural adaptation under MIT terms with attribution. No closed-source restrictions.

---

## 9. Mapping to our `AIProvider` Interface

| `AIProvider` Method | Implementation in `AntigravityProvider` |
| --- | --- |
| `id` | `"antigravity"` |
| `listModels()` | Returns static fallback models, or queries `/v1internal:fetchAvailableModels` when live token is present. |
| `chat(request)` | Returns `AsyncIterable<ProviderEvent>`, managing token lifecycle, request encoding, SSE parsing, and canonical error mapping. Fails fast pointing to `/admin` when `needsReconnect` is true. |
| `getUsage()` | Returns accumulated session usage or queries `/v1internal:retrieveUserQuotaSummary`. |
| `healthCheck()` | Returns `{ ok: true, detail: "..." }`. |
| `getAccountStatus()` | *(v1.1 additive)* Returns `AntigravityAccountStatus` (providerMode, connected, hasRefreshToken, accessTokenExpiresAt, projectId, clientIdMasked, needsReconnect, lastRefreshAt, lastError) — strictly whitelisted, zero secrets leaked. |

---

## 10. Explicit List of UNVERIFIED Assumptions

Because no live Google Antigravity credentials or live cloud environment were available in this isolated worktree, the following assumptions were marked **UNVERIFIED**. **Note (2026-10-17):** local live verification with a personal account has since resolved the items annotated below; unannotated items remain unverified.
1. **Live Response Wire Format:** Whether Google's production Cloud Code Assist endpoint returns candidate payloads identical to our parsed structures without undocumented framing. — **2026-10-17: verified locally** (non-stream + SSE responses parsed cleanly, usage extracted; no undocumented framing encountered).
2. **Project Auto-Provisioning:** Whether calling `/v1internal:onboardUser` succeeds automatically for arbitrary Google accounts without manual web console acceptance. — **2026-10-17: not exercised**; requests succeeded with project `default`, so onboarding was not needed for this account.
3. **Session ID & Trajectory Labels:** Whether the upstream service strictly requires `labels.trajectory_id` and `sessionId` in specific formats to prevent server-side rejection. — **2026-10-17: accepted live** (requests with `sessionId` + trajectory labels completed without rejection).
4. **Third-Party Model Availability:** Whether Claude models remain enabled and reachable on the same endpoint across all tiers without specific enterprise grants. — **2026-10-17: partially resolved** — the connected account's `/v1internal:fetchAvailableModels` lists `claude-sonnet-4-6` and `claude-opus-4-6-thinking`; no live Claude completion call made yet.
5. **Live Google OAuth Authorization:** Whether arbitrary user Google accounts can authorize the unofficial client scopes without Google consent verification blockers. — **2026-10-17: verified locally for one personal account** (community client pair, Authorization Code + PKCE; scopes email/openid/userinfo.email/cloud-platform granted; minted refresh token served live chat + streaming). Generalizability to arbitrary accounts remains unknown.

---

## 11. v1.1 Account Management Dashboard & OAuth Service Architecture

### 11.1 Google OAuth 2.0 PKCE & Authorization Code Flow
- **Seam:** `createOAuthService(options: OAuthServiceOptions): OAuthService` in `src/providers/oauth.ts`.
- **PKCE Pair Generation:** Generates a 43+ char base64url random verifier (`crypto.randomBytes(32)`) and an S256 code challenge (`crypto.createHash("sha256").update(verifier).digest("base64url")`).
- **Authorize URL Construction:** Uses Google authorization endpoint (`https://accounts.google.com/o/oauth2/v2/auth`, overridable for tests) with `response_type=code`, `access_type=offline`, `prompt=consent`, `code_challenge_method=S256`.
- **Code Exchange:** Server-to-server POST to `tokenEndpoint` (`https://oauth2.googleapis.com/token`, overridable for tests). Requires a `refresh_token` in response; decodes only the `id_token` payload to derive a safe, masked `accountHint` (e.g. `u***@domain.com`). Never logs or leaks token bodies.
- **Test Refresh:** Validates operator-supplied refresh tokens before storage via a direct POST with `grant_type=refresh_token`.

### 11.2 Credential Store & Dynamic Resolution
- **Request-time Resolution:**
  1. Constructor env credentials (if provided).
  2. `credentialStore.load()` cached in memory (picked up on next request without restart).
  3. No credentials -> fail fast with `ProviderError` unauthorized pointing to `/admin`.
- **needsReconnect State Machine:**
  - Transition to `true` when a token refresh is rejected (400/401 / `invalid_grant`) with redacted error message.
  - Fail fast on `chat()` without making unauthenticated upstream network calls.
  - Transition to `false` when a refresh succeeds or when new credentials are saved/loaded from the store.
