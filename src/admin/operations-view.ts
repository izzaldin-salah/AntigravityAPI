import type { RequestSnapshot } from "../core/request-tracker";
import type { AntigravityAccountStatus, CredentialStoreHealth } from "../types/admin";
import { escapeHtml as e, dateValue } from "./html";

export interface OperationsViewData {
  snapshot: RequestSnapshot;
  baseUrl: string;
  models: string[];
  apiKeyCount: number;
  isRender: boolean;
  encryptedStore: boolean;
  hasTokenCache: boolean;
}

export function renderUsage(data: OperationsViewData): string {
  const s = data.snapshot;
  const metric = (label: string, value: number | string, id: string) => `<div><dt>${label}</dt><dd id="metric-${id}">${typeof value === "number" ? value.toLocaleString("en-US") : value}</dd></div>`;
  return `<section class="usage-section" aria-labelledby="usage-heading" id="usage"><div class="section-heading-row"><h2 id="usage-heading">Usage overview</h2><span class="muted">Since ${dateValue(s.since)}</span></div>
    <dl class="usage-metrics">${metric("Requests", s.requests, "requests")}${metric("Input tokens", s.inputTokens, "inputTokens")}${metric("Output tokens", s.outputTokens, "outputTokens")}${metric("Failed", s.failed, "failed")}${metric("Average duration", s.requests ? `${s.averageDurationMs.toLocaleString("en-US")} ms` : "—", "averageDurationMs")}</dl>
    <p class="form-note">Completed provider attempts, including connection tests. Tokens are provider-reported; missing usage is not estimated here. <span id="cancelled-count">${s.cancelled}</span> cancelled. Counters and history reset when this server restarts.</p></section>`;
}

export function renderTest(csrfToken: string): string {
  return `<section class="panel" id="test-connection" aria-labelledby="test-heading"><div class="section-heading-row"><h2 id="test-heading">Test connection</h2><span class="small-label">Live request</span></div><p class="muted section-description">Send a short prompt to confirm that Antigravity can generate a response.</p>
    <form action="/admin/actions/test-connection" method="POST" id="connection-test-form"><input type="hidden" name="csrf_token" value="${e(csrfToken)}"><p class="test-prompt">Reply with exactly: Connection OK.</p><button class="btn" type="submit" id="test-button">Run connection test</button><span class="form-note inline-note">Uses your account’s quota · 30-second limit</span></form>
    <div id="test-result" class="test-result" role="status" aria-live="polite" hidden></div></section>`;
}

export function renderSetup(data: OperationsViewData): string {
  const base = data.baseUrl.replace(/\/+$/, "") + "/v1";
  const model = data.models[0] ?? "";
  const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
  const payload = JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }] });
  const curl = `curl ${shellQuote(base + "/chat/completions")} \\\n  -H "Authorization: Bearer $ANTIGRAVITY_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d ${shellQuote(payload)}`;
  const python = `import os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url=${JSON.stringify(base)},\n    api_key=os.environ["ANTIGRAVITY_API_KEY"],\n)\nresponse = client.chat.completions.create(\n    model=${JSON.stringify(model)},\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(response.choices[0].message.content)`;
  return `<section class="panel" id="api-setup" aria-labelledby="setup-heading"><h2 id="setup-heading">Connect your apps</h2><p class="muted section-description">Use these settings in any OpenAI-compatible client.</p>
    <label for="api-base">API base URL</label><div class="copy-field"><input id="api-base" type="text" readonly value="${e(base)}"><button class="btn btn-secondary" type="button" data-copy="api-base">Copy URL</button></div>
    <label for="api-model">Available model</label><div class="copy-field"><input id="api-model" type="text" readonly value="${e(model)}" placeholder="Model information unavailable"><button class="btn btn-secondary" type="button" data-copy="api-model" ${model ? "" : "disabled"}>Copy model</button></div>
    <label for="api-key">API key <span class="optional-label">${data.apiKeyCount} configured</span></label><div class="copy-field"><input id="api-key" type="password" readonly placeholder="Hidden until you reveal it" autocomplete="off"><button class="btn btn-secondary" id="reveal-key" type="button" ${data.apiKeyCount ? "" : "disabled"}>Reveal key</button><button class="btn btn-secondary" id="copy-key" type="button" disabled data-copy="api-key">Copy key</button></div><p class="form-note">Reveals the first configured key for this gateway. OAuth tokens are never exposed. Hide the key when finished.</p>
    <details class="disclosure code-disclosure"><summary><strong>Client examples</strong><span>+</span></summary><div class="disclosure-content"><p class="muted">Set <code>ANTIGRAVITY_API_KEY</code> in your terminal first. Examples use that variable and never contain your key.</p><div class="code-heading"><h3>cURL · Bash / zsh</h3><button type="button" class="btn btn-secondary btn-small" data-copy="curl-example">Copy cURL</button></div><pre id="curl-example">${e(curl)}</pre><div class="code-heading"><h3>Python · OpenAI SDK</h3><button type="button" class="btn btn-secondary btn-small" data-copy="python-example">Copy Python</button></div><pre id="python-example">${e(python)}</pre></div></details><p id="copy-status" class="form-note" role="status" aria-live="polite"></p><noscript><p class="form-note">Select and copy the URL or examples manually. Enable JavaScript to reveal a key.</p></noscript></section>`;
}

