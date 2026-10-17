import type { AntigravityAccountStatus, CredentialStoreHealth } from "../types/admin";

export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) {
    return "";
  }
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background-color: #0f172a;
    color: #e2e8f0;
    line-height: 1.5;
  }
  .container {
    max-width: 760px;
    margin: 0 auto;
  }
  .card {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 24px;
    margin-bottom: 24px;
  }
  h1, h2, h3 { margin-top: 0; color: #f8fafc; }
  h1 { font-size: 1.5rem; margin-bottom: 1rem; }
  h2 { font-size: 1.2rem; margin-bottom: 0.75rem; border-bottom: 1px solid #334155; padding-bottom: 8px; }
  p { margin: 0 0 1rem; }
  .flash-success {
    background: #064e3b;
    border: 1px solid #059669;
    color: #a7f3d0;
    padding: 12px 16px;
    border-radius: 6px;
    margin-bottom: 20px;
  }
  .flash-error {
    background: #4c0519;
    border: 1px solid #e11d48;
    color: #fecdd3;
    padding: 12px 16px;
    border-radius: 6px;
    margin-bottom: 20px;
  }
  .status-badge {
    display: inline-block;
    padding: 4px 10px;
    font-size: 0.85rem;
    font-weight: 600;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .badge-connected { background: #065f46; color: #6ee7b7; }
  .badge-needs_reconnect { background: #831843; color: #f472b6; }
  .badge-disconnected { background: #374151; color: #9ca3af; }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 16px;
  }
  @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
  .meta-label { color: #94a3b8; font-size: 0.85rem; }
  .meta-value { font-weight: 500; word-break: break-all; }
  .btn {
    display: inline-block;
    background: #2563eb;
    color: #ffffff;
    padding: 9px 18px;
    border: none;
    border-radius: 6px;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
    text-decoration: none;
  }
  .btn:hover { background: #1d4ed8; }
  .btn-danger { background: #b91c1c; }
  .btn-danger:hover { background: #991b1b; }
  .btn-secondary { background: #334155; color: #e2e8f0; }
  .btn-secondary:hover { background: #475569; }
  .form-group {
    margin-bottom: 16px;
  }
  label {
    display: block;
    margin-bottom: 6px;
    font-size: 0.9rem;
    color: #cbd5e1;
  }
  input[type="text"], input[type="password"] {
    width: 100%;
    padding: 9px 12px;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 6px;
    color: #f8fafc;
    font-size: 0.95rem;
  }
  input[type="text"]:focus, input[type="password"]:focus {
    border-color: #3b82f6;
    outline: none;
  }
  .header-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    border-bottom: 1px solid #334155;
    padding-bottom: 12px;
  }
  .notice {
    font-size: 0.8rem;
    color: #94a3b8;
    margin-top: 24px;
    border-top: 1px solid #334155;
    padding-top: 12px;
  }
`;

export function renderDisabledPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Admin Dashboard — Not Configured</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Account Dashboard Not Configured</h1>
      <p>The account management dashboard is currently disabled. To enable it, configure <code>ADMIN_PASSWORD</code> or <code>ADMIN_PASSWORD_HASH</code> along with <code>CREDENTIAL_ENCRYPTION_KEY</code> in your environment.</p>
    </div>
  </div>
</body>
</html>`;
}

export function renderLoginPage(options?: {
  error?: string;
  flash?: string;
}): string {
  const errorHtml = options?.error
    ? `<div class="flash-error">${escapeHtml(options.error)}</div>`
    : "";
  const flashHtml = options?.flash
    ? `<div class="flash-success">${escapeHtml(options.flash)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Admin Login — Personal Antigravity API</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="container" style="max-width: 420px; margin-top: 60px;">
    <div class="card">
      <h1>Admin Dashboard</h1>
      ${flashHtml}
      ${errorHtml}
      <form action="/admin/login" method="POST">
        <div class="form-group">
          <label for="password">Admin Password</label>
          <input type="password" id="password" name="password" required autocomplete="current-password" autofocus />
        </div>
        <button type="submit" class="btn" style="width: 100%;">Sign In</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

export interface DashboardPageData {
  status: AntigravityAccountStatus;
  credentialStoreHealth: CredentialStoreHealth;
  oauthConfigured: boolean;
  csrfToken: string;
  flash?: { type: "success" | "error"; message: string } | null;
}

export function renderDashboardPage(data: DashboardPageData): string {
  const flashHtml = data.flash
    ? `<div class="flash-${data.flash.type === "error" ? "error" : "success"}">${escapeHtml(data.flash.message)}</div>`
    : "";

  const connectionState = data.status.connected
    ? data.status.needsReconnect
      ? "needs_reconnect"
      : "connected"
    : "disconnected";

  const badgeClass = `badge-${connectionState}`;
  const badgeLabel =
    connectionState === "connected"
      ? "Connected"
      : connectionState === "needs_reconnect"
        ? "Reconnect Required"
        : "Disconnected";

  const expiryString = data.status.accessTokenExpiresAt
    ? new Date(data.status.accessTokenExpiresAt).toLocaleString()
    : "Unknown / Not Cached";

  const lastRefreshString = data.status.lastRefreshAt
    ? new Date(data.status.lastRefreshAt).toLocaleString()
    : "None";

  const reconnectAlert = data.status.needsReconnect
    ? `<div class="flash-error">
        <strong>Reconnect Required:</strong> Upstream provider token refresh was rejected (invalid_grant or unauthorized). Please reconnect below.
        ${data.status.lastError ? `<div style="margin-top:6px; font-size: 0.9rem;">Error: ${escapeHtml(data.status.lastError)}</div>` : ""}
       </div>`
    : "";

  const connectSection = data.oauthConfigured
    ? `<form action="/admin/actions/connect" method="POST" style="margin-bottom: 12px;">
        <input type="hidden" name="csrf_token" value="${escapeHtml(data.csrfToken)}" />
        <button type="submit" class="btn">Connect Google Account</button>
       </form>`
    : `<p style="color: #94a3b8; font-size: 0.9rem;">
        Browser OAuth is not configured (missing ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET). You can configure client credentials or use the manual refresh-token option below.
       </p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Admin Dashboard — Account Management</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <div>
        <h1>Account Management</h1>
      </div>
      <div>
        <form action="/admin/logout" method="POST" style="margin: 0;">
          <input type="hidden" name="csrf_token" value="${escapeHtml(data.csrfToken)}" />
          <button type="submit" class="btn btn-secondary">Log Out</button>
        </form>
      </div>
    </div>

    ${flashHtml}
    ${reconnectAlert}

    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h2>Connection Status</h2>
        <span class="status-badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>
      </div>

      <div class="grid">
        <div>
          <div class="meta-label">Provider Mode</div>
          <div class="meta-value">${escapeHtml(data.status.providerMode)}</div>
        </div>
        <div>
          <div class="meta-label">Account Hint</div>
          <div class="meta-value">${escapeHtml(data.status.accountHint || "None")}</div>
        </div>
        <div>
          <div class="meta-label">Has Refresh Token</div>
          <div class="meta-value">${data.status.hasRefreshToken ? "Yes" : "No"}</div>
        </div>
        <div>
          <div class="meta-label">Access Token Expiry</div>
          <div class="meta-value">${escapeHtml(expiryString)}</div>
        </div>
        <div>
          <div class="meta-label">Last Token Refresh</div>
          <div class="meta-value">${escapeHtml(lastRefreshString)}</div>
        </div>
        <div>
          <div class="meta-label">Credential Backend</div>
          <div class="meta-value">${escapeHtml(data.credentialStoreHealth.backend)} (${data.credentialStoreHealth.ok ? "Healthy" : "Degraded"})</div>
        </div>
      </div>

      <div style="display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap;">
        <form action="/admin/actions/reconnect" method="POST">
          <input type="hidden" name="csrf_token" value="${escapeHtml(data.csrfToken)}" />
          <button type="submit" class="btn btn-secondary">Test / Reconnect</button>
        </form>
        <form action="/admin/actions/disconnect" method="POST" onsubmit="return confirm('Disconnect account credentials?');">
          <input type="hidden" name="csrf_token" value="${escapeHtml(data.csrfToken)}" />
          <button type="submit" class="btn btn-danger">Disconnect</button>
        </form>
      </div>
    </div>

    <div class="card">
      <h2>Browser OAuth Connect</h2>
      <p style="color: #cbd5e1; font-size: 0.95rem;">Authenticate directly via Google OAuth 2.0 (Authorization Code + PKCE).</p>
      ${connectSection}
    </div>

    <div class="card">
      <h2>Manual Credentials</h2>
      <p style="color: #cbd5e1; font-size: 0.95rem;">Paste an existing refresh token. Credentials are encrypted at rest and validated before saving.</p>
      <form action="/admin/actions/manual-credentials" method="POST">
        <input type="hidden" name="csrf_token" value="${escapeHtml(data.csrfToken)}" />
        <div class="form-group">
          <label for="refreshToken">Refresh Token (required)</label>
          <input type="password" id="refreshToken" name="refreshToken" required autocomplete="off" />
        </div>
        <div class="form-group">
          <label for="clientId">Client ID (optional)</label>
          <input type="text" id="clientId" name="clientId" autocomplete="off" />
        </div>
        <div class="form-group">
          <label for="clientSecret">Client Secret (optional)</label>
          <input type="password" id="clientSecret" name="clientSecret" autocomplete="off" />
        </div>
        <div class="form-group">
          <label for="projectId">Project ID (optional)</label>
          <input type="text" id="projectId" name="projectId" autocomplete="off" />
        </div>
        <button type="submit" class="btn">Save &amp; Validate Credentials</button>
      </form>
    </div>

    <div class="notice">
      <strong>Risk Statement:</strong> Antigravity OAuth through third-party applications is unofficial and may violate Google's Terms of Service; account suspension is possible. The live Antigravity path is EXPERIMENTAL/UNVERIFIED.
    </div>
  </div>
</body>
</html>`;
}

export function renderErrorPage(
  title: string,
  message: string,
  returnUrl: string = "/admin/dashboard",
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="container" style="max-width: 540px; margin-top: 60px;">
    <div class="card">
      <h1>${escapeHtml(title)}</h1>
      <div class="flash-error">${escapeHtml(message)}</div>
      <a href="${escapeHtml(returnUrl)}" class="btn btn-secondary">Return</a>
    </div>
  </div>
</body>
</html>`;
}
