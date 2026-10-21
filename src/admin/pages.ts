import type { AntigravityAccountStatus, CredentialStoreHealth } from "../types/admin";
import { ADMIN_CSS } from "./styles";
import { escapeHtml, dateValue } from "./html";
export { escapeHtml } from "./html";
import { ADMIN_SCRIPT } from "./client-script";
import { renderModelSettings } from "./model-settings-view";
import {
  renderUsage,
  renderTest,
  renderSetup,
  renderRecent,
  renderHealth,
  renderStorage,
  type OperationsViewData,
} from "./operations-view";

const ICONS = {
  orbit:
    '<ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-35 12 12)"/><circle cx="12" cy="12" r="3"/><path d="M7 4a9 9 0 0 1 11 13"/>',
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  chart:
    '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 15l4-5 3 3 5-7"/>',
  link: '<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 1)"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  logout: '<path d="M9 4H4v16h5m6-12 4 4-4 4m-7-4h11"/>',
  refresh:
    '<path d="M20 8a8 8 0 0 0-14-2L3 9m0-6v6h6m-5 7a8 8 0 0 0 14 2l3-3m0 6v-6h-6"/>',
  shield:
    '<path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  external: '<path d="M14 3h7v7m0-7L10 14m0-10H4v16h16v-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
} as const;

