# Security Model and Architecture — personal-antigravity-api

Maintenance update: both token-cache write paths now use the credential store's
AES-256-GCM envelope. Keyless operation uses memory only. See
[cache migration and reliability](api-reliability.md) for failure/recovery behavior.

> **MANDATORY RISK STATEMENT:**
> Antigravity OAuth integration through third-party applications is unofficial and may violate Google's Terms of Service. Use of this software carries a risk of Google account suspension or termination.
> - This project does **NOT** attempt to circumvent provider restrictions, quotas, rate limits, or safety guardrails.
> - **Zero credential exposure:** No upstream OAuth credentials (access tokens, refresh tokens, client secrets) are EVER exposed or returned via any HTTP API endpoint or logged in server telemetry.
> - Live Antigravity integration is **experimental**. The live path was verified locally on **2026-10-17** (browser OAuth connect, non-stream chat, SSE streaming with a personal account); long-term behavior (token refresh over time, deployed environment) remains unverified. Antigravity is the only runtime provider. Automated tests use isolated test doubles and local upstream servers.

---

## 1. Threat Model & Security Posture

`personal-antigravity-api` is designed as a **single-user personal gateway** pairing an OpenAI-compatible REST API for developer tools (e.g. Cline, Cursor, Continue) with a self-contained **Account Management Dashboard** (`/admin`) for credential maintenance.

```
+------------------+         Bearer Auth + Rate Limit        +----------------------------+
|  Client Tool     | =====================================>  |  personal-antigravity-api  |
|  (Cline/Cursor)  | <=====================================  |  (Fastify + Security Hooks)|
+------------------+         CORS + Redacted Logging         +----------------------------+
                                                                     |            |
                                                      Session Auth   |            | Upstream Calls
                                                      + CSRF Guard   |            v
                                                                     |     +--------------------+
                                                                     v     | Antigravity        |
                                                              +------------+ (Google)    |
                                                              | /admin UI  +--------------------+
                                                              | Dashboard  |
                                                              +------------+
```

---

## 2. Authentication Architecture

### 2.1 Developer API Keys (`/v1/**`, `/usage`)
- Protected API routes require a valid HTTP Bearer token:
  ```http
  Authorization: Bearer <your-configured-api-key>
  ```
- **Production Enforcement:** When `NODE_ENV=production`, `API_KEYS` is strictly required. If the environment variable is missing or empty, the application fails fast and refuses to boot.
- **Development Safety Net:** Outside production (`NODE_ENV=development` or `NODE_ENV=test`), an empty `API_KEYS` falls back to the default `dev-local-key` accompanied by diagnostic console warnings.
- **Constant-Time Verification:** Keys are verified using `crypto.timingSafeEqual` over SHA-256 digests. Because SHA-256 produces a fixed 32-byte digest regardless of key length, length comparison leaks and character-by-character timing leaks are eliminated.
- **Public & Bypassed Endpoints:**
  - `GET /health` is explicitly public (query parameters tolerated) for automated heartbeat monitors.
  - `OPTIONS *` CORS preflights are public per HTTP specification.
  - **Why `/admin` bypasses Bearer:** All `/admin*` paths bypass the global Bearer auth hook because the admin dashboard implements its own dedicated session-based authentication layer. Bearer API keys are neither accepted nor valid on `/admin`, and admin session cookies cannot authenticate `/v1/**` requests.

### 2.2 Admin Authentication (`/admin`)
- **Single-Admin Model:** Built for personal use by a single operator.
- **Password Verification:** The operator provides an admin password. In production, `ADMIN_PASSWORD_HASH` is formatted as `scrypt$N$r$p$<saltB64>$<hashB64>` (generated via `node scripts/hash-admin-password.mjs`). Password checks use scrypt derivation followed by constant-time buffer comparison (`crypto.timingSafeEqual`).
- **Session Management:**
  - **In-Memory Store:** Sessions reside in memory (`SessionStore`), keyed by 256-bit cryptographically random tokens (`crypto.randomBytes(32).toString("base64url")`).
  - **Sliding Expiry:** Configured with a default TTL of 12 hours (`ADMIN_SESSION_TTL_MS=43200000`). Each successful request resets `expiresAt = now + ttlMs`.
  - **Session Cap & Eviction:** Capped at 1,000 active sessions to prevent unauthenticated memory exhaustion. If capacity is reached, the store evicts the soonest-expiring session.
  - **Cookie Security:** Cookies are set with strict security attributes: `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` when on HTTPS or production.

### 2.3 Cross-Site Request Forgery (CSRF) Protection
- Browsers submit session cookies automatically on cross-site requests. Relying solely on `SameSite=Lax` is insufficient for defense-in-depth against top-level GET navigations or subdomains.
- Every admin session generates a dedicated cryptographically random CSRF token (`csrfToken`).
- All state-changing POST endpoints under `/admin` (`/admin/actions/*`, `/admin/logout`) require this token either via the `x-csrf-token` header or the `_csrf` form body field.
- Comparison uses `crypto.timingSafeEqual` and strictly rejects length mismatches or empty tokens with `403 Forbidden`.

