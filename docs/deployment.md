# Deployment Guide — Render Free + UptimeRobot

> **Risk Notice & Terms of Service Warning:**
> Antigravity OAuth integration through third-party applications is unofficial and may violate Google's Terms of Service. Account suspension is possible. This project does not attempt to circumvent provider restrictions. The live Antigravity path is experimental and unverified; the mock provider is the verified, offline default.

This document describes deploying `personal-antigravity-api` to a **Render Free Web Service** using native Node.js (no Docker), paired with an **UptimeRobot** heartbeat monitor to keep the service responsive.

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

## 3. Environment Variables Reference

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
| `ANTIGRAVITY_REFRESH_TOKEN` | If live | **Yes** | `...` | Persistent OAuth refresh token (**Primary source of truth**). |
| `ANTIGRAVITY_ACCESS_TOKEN` | No | **Yes** | `...` | Short-lived OAuth access token (optional). |
| `ANTIGRAVITY_CLIENT_ID` | No | **Yes** | `...` | OAuth client ID (optional if embedded). |
| `ANTIGRAVITY_CLIENT_SECRET` | No | **Yes** | `...` | OAuth client secret (optional if embedded). |
| `ANTIGRAVITY_PROJECT_ID` | No | No | `...` | Upstream project ID (optional). |
| `ANTIGRAVITY_ENDPOINT` | No | No | *(Leave blank)* | Upstream provider base URL override. |
| `ANTIGRAVITY_TOKEN_STORE_PATH` | No | No | `./.data/antigravity-token.json` | Ephemeral on-disk cache path. |

---

## 4. Ephemeral Filesystem & Credential Strategy

Render Free instances operate on an **ephemeral container filesystem**:
1. **Disk wipes on sleep & restart:** Whenever the instance sleeps due to inactivity, restarts, or deploys a new commit, all local files created during runtime (such as `./.data/antigravity-token.json`) are permanently destroyed.
2. **Environment Variables are the Source of Truth:** All persistent credentials (specifically `ANTIGRAVITY_REFRESH_TOKEN` and `API_KEYS`) must be configured in Render's Environment settings.
3. **Cache-Only Token Store:** The token store helper writes to disk opportunistically to avoid refreshing tokens on every request during a single container lifetime. If the file is missing or wiped, the server seamlessly falls back to refreshing via the environment variable.

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
3. Click **Create Monitor**.

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
- **No Persistent Disks:** Any attached persistent disks require paid plans. Native Node environment variables must be used for persistent state.
