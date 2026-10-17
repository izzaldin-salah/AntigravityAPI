# Security Model and Architecture — personal-antigravity-api

> **MANDATORY RISK STATEMENT:**
> Antigravity OAuth integration through third-party applications is unofficial and may violate Google's Terms of Service. Use of this software carries a risk of Google account suspension or termination.
> - This project does **NOT** attempt to circumvent provider restrictions, quotas, rate limits, or safety guardrails.
> - **Zero credential exposure:** No upstream OAuth credentials (access tokens, refresh tokens, client secrets) are EVER exposed or returned via any HTTP API endpoint or logged in server telemetry.
> - Live Antigravity integration is considered **experimental and unverified**. The default `PROVIDER_MODE=mock` provides an entirely safe, offline development environment.

---

## 1. Threat Model & Security Posture

`personal-antigravity-api` is designed as a **single-user personal gateway**. It exposes an OpenAI-compatible REST API interface meant to be accessed by your trusted local tools (e.g. Cline, Cursor, Continue, custom scripts) while proxying requests to an upstream provider.

```
+------------------+         Bearer Auth + Rate Limit        +----------------------------+
|  Client Tool     | =====================================>  |  personal-antigravity-api  |
|  (Cline/Cursor)  | <=====================================  |  (Fastify + Security Hooks)|
+------------------+         CORS + Redacted Logging         +----------------------------+
                                                                            |
                                                                            | Upstream Calls
                                                                            v
                                                             +----------------------------+
                                                             |   Antigravity Provider     |
                                                             |   (Google / Mock Engine)   |
                                                             +----------------------------+
```

---

## 2. Authentication Architecture

### 2.1 Single-User API Keys
- Protected routes require a valid HTTP Bearer token:
  ```http
  Authorization: Bearer <your-configured-api-key>
  ```
- **Production Enforcement:** When `NODE_ENV=production`, `API_KEYS` is strictly required. If the environment variable is missing or empty, the application fails fast and refuses to boot.
- **Development Safety Net:** Outside production (`NODE_ENV=development` or `NODE_ENV=test`), an empty `API_KEYS` falls back to the default `dev-local-key` accompanied by diagnostic console warnings.
- **Constant-Time Verification:** To defend against remote timing side-channel attacks, keys are verified using `crypto.timingSafeEqual` over SHA-256 digests. Because SHA-256 produces a fixed 32-byte digest regardless of key length, length comparison leaks and character-by-character timing leaks are eliminated.
- **Public Endpoints:**
  - `GET /health` is explicitly public to allow automated heartbeat monitors (e.g. UptimeRobot) without leaking sensitive configuration.
  - `OPTIONS *` CORS preflights are public per HTTP specification.
  - All other routes (`/v1/chat/completions`, `/v1/models`, `/usage`) reject unauthorized requests with `401 Unauthorized` (`invalid_api_key`).

---

## 3. Rate Limiting

- **In-Memory Fixed Window:** Tracks request counts within a sliding fixed window (`RATE_LIMIT_WINDOW_MS`, default 60 seconds).
- **Key Partitioning:**
  - Authenticated requests are keyed strictly by their **API key** (`key:<api_key>`).
  - Unauthenticated requests are keyed by **Client IP** (`ip:<ip_address>`).
- **Proxy-Aware Client IP:** When `TRUST_PROXY=true` (required on Render), the rate limiter parses the incoming `X-Forwarded-For` header to extract the true client IP.
- **Response Headers:** All requests include standard rate limit headers:
  - `X-RateLimit-Limit`: Maximum requests permitted per window.
  - `X-RateLimit-Remaining`: Remaining allowance for the current window.
  - `X-RateLimit-Reset`: UTC epoch timestamp (in seconds) when the window resets.
- **Exceeded Limit Handling:** When request count exceeds `RATE_LIMIT_MAX`, the server returns `429 Too Many Requests` with a `Retry-After` header and an OpenAI-standard JSON error envelope (`rate_limit_exceeded`).
- **Disable Flag:** Setting `RATE_LIMIT_MAX=0` completely disables rate limiting for benchmarking or local debugging.

---

## 4. Cross-Origin Resource Sharing (CORS)

- Handled via `@fastify/cors` registered at application startup.
- Configurable via `CORS_ORIGINS`:
  - Wildcard `*` allows any web-based client application.
  - Comma-delimited list (e.g. `https://myclient.example.com,http://localhost:5173`) restricts access to explicit domains.
- Exposed headers include `X-Request-Id`, `X-RateLimit-*`, and `Retry-After`.

---

## 5. Structured Logging & Secret Redaction

- Log output is emitted as structured JSON via Pino.
- The frozen `REDACT_LOG_PATHS` list enforces automatic censorship of sensitive fields:
  - `req.headers.authorization`
  - `req.headers.cookie`
  - `res.headers['set-cookie']`
  - Deep wildcard fields: `*.apiKey`, `*.api_key`, `*.accessToken`, `*.access_token`, `*.refreshToken`, `*.refresh_token`, `*.clientSecret`, `*.client_secret`, `*.password`, `*.token`.
- Redacted fields are replaced with the fixed sentinel `"[Redacted]"`.
- Stack traces are completely suppressed in production HTTP response envelopes to prevent information leakage.

---

## 6. Credential Storage & Ephemeral Lifecycle

- **Environment-First Precedence:**
  Credentials defined in process environment variables always override cached values.
- **Render Ephemeral Filesystem:**
  Render Free container disks are ephemeral. Any cached files under `./.data/` are deleted upon container restart or sleep.
  - The local token store (`ANTIGRAVITY_TOKEN_STORE_PATH`) is solely an **ephemeral performance cache** to reduce roundtrips during an active container session.
  - The persistent source of truth is the `ANTIGRAVITY_REFRESH_TOKEN` environment variable entered directly in the Render Dashboard.
- **Atomic File Operations:**
  When writing token cache files, operations use a temporary-file write followed by atomic rename (`0600` owner-only permissions) to avoid corrupt reads by concurrent worker processes.