export function renderRecent(data: OperationsViewData): string {
  return `<section class="panel activity-panel" id="recent-requests" aria-labelledby="recent-heading"><div class="section-heading-row"><h2 id="recent-heading">Recent requests</h2><span class="muted">Latest 50</span></div><p class="muted section-description">Provider attempts only. Authentication and validation rejections are not included. No prompts, responses, API keys, or error details are stored.</p><div class="table-scroll" tabindex="0" role="region" aria-label="Recent requests table"><table><thead><tr><th scope="col">Time (UTC)</th><th scope="col">Model</th><th scope="col">Source</th><th scope="col">Duration</th><th scope="col">Result</th></tr></thead><tbody id="recent-rows">${data.snapshot.recent.length ? data.snapshot.recent.map(row => `<tr><td>${dateValue(row.time)}</td><td>${e(row.model)}</td><td>${e(row.source)}</td><td>${row.durationMs.toLocaleString("en-US")} ms</td><td><span class="result-label result-${row.result}">${row.result === "success" ? "Success" : row.result === "failed" ? "Failed" : "Cancelled"}</span></td></tr>`).join("") : '<tr><td colspan="5" class="empty-state">No requests yet. Run a connection test or send a request from your app.</td></tr>'}</tbody></table></div></section>`;
}

export function renderHealth(status: AntigravityAccountStatus, data: OperationsViewData): string {
  const expiry = status.accessTokenExpiresAt;
  const expired = expiry !== undefined && expiry <= Date.now();
  const expiring = expiry !== undefined && !expired && expiry - Date.now() < 5 * 60 * 1000;
  const label = status.needsReconnect ? "Reconnect required" : !status.connected ? "Not connected" : expired ? "Access token expired" : expiring ? "Token expires soon" : "Credentials available";
  const guidance = status.needsReconnect ? "Reconnect with Google below to replace rejected credentials."
    : !status.connected ? "Connect your account, then run a live connection test."
    : expired || expiring ? status.hasRefreshToken ? "A refresh token is available. The gateway will attempt renewal on the next request." : "No refresh token is available. Reconnect with Google to renew access."
    : "Run a connection test to verify access. Having credentials does not guarantee that requests will succeed.";
  return `<section class="detail-section" id="account-health"><h2>Account health</h2><p class="health-label">${label}</p><p class="muted">${guidance}</p><dl class="token-facts"><div><dt>Access token expiry</dt><dd>${dateValue(expiry)}</dd></div><div><dt>Last successful refresh</dt><dd>${dateValue(status.lastRefreshAt)}</dd></div><div><dt>Last successful request</dt><dd id="last-success">${dateValue(data.snapshot.lastSuccessAt)}</dd></div><div><dt>Project</dt><dd>${e(status.projectId || "Not specified")}</dd></div></dl><a class="text-link" href="#connect">Manage account connection</a></section>`;
}

export function renderStorage(store: CredentialStoreHealth, data: OperationsViewData): string {
  const location = store.backend === "redis" ? "Redis credential store" : store.backend === "file" ? "Local credential file" : "Server memory";
  const persistence = store.backend === "memory" ? "Not persistent. Credentials are lost when this server restarts."
    : store.backend === "redis" ? "Separate from the app process. Credentials can survive app restarts, but Redis restart durability depends on its persistence settings. Those settings are not verified here."
    : data.isRender ? "Disk persistence is not verified. Render’s default filesystem is ephemeral; credentials stored there can be lost on restart or deploy. A persistent disk must be explicitly configured."
    : "Survives an app restart on the same disk. Removing the file, replacing the disk, or deploying to ephemeral storage loses the stored credentials.";
  return `<section class="detail-section storage-section" id="storage-status"><h2>Credential storage</h2><p class="health-label">${location}</p><dl class="token-facts"><div><dt>Store health</dt><dd class="${store.ok ? "healthy" : "degraded"}">${store.ok ? "Accessible" : "Unavailable — check storage configuration"}</dd></div><div><dt>Credential-store encryption</dt><dd>${data.encryptedStore && store.backend !== "memory" ? "AES-256-GCM configured" : "Not persisted in an encrypted store"}</dd></div></dl><p class="storage-notice">${persistence}</p>${data.hasTokenCache ? '<p class="form-note">The provider also uses a separate local token cache. That cache is plaintext and is not covered by credential-store encryption.</p>' : ""}</section>`;
}