### 2.4 Login Rate Limiting
- `POST /admin/login` is protected by a dedicated fixed-window rate limiter (`createFixedWindowLimiter`).
- Defaults to **5 attempts per 5 minutes per client IP** (`ADMIN_LOGIN_WINDOW_MS=300000`, `ADMIN_LOGIN_MAX=5`).
- Repeated failures trigger a `429 Too Many Requests` response with a standard `Retry-After` header.

---

## 3. Credential Encryption at Rest

Upstream Google OAuth refresh tokens represent persistent access to the operator's account and must be protected with rigorous encryption at rest:

```
+------------------------------------+
| StoredAntigravityCredentials (JSON)|
+------------------------------------+
                  |
                  v
       +-----------------------+
       | AES-256-GCM Envelope  |
       |  - 16-byte random salt|
       |  - 12-byte random IV  |
       |  - 16-byte GCM tag    |
       |  - Encrypted payload  |
       +-----------------------+
                  |
                  v
+------------------------------------+
| Disk File OR Remote Redis Instance |
| (Plaintext tokens NEVER hit store) |
+------------------------------------+
```

- **Algorithm:** AES-256-GCM envelope encryption.
- **Key Derivation:** If `CREDENTIAL_ENCRYPTION_KEY` decodes to exactly 32 bytes from base64, that 256-bit key is used directly. Otherwise, scrypt derives a 32-byte key using a fresh, random 16-byte salt per encryption operation.
- **Envelope Structure:**
  ```json
  {
    "v": 1,
    "kdf": "scrypt",
    "salt": "<base64-salt>",
    "iv": "<base64-iv>",
    "tag": "<base64-gcm-tag>",
    "data": "<base64-ciphertext>"
  }
  ```
- **Client-Side Encryption Before Redis:** When `REDIS_URL` is configured, credentials are encrypted locally inside Node.js *before* transmission over TCP/TLS to Redis. The Redis server only ever sees the encrypted envelope under `antigravity:credentials:v1`.
- **Fail-Closed Enforcement:** If the admin dashboard is enabled without `CREDENTIAL_ENCRYPTION_KEY`, startup fails immediately. Any corrupt payload, authentication tag mismatch, or wrong key throws a typed `CredentialStoreError` and never leaks partial data.

---

## 4. Token Non-Exposure Invariant

A foundational invariant of this project is that **plaintext credentials never cross security boundaries**:
- Upstream access tokens, refresh tokens, and client secrets are NEVER included in response bodies or headers of ANY `/admin` or `/v1` endpoint.
- `/admin/api/status` exposes a strict whitelist of non-sensitive metadata (e.g. `connected: boolean`, `accountHint: "user***@gmail.com"`, masked client ID).
- Automated test suites assert that sentinel token strings never appear in any response body, header, or stored file.

---

## 5. Rate Limiting & Proxy Trust

- **In-Memory Fixed Window:** Tracks request counts within a window (`RATE_LIMIT_WINDOW_MS`, default 60s).
- **Key Partitioning:**
  - Authenticated API requests: `key:<api_key>`
  - Unauthenticated requests: `ip:<ip_address>`
- **Proxy-Aware Client IP:** When `TRUST_PROXY=true` (critical on Render), `getClientIp` parses `X-Forwarded-For`.
- **Response Headers:** Emits standard `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After`.

---

## 6. Structured Logging & Secret Redaction

- Log output is emitted as structured JSON via Pino.
- The frozen `REDACT_LOG_PATHS` list enforces automatic censorship of sensitive fields:
  - `req.headers.authorization`
  - `req.headers.cookie`
  - `res.headers['set-cookie']`
  - Deep wildcard fields: `*.apiKey`, `*.api_key`, `*.accessToken`, `*.access_token`, `*.refreshToken`, `*.refresh_token`, `*.clientSecret`, `*.client_secret`, `*.password`, `*.token`.
- Redacted fields are replaced with `"[Redacted]"`.
- Stack traces are completely suppressed in production HTTP response envelopes.

---

## 7. Residual Risks & Operator Responsibilities

Operators should note the following inherent security considerations:
1. **Unofficial OAuth ToS Risk:** Using third-party OAuth flows with Antigravity endpoints is unofficial and carries a risk of account suspension by Google.
2. **In-Memory Sessions:** Dashboard sessions are stored in process memory. Any server reboot, deployment, or sleep cycle invalidates active sessions, requiring the operator to log in again.
3. **Password Strength:** The application enforces rate limiting but does not enforce password complexity. Choosing a high-entropy password for `ADMIN_PASSWORD_HASH` is the operator's responsibility.
4. **No Multi-Factor Authentication (MFA):** The dashboard is designed for personal single-user operation and does not support 2FA/TOTP. Operators requiring additional security should protect the domain using Cloudflare Access or a VPN.
