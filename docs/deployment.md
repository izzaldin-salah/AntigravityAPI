# Deployment Guide — Render Free + UptimeRobot

> **Risk Notice & Terms of Service Warning:**
> Antigravity OAuth integration through third-party applications is unofficial and may violate Google's Terms of Service. Account suspension is possible. This project does not attempt to circumvent provider restrictions. The live Antigravity path is experimental — verified locally on 2026-10-17 (OAuth connect, chat, SSE with a personal account) but not yet verified on Render; the mock provider remains the safe, offline default.

This document describes deploying `personal-antigravity-api` to a **Render Free Web Service** using native Node.js (no Docker), paired with an **UptimeRobot** heartbeat monitor to keep the service responsive, along with configuring the **Account Management Dashboard** for managing provider credentials.

---

## 1. Architectural Philosophy: Native Node.js (No Docker)

`personal-antigravity-api` is intentionally designed to run directly on native Node.js:
- **No Dockerfiles, Docker Compose, or container overhead:** Render builds and runs the application directly in its optimized Node runtime.
- **Fast builds:** Native `npm ci && npm run build` avoids container layer caching issues and multi-gigabyte image pulls.
- **Minimal resource consumption:** The lightweight Fastify process stays comfortably within Render's free tier memory bounds (512 MB).

---

## 2. Step-by-Step Render Deployment

### Step 2.1: Push Repository to GitHub
Push your branch/repository to your personal GitHub account:
```bash
git push -u origin main
```