function icon(name: keyof typeof ICONS, className = ""): string {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}
function brand(): string {
  return `<a class="brand" href="/admin/dashboard"><span class="brand-mark">${icon("orbit")}</span><span>Antigravity<span class="brand-subtitle">Personal API gateway</span></span></a>`;
}
function page(title: string, body: string, bodyClass = ""): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)} — Antigravity</title><style>${ADMIN_CSS}</style></head><body class="${bodyClass}"><a class="skip-link" href="#main">Skip to content</a>${body}</body></html>`;
}
function alert(message: string, type: "success" | "error"): string {
  const glyph = type === "error" ? icon("alert") : icon("shield");
  return `<div class="flash flash-${type}" role="${type === "error" ? "alert" : "status"}">${glyph}<span>${escapeHtml(message)}</span></div>`;
}
function csrf(token: string): string {
  return `<input type="hidden" name="csrf_token" value="${escapeHtml(token)}" />`;
}
function simplePage(title: string, content: string): string {
  return page(
    title,
    `<div class="auth-page"><header class="auth-header">${brand()}</header><main id="main" class="auth-main"><div class="card auth-panel">${content}</div><p class="auth-footer">Personal Antigravity API · Administrator access</p></main></div>`,
    "auth-page",
  );
}

export function renderDisabledPage(): string {
  return simplePage(
    "Dashboard not configured",
    `<span class="feature-icon">${icon("key")}</span><h1>Account Dashboard Not Configured</h1><p class="intro">Enable account management to get started.</p><p>Configure <code>ADMIN_PASSWORD</code> or <code>ADMIN_PASSWORD_HASH</code> along with <code>CREDENTIAL_ENCRYPTION_KEY</code> in your environment.</p>`,
  );
}
export function renderLoginPage(options?: { error?: string; flash?: string }): string {
  return simplePage(
    "Admin login",
    `<span class="feature-icon">${icon("shield")}</span><h1>Welcome back.</h1><p class="intro">Sign in to manage your Antigravity connection.</p>${options?.flash ? alert(options.flash, "success") : ""}${options?.error ? alert(options.error, "error") : ""}<form action="/admin/login" method="POST"><div class="form-group"><label for="password">Admin password</label><input type="password" id="password" name="password" required autocomplete="current-password" autofocus placeholder="Enter your password" /></div><button type="submit" class="btn btn-wide">Sign In ${icon("arrow")}</button></form><p class="form-note">Use the administrator password configured for this gateway.</p>`,
  );
}
export interface DashboardPageData {
  status: AntigravityAccountStatus;
  credentialStoreHealth: CredentialStoreHealth;
  oauthConfigured: boolean;
  csrfToken: string;
  flash?: { type: "success" | "error"; message: string } | null;
  operations?: OperationsViewData;
}
export function renderDashboardPage(data: DashboardPageData): string {
  const { status, credentialStoreHealth: store } = data;
  const state = status.needsReconnect
    ? "attention"
    : status.connected
      ? "connected"
      : "disconnected";
  const stateLabel =
    state === "attention"
      ? "Reconnect required"
      : state === "connected"
        ? "Connected"
        : "Disconnected";
  const pillClass =
    state === "attention" ? "pill-warn" : state === "connected" ? "pill-ok" : "pill-muted";
  const title =
    state === "attention"
      ? "Your account needs attention."
      : state === "connected"
        ? "Your account is connected."
        : "Let’s connect your account.";
  const description =
    state === "attention"
      ? "The last token refresh was rejected. Connect your account again to restore access."
      : state === "connected"
        ? "Account credentials are available to your gateway. Manage your connection below."
        : "Connect with Google to set up your gateway.";
  const field = csrf(data.csrfToken);
  const storageOk = store.ok;
  return page(
    "Account overview",
    `<div class="app">
    <aside class="sidebar">${brand()}<nav aria-label="Dashboard navigation">
      <p class="nav-section">Overview</p>
      <a class="nav-link nav-active" href="#overview">${icon("overview")} Account</a>
      ${data.operations ? `<a class="nav-link" href="#usage">${icon("chart")} Usage</a>` : ""}
      <p class="nav-section">Tools</p>
      ${data.operations?.modelSettingsAvailable ? `<a class="nav-link" href="#model-settings">${icon("orbit")} Model &amp; thinking</a>` : ""}
      <a class="nav-link" href="#test-connection">${icon("refresh")} Test connection</a>
      <a class="nav-link" href="#api-setup">${icon("external")} API setup</a>
      <a class="nav-link" href="#recent-requests">${icon("overview")} Recent requests</a>
      <a class="nav-link" href="#connect">${icon("link")} Connect account</a>
    </nav><div class="sidebar-bottom"><div class="workspace-label"><span class="workspace-avatar">P</span><span>Personal workspace<small>Administrator</small></span></div><form action="/admin/logout" method="POST">${field}<button class="logout-button" type="submit">${icon("logout")}<span>Log Out</span></button></form></div></aside>
    <div class="workspace"><header class="topbar"><span>Workspace <span class="breadcrumb-separator">/</span> <strong>Overview</strong></span><span class="private-label">${icon("shield")} Admin console</span></header><main id="main" class="main-content">
      <div class="page-heading" id="overview"><div><h1>Account overview</h1><p>Your connection, credentials, and sign-in options in one place.</p></div><div class="page-heading-actions"><a class="btn btn-secondary refresh-status" href="/admin/dashboard" aria-label="Refresh status">${icon("refresh")} <span class="btn-label">Refresh status</span></a></div></div>
      ${data.flash ? alert(data.flash.message, data.flash.type) : ""}${status.needsReconnect && status.lastError ? alert(status.lastError, "error") : ""}
      <section class="card section" id="connection" aria-labelledby="connection-heading">
        <div class="hero"><div><span class="pill ${pillClass}"><span class="dot"></span>${stateLabel}</span><h2 id="connection-heading">${title}</h2><p>${description}</p></div><span class="hero-symbol">${icon("orbit")}</span></div>
        <dl class="fact-row">
          <div><dt>Account</dt><dd>${escapeHtml(status.accountHint || (status.connected ? "Identity not available" : "No account linked"))}</dd></div>
          <div><dt>Provider mode</dt><dd>Antigravity</dd></div>
          <div><dt>Credential storage</dt><dd>${escapeHtml(store.backend)} <span class="pill ${storageOk ? "pill-ok" : "pill-bad"}">${storageOk ? "Healthy" : "Degraded"}</span></dd></div>
        </dl>
        <div class="card-foot"><span class="card-foot-note">${icon("key")} Refresh token ${status.hasRefreshToken ? "available" : "not configured"}</span><div class="actions"><form action="/admin/actions/reconnect" method="POST">${field}<button type="submit" class="btn btn-secondary btn-small">${icon("refresh")} Refresh credentials</button></form><form action="/admin/actions/disconnect" method="POST" onsubmit="return confirm('Disconnect account credentials?');">${field}<button type="submit" class="btn btn-danger btn-small">Disconnect</button></form></div></div>
      </section>
      ${data.operations ? renderUsage(data.operations) : ""}
      ${data.operations?.modelSettingsAvailable ? renderModelSettings(data.operations.modelSettings, data.operations.isRender) : ""}
      <div class="content-columns">
        <div class="primary-column">
          ${data.operations ? renderTest(data.csrfToken) + renderSetup(data.operations) : ""}
          <section class="card card-pad section" id="connect" aria-labelledby="connect-heading">
            <div class="card-head"><div class="card-title-row"><span class="card-icon">${icon("link")}</span><div class="card-head-text"><h2 id="connect-heading">Connect your account</h2><p>Choose the sign-in method that works for you.</p></div></div></div>
            <div class="oauth-block">
              <h3>Sign in with Google <span class="small-label">Recommended</span></h3>
              <p>Continue to Google to authorize this gateway, then return here automatically.</p>
              ${data.oauthConfigured ? `<form action="/admin/actions/connect" method="POST">${field}<button type="submit" class="btn">Connect Google Account ${icon("arrow")}</button></form>` : '<p class="notice notice-warn">Browser OAuth is not configured. Set <code>ANTIGRAVITY_CLIENT_ID</code> and <code>ANTIGRAVITY_CLIENT_SECRET</code> to enable Google sign-in.</p>'}
            </div>
            <details class="disclosure disclosure-spaced"><summary><span><strong>Use a localhost callback</strong><span class="summary-description">For OAuth clients with a local redirect address</span></span>${icon("chevron", "disclosure-chevron")}</summary><div class="disclosure-content"><ol class="steps"><li><strong>Open Google sign-in.</strong><span>Complete authorization in the new tab.</span></li><li><strong>Copy the full callback URL.</strong><span>The localhost page may say it cannot be reached. This is expected; copy its address anyway.</span></li><li><strong>Paste it below to finish.</strong><span>Return to this tab and complete the connection.</span></li></ol>
              <form action="/admin/actions/connect-local" method="POST" target="_blank" rel="noopener noreferrer">${field}<button type="submit" class="btn btn-secondary" ${data.oauthConfigured ? "" : "disabled"}>Start localhost sign-in ${icon("external")}</button></form>${data.oauthConfigured ? "" : '<p class="form-note">Configure browser OAuth to enable localhost sign-in.</p>'}
              <form class="callback-form" action="/admin/actions/complete-local" method="POST">${field}<div class="form-group"><label for="callbackUrl">Full localhost callback URL</label><input type="text" id="callbackUrl" name="callbackUrl" required autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:51121/oauth-callback?code=…&amp;state=…" /></div><button type="submit" class="btn" ${data.oauthConfigured ? "" : "disabled"}>Complete localhost sign-in ${icon("arrow")}</button></form></div></details>
          </section>
        </div>
        <aside class="details-column" aria-label="Connection details">${data.operations ? renderHealth(status, data.operations) + renderStorage(store, data.operations) : `<section class="card card-pad section"><h2>Token details</h2><p class="form-note">The latest information reported by your provider.</p><dl class="fact-list"><div><dt>Access token expiry</dt><dd>${dateValue(status.accessTokenExpiresAt)}</dd></div><div><dt>Last token refresh</dt><dd>${dateValue(status.lastRefreshAt)}</dd></div><div><dt>Project</dt><dd>${escapeHtml(status.projectId || "Not specified")}</dd></div></dl></section>`}<section class="card card-pad help-note">${icon("shield")}<h3>A little peace of mind</h3><p>OAuth tokens are never shown here. API keys are revealed only when you request them. Sign out when you’re finished on a shared device.</p></section></aside></div>
      ${data.operations ? renderRecent(data.operations) : ""}
      <footer class="page-footer"><span>Personal Antigravity API</span><p>Antigravity OAuth through third-party applications is unofficial and may violate Google’s Terms of Service; account suspension is possible. The live Antigravity path is experimental.</p></footer>
    </main></div></div>${data.operations ? `<script>${ADMIN_SCRIPT}</script>` : ""}`,
  );
}
export function renderErrorPage(
  title: string,
  message: string,
  returnUrl = "/admin/dashboard",
): string {
  return simplePage(
    title,
    `<span class="feature-icon">${icon("link")}</span><h1>${escapeHtml(title)}</h1>${alert(message, "error")}<a href="${escapeHtml(returnUrl)}" class="btn btn-secondary">Return ${icon("arrow")}</a>`,
  );
}
