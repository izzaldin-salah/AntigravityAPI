import type { RequestSnapshot } from "../core/request-tracker";
import type { AntigravityAccountStatus, CredentialStoreHealth } from "../types/admin";
import type { ModelSettingsSnapshot } from "../types/model-settings";
import { escapeHtml as e, dateValue } from "./html";
import {
  buildLatencySpec,
  buildVolumeSpec,
  renderLatencyChart,
  renderVolumeChart,
} from "./charts";

export interface OperationsViewData {
  snapshot: RequestSnapshot;
  baseUrl: string;
  models: string[];
  apiKeyCount: number;
  isRender: boolean;
  encryptedStore: boolean;
  hasTokenCache: boolean;
  modelSettings?: ModelSettingsSnapshot;
  modelSettingsAvailable?: boolean;
}

function number(value: number): string {
  return value.toLocaleString("en-US");
}

export function renderUsage(data: OperationsViewData): string {
  const s = data.snapshot;
  const rows = s.recent;
  const volume = buildVolumeSpec(rows);
  const latency = buildLatencySpec(rows);

  const stat = (label: string, value: string, id: string, unit = "") =>
    `<div class="stat"><dt>${label}</dt><dd><span id="metric-${id}">${value}</span>${
      unit ? ` <span class="stat-unit" data-unit-for="metric-${id}">${unit}</span>` : ""
    }</dd></div>`;

  const volumeSvg = renderVolumeChart(rows);
  const latencySvg = renderLatencyChart(rows);

  const volumeMeta = volume.empty
    ? "No data yet"
    : `${number(volume.stats.total)} request${
        volume.stats.total === 1 ? "" : "s"
      } · peak ${number(volume.stats.peak)} per bucket`;
  const latencyMeta = latency.empty
    ? "No data yet"
    : `min ${number(latency.stats.min)} · median ${number(
        latency.stats.median,
      )} · max ${number(latency.stats.max)} ms`;

  return `<section class="card card-pad section" id="usage" aria-labelledby="usage-heading">
    <div class="card-head"><div class="card-title-row"><span class="card-icon">${ICON_CHART}</span><div class="card-head-text"><h2 id="usage-heading">Usage overview</h2><p>Completed provider attempts, including connection tests. Tokens are provider-reported; missing usage is not estimated here.</p></div></div><span class="meta">Since ${dateValue(s.since)}</span></div>
    <dl class="stat-grid">
        ${stat("Requests", number(s.requests), "requests")}
        ${stat("Input tokens", number(s.inputTokens), "inputTokens")}
        ${stat("Output tokens", number(s.outputTokens), "outputTokens")}
        ${stat("Failed", number(s.failed), "failed")}
        ${stat("Average duration", s.requests ? number(s.averageDurationMs) : "—", "averageDurationMs", s.requests ? "ms" : "")}
      </dl>
      <div class="chart-layout chart-layout-spaced">
        <figure class="chart-figure">
          <figcaption class="chart-head"><h3>Request volume</h3><span class="chart-meta" id="chart-volume-meta">${e(volumeMeta)}</span></figcaption>
          <div class="chart-body" id="chart-volume">${
            volumeSvg || '<p class="chart-empty">No requests recorded yet. Run a connection test or send a request from your app.</p>'
          }</div>
        </figure>
        <figure class="chart-figure">
          <figcaption class="chart-head"><h3>Response latency</h3><span class="chart-meta" id="chart-latency-meta">${e(latencyMeta)}</span></figcaption>
          <div class="chart-body" id="chart-latency">${
            latencySvg || '<p class="chart-empty">No timings recorded yet. Run a connection test to capture latency.</p>'
          }</div>
        </figure>
      </div>
      <p class="form-note"><span id="cancelled-count">${s.cancelled}</span> cancelled. Charts use the most recent ${number(
        rows.length,
      )} recorded request${rows.length === 1 ? "" : "s"}. Counters and history reset when this server restarts.</p>
  </section>`;
}

export function renderTest(csrfToken: string): string {
  return `<section class="card card-pad section" id="test-connection" aria-labelledby="test-heading">
    <div class="card-head"><div class="card-title-row"><span class="card-icon">${ICON_PULSE}</span><div class="card-head-text"><h2 id="test-heading">Test connection</h2><p>Send a short prompt to confirm Antigravity can generate a response.</p></div></div><span class="pill pill-info">Live request</span></div>
    <form action="/admin/actions/test-connection" method="POST" id="connection-test-form"><input type="hidden" name="csrf_token" value="${e(csrfToken)}"><p class="test-prompt">Reply with exactly: Connection OK.</p><button class="btn" type="submit" id="test-button">Run connection test</button><span class="form-note inline-note">Uses your account’s quota · 30-second limit</span></form>
    <div id="test-result" class="test-result" role="status" aria-live="polite" hidden></div>
  </section>`;
}