### Step 2.2: Create a New Web Service on Render
1. Log into your [Render Dashboard](https://dashboard.render.com).
2. Click **New +** and select **Web Service**.
3. Connect your GitHub repository.
4. If using Render Blueprints, Render will automatically detect [`render.yaml`](../render.yaml).
5. If configuring manually in the dashboard, set the following parameters:
   - **Name:** `personal-antigravity-api` (or your preferred name)
   - **Region:** Choose the region nearest to you
   - **Branch:** `main` (or your default branch)
   - **Runtime:** `Node` (Native Node.js — do NOT select Docker)
   - **Build Command:** `npm ci && npm run build`
   - **Start Command:** `npm start`
   - **Plan Type:** `Free`
   - **Health Check Path:** `/health`
   - **Auto-Deploy:** `Yes`

---

## 3. Account Dashboard Configuration (v1.1)

The Account Management Dashboard (`/admin`) allows you to connect, inspect, and switch Antigravity Google accounts directly from your browser or via automation.

### 3.1 Generate Credentials Locally
Before configuring your deployment, generate an admin password hash and credential encryption key on your local machine:

1. **Admin Password Hash:**
   ```bash
   node scripts/hash-admin-password.mjs "your-strong-password"
   # Output: scrypt$16384$8$1$...
   ```
2. **Credential Encryption Key (AES-256-GCM):**
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   # Output: 44-character base64 string
   ```

### 3.2 Dashboard Enablement Logic (`DASHBOARD_ENABLED`)
- `auto` (default): The dashboard is automatically enabled if and only if an admin password (`ADMIN_PASSWORD_HASH` or `ADMIN_PASSWORD`) is provided. If no password is set, `/admin` renders a static "not configured" page.
- `true`: Explicitly forces the dashboard on. Requires `ADMIN_PASSWORD_HASH` (or `ADMIN_PASSWORD`) and `CREDENTIAL_ENCRYPTION_KEY`; otherwise the server fails closed on startup.
- `false`: Explicitly disables the dashboard, even if credentials are present in the environment.

### 3.3 Credential Persistence & Durability Truth Table
Antigravity OAuth refresh credentials are encrypted with AES-256-GCM before writing to storage. Choose your persistence backend wisely based on deployment targets:

| Backend | Configuration | Durability on Render Free | Reconnect After Restart? | Account Switching Without Redeploy? |
|---|---|---|---|---|
| **Redis** *(Recommended for Production)* | `CREDENTIAL_STORE=auto` + `REDIS_URL` | **Durable** (survives restarts, sleeps, redeploys) | **No** (tokens persist across sleep cycles) | **Yes** (connect or switch via dashboard anytime) |
| **File** *(Local Dev Only)* | `CREDENTIAL_STORE=file` (or `auto` without `REDIS_URL`) | **Ephemeral** (wiped on restart/sleep) | **Yes** (credentials lost when container spins down) | **No** (wiped on next container restart) |

> **Render Free Ephemeral Filesystem Warning:**
> Render Free instances wipe local disk storage whenever the instance sleeps or redeploys. If using `CREDENTIAL_STORE=file` on Render, stored credentials will be lost on container restart, requiring you to re-authenticate via the dashboard.
> To persist credentials durably on Render, create a free **Render Key Value** instance and paste its connection URL into `REDIS_URL`, or use an external free Redis instance (such as [Upstash](https://upstash.com)).

### 3.4 Google OAuth Client Setup
If you want to use the browser-based OAuth connect flow (`/admin/actions/connect`), configure your Google Cloud OAuth 2.0 Web Client:

1. Open your Google Cloud Console Credentials page.
2. Under **Authorized redirect URIs**, add **both** of the following callback URLs:
   - `http://127.0.0.1:3000/admin/oauth/callback` (for local development)
   - `https://<your-render-subdomain>.onrender.com/admin/oauth/callback` (for Render production)
3. Set `OAUTH_REDIRECT_BASE_URL` in Render to your public URL:
   ```env
   OAUTH_REDIRECT_BASE_URL=https://<your-render-subdomain>.onrender.com
   ```
4. If your Google OAuth client does not permit external apps or throws policy errors, you can always use the **Manual Credential** form on the dashboard to supply your refresh token directly.

---

## 4. Environment Variables Reference

Configure the following environment variables in the Render Dashboard (**Environment** tab). Variables marked **Secret** must never be committed to source control.

| Variable | Required in Prod? | Secret? | Recommended Render Value | Description |
|---|---|---|---|---|
| `NODE_ENV` | Yes | No | `production` | Enforces production security; requires `API_KEYS`. |
| `HOST` | No | No | `0.0.0.0` | Bind host. Render requires `0.0.0.0`. |
| `PORT` | Auto | No | *(Leave blank)* | Injected automatically by Render (usually `10000`). |
| `LOG_LEVEL` | No | No | `info` | Logging verbosity (`info`, `warn`, `error`). |
| `TRUST_PROXY` | **Yes** | No | `true` | **Critical on Render:** Trust `X-Forwarded-For` for IP rate-limiting. |
| `API_KEYS` | **Yes** | **Yes** | `your-secure-random-key` | Comma-separated list of Bearer keys. **Refuses to start if empty.** |
| `RATE_LIMIT_WINDOW_MS` | No | No | `60000` | Fixed rate limit window in milliseconds (default: 1 min). |
| `RATE_LIMIT_MAX` | No | No | `60` | Max requests per window per API key/IP (`0` disables). |
| `CORS_ORIGINS` | No | No | `*` or specific origins | Allowed CORS origins (`*` or comma-separated URLs). |
| `PROVIDER_MODE` | Yes | No | `mock` (or `antigravity`) | Default `mock` for safe offline testing. |
| `DASHBOARD_ENABLED` | No | No | `auto` | `auto` enables when password is set; `true`/`false` force it. |
| `ADMIN_PASSWORD_HASH` | If dashboard | **Yes** | `scrypt$16384$...` | scrypt hash from `scripts/hash-admin-password.mjs`. |
| `CREDENTIAL_ENCRYPTION_KEY` | If dashboard | **Yes** | `base64-32-byte-key` | 32-byte base64 encryption key for stored tokens. |
| `CREDENTIAL_STORE` | No | No | `auto` | `auto` selects redis if `REDIS_URL` is set, else file. |
| `REDIS_URL` | For durable store | **Yes** | `rediss://...` | Connection URL for Render Key Value or external Redis. |
| `OAUTH_REDIRECT_BASE_URL` | For OAuth | No | `https://<app>.onrender.com` | Public base URL for Google OAuth callback. |
| `ANTIGRAVITY_REFRESH_TOKEN` | If env-based | **Yes** | `...` | Persistent OAuth refresh token fallback. |
| `ANTIGRAVITY_CLIENT_ID` | No | **Yes** | `...` | OAuth client ID. |
| `ANTIGRAVITY_CLIENT_SECRET` | No | **Yes** | `...` | OAuth client secret. |
| `ANTIGRAVITY_PROJECT_ID` | No | No | `...` | Upstream project ID. |
| `ANTIGRAVITY_ENDPOINT` | No | No | *(Leave blank)* | Upstream provider base URL override. |
| `ANTIGRAVITY_TOKEN_STORE_PATH` | No | No | `./.data/antigravity-token.json` | Ephemeral on-disk cache path. |

---

## 5. UptimeRobot Heartbeat Configuration

Render Free instances automatically spin down (sleep) after **15 minutes of HTTP inactivity**. To keep the service warm and reduce cold starts:

1. Create a free account at [UptimeRobot](https://uptimerobot.com).
2. Click **Add New Monitor**:
   - **Monitor Type:** `HTTP(s)`
   - **Friendly Name:** `Personal Antigravity API Health`
   - **URL (or IP):** `https://<your-render-subdomain>.onrender.com/health`
   - **Monitoring Interval:** Every `5 minutes` (Free tier standard)
   - **Timeout:** `30 seconds`
3. Click **Create Monitor** (Note: `/health` requires no Bearer authentication and returns immediately without touching upstream providers).

### Critical Realities & Limitations of Heartbeat Pinging
> **Important:** Pinging `/health` every 5 minutes **reduces** inactivity sleeping during active hours, but:
> - **It does NOT guarantee 100% uptime:** Render may still cycle or restart containers during platform updates.
> - **It cannot prevent all cold starts:** Free tier instances have monthly active-hour caps (750 free instance hours per month shared across an account). If hours deplete, Render will stop the instance until the next month.
> - **Cold Start Latency:** If the instance does go to sleep, the first request will experience a **30 to 60-second cold start delay** while Render provisions the container and boots Node.js.

---

## 6. Render Free Tier Limitations

Be aware of the following platform constraints when operating on Render Free:
- **Inactivity Sleep:** Automatic spin-down after 15 minutes without inbound HTTP traffic.
- **Cold Start Delay:** 30–60 seconds response latency on wake-up.
- **Compute Quotas:** 0.1 CPU core, 512 MB RAM. Fastify runs well within this, but heavy simultaneous processing is not supported.
- **Bandwidth Limits:** 100 GB/month outbound bandwidth on the free tier.
- **Build Time Limits:** Free services are limited to 15-minute maximum build durations (standard builds take ~30 seconds).
- **Ephemeral Storage:** Container filesystem resets on restart. Use `REDIS_URL` for durable credential persistence.