export function renderSetup(data: OperationsViewData): string {
  const base = data.baseUrl.replace(/\/+$/, "") + "/v1";
  const model = data.models[0] ?? "";
  const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
  const payload = JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }] });
  const curl = `curl ${shellQuote(base + "/chat/completions")} \\\n  -H "Authorization: Bearer $ANTIGRAVITY_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d ${shellQuote(payload)}`;
  const python = `import os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url=${JSON.stringify(base)},\n    api_key=os.environ["ANTIGRAVITY_API_KEY"],\n)\nresponse = client.chat.completions.create(\n    model=${JSON.stringify(model)},\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(response.choices[0].message.content)`;
  return `<section class="card card-pad section" id="api-setup" aria-labelledby="setup-heading">
    <div class="card-head"><div class="card-title-row"><span class="card-icon">${ICON_CODE}</span><div class="card-head-text"><h2 id="setup-heading">Connect your apps</h2><p>Use these settings in any OpenAI-compatible client.</p></div></div></div>
    <label for="api-base">API base URL</label><div class="copy-field"><input id="api-base" type="text" readonly value="${e(base)}"><button class="btn btn-secondary" type="button" data-copy="api-base">Copy URL</button></div>
    <label for="api-model">Available model</label><div class="copy-field"><input id="api-model" type="text" readonly value="${e(model)}" placeholder="Model information unavailable"><button class="btn btn-secondary" type="button" data-copy="api-model" ${model ? "" : "disabled"}>Copy model</button></div>
    <label for="api-key">API key <span class="optional-label">${data.apiKeyCount} configured</span></label><div class="copy-field"><input id="api-key" type="password" readonly placeholder="Hidden until you reveal it" autocomplete="off"><button class="btn btn-secondary" id="reveal-key" type="button" ${data.apiKeyCount ? "" : "disabled"}>Reveal key</button><button class="btn btn-secondary" id="copy-key" type="button" disabled data-copy="api-key">Copy key</button></div><p class="form-note">Reveals the first configured key for this gateway. OAuth tokens are never exposed. Hide the key when finished.</p>
    <details class="disclosure disclosure-spaced"><summary><span><strong>Client examples</strong><span class="summary-description">Ready-to-run cURL and Python snippets</span></span>${ICON_CHEVRON}</summary><div class="disclosure-content"><p class="form-note note-flush">Set <code>ANTIGRAVITY_API_KEY</code> in your terminal first. Examples use that variable and never contain your key.</p>
      <div class="code-block"><div class="code-head"><h3>cURL · Bash / zsh</h3><button type="button" class="btn btn-secondary btn-small" data-copy="curl-example">Copy cURL</button></div><pre id="curl-example">${e(curl)}</pre></div>
      <div class="code-block"><div class="code-head"><h3>Python · OpenAI SDK</h3><button type="button" class="btn btn-secondary btn-small" data-copy="python-example">Copy Python</button></div><pre id="python-example">${e(python)}</pre></div></div></details>
    <p id="copy-status" class="form-note" role="status" aria-live="polite"></p>
    <noscript><p class="form-note">Select and copy the URL or examples manually. Enable JavaScript to reveal a key.</p></noscript>
  </section>`;
}

export function renderRecent(data: OperationsViewData): string {
  const rows = data.snapshot.recent;
  return `<section class="card card-pad section" id="recent-requests" aria-labelledby="recent-heading">
    <div class="card-head"><div class="card-title-row"><span class="card-icon">${ICON_LIST}</span><div class="card-head-text"><h2 id="recent-heading">Recent requests</h2><p>Provider attempts only. Authentication and validation rejections are not included. No prompts, responses, API keys, or error details are stored.</p></div></div><span class="pill pill-muted">Latest 50</span></div>
    <div class="table-scroll" tabindex="0" role="region" aria-label="Recent requests table"><table><thead><tr><th scope="col">Time (UTC)</th><th scope="col">Model</th><th scope="col">Source</th><th scope="col">Duration</th><th scope="col">Result</th></tr></thead><tbody id="recent-rows">${
      rows.length
        ? rows
            .map(
              (row) =>
                `<tr><td>${dateValue(row.time)}</td><td class="cell-model">${e(
                  row.model,
                )}</td><td>${e(row.source)}</td><td>${number(
                  row.durationMs,
                )} ms</td><td><span class="result result-${row.result}">${
                  row.result === "success"
                    ? "Success"
                    : row.result === "failed"
                      ? "Failed"
                      : "Cancelled"
                }</span></td></tr>`,
            )
            .join("")
        : '<tr><td colspan="5" class="empty-state">No requests yet. Run a connection test or send a request from your app.</td></tr>'
    }</tbody></table></div>
  </section>`;
}

export function renderHealth(status: AntigravityAccountStatus, data: OperationsViewData): string {
  const expiry = status.accessTokenExpiresAt;
  const expired = expiry !== undefined && expiry <= Date.now();
  const expiring = expiry !== undefined && !expired && expiry - Date.now() < 5 * 60 * 1000;
  const tone = status.needsReconnect ? "bad" : !status.connected ? "muted" : expired ? "bad" : expiring ? "warn" : "ok";
  const label = status.needsReconnect
    ? "Reconnect required"
    : !status.connected
      ? "Not connected"
      : expired
        ? "Access token expired"
        : expiring
          ? "Token expires soon"
          : "Credentials available";
  const guidance = status.needsReconnect
    ? "Reconnect with Google below to replace rejected credentials."
    : !status.connected
      ? "Connect your account, then run a live connection test."
      : expired || expiring
        ? status.hasRefreshToken
          ? "A refresh token is available. The gateway will attempt renewal on the next request."
          : "No refresh token is available. Reconnect with Google to renew access."
        : "Run a connection test to verify access. Having credentials does not guarantee that requests will succeed.";
  return `<section class="card card-pad section" id="account-health" aria-labelledby="health-heading">
    <div class="card-head"><div class="card-title-row"><span class="card-icon">${ICON_HEART}</span><div class="card-head-text"><h2 id="health-heading">Account health</h2></div></div></div>
    <p class="health-label health-${tone}"><span class="dot"></span>${e(label)}</p>
    <p class="form-note note-flush note-spaced">${e(guidance)}</p>
    <dl class="fact-list">
      <div><dt>Access token expiry</dt><dd>${dateValue(expiry)}</dd></div>
      <div><dt>Last successful refresh</dt><dd>${dateValue(status.lastRefreshAt)}</dd></div>
      <div><dt>Last successful request</dt><dd id="last-success">${dateValue(data.snapshot.lastSuccessAt)}</dd></div>
      <div><dt>Project</dt><dd>${e(status.projectId || "Not specified")}</dd></div>
    </dl>
    <a class="text-link" href="#connect">Manage account connection</a>
  </section>`;
}

export function renderStorage(store: CredentialStoreHealth, data: OperationsViewData): string {
  const location =
    store.backend === "redis"
      ? "Redis credential store"
      : store.backend === "file"
        ? "Local credential file"
        : "Server memory";
  const persistence =
    store.backend === "memory"
      ? "Not persistent. Credentials are lost when this server restarts."
      : store.backend === "redis"
        ? "Separate from the app process. Credentials can survive app restarts, but Redis restart durability depends on its persistence settings. Those settings are not verified here."
        : data.isRender
          ? "Disk persistence is not verified. Render’s default filesystem is ephemeral; credentials stored there can be lost on restart or deploy. A persistent disk must be explicitly configured."
          : "Survives an app restart on the same disk. Removing the file, replacing the disk, or deploying to ephemeral storage loses the stored credentials.";
  const encrypted =
    data.encryptedStore && store.backend !== "memory"
      ? "AES-256-GCM configured"
      : "Not persisted in an encrypted store";
  return `<section class="card card-pad section" id="storage-status" aria-labelledby="storage-heading">
    <div class="card-head"><div class="card-title-row"><span class="card-icon">${ICON_DB}</span><div class="card-head-text"><h2 id="storage-heading">Credential storage</h2></div></div><span class="pill ${store.ok ? "pill-ok" : "pill-bad"}">${store.ok ? "Healthy" : "Degraded"}</span></div>
    <p class="health-label health-${store.ok ? "ok" : "bad"}"><span class="dot"></span>${e(location)}</p>
    <dl class="fact-list fact-list-spaced">
      <div><dt>Store health</dt><dd class="health-${store.ok ? "ok" : "bad"}">${store.ok ? "Accessible" : "Unavailable — check storage configuration"}</dd></div>
      <div><dt>Credential-store encryption</dt><dd>${e(encrypted)}</dd></div>
    </dl>
    <p class="notice notice-warn">${e(persistence)}</p>
    ${
      data.hasTokenCache
        ? '<p class="form-note">The provider also uses a separate local token cache. That cache is plaintext and is not covered by credential-store encryption.</p>'
        : ""
    }
  </section>`;
}

/* Inline icons so the operations view stays self-contained. */
const ICON_CHART =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 15l4-5 3 3 5-7"/></svg>';
const ICON_PULSE =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>';
const ICON_CODE =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 8-5 4 5 4m8-8 5 4-5 4M14 4l-4 16"/></svg>';
const ICON_LIST =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>';
const ICON_HEART =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1l8.8 8.8 8.8-8.8a5 5 0 0 0 0-7.1Z"/></svg>';
const ICON_DB =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>';
const ICON_CHEVRON =
  '<svg class="icon disclosure-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
