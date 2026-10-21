import type { ModelSettingsSnapshot } from "../types/model-settings";
import { modelOption } from "../providers/model-policy";
import { escapeHtml as e } from "./html";

export function renderModelSettings(settings: ModelSettingsSnapshot | undefined, isRender: boolean): string {
  if (!settings) return `<section class="card card-pad section" id="model-settings"><h2>Model &amp; thinking</h2><p class="notice notice-warn">Active settings could not be read. Check storage and refresh this page.</p></section>`;
  const option = modelOption(settings.model);
  const levels = settings.thinkingLevel === null ? [] : option?.thinkingLevels ?? [];
  const storage = settings.storage === "memory" ? "Settings reset when this server restarts."
    : settings.storage === "redis" ? "Saved in Redis. Survives app restarts while Redis retains its data."
    : isRender ? "Saved on this server. Render ephemeral disks lose settings on restart or redeploy unless a persistent disk is attached."
    : "Saved on this server and restored on restart while the settings file is retained.";
  return `<section class="card card-pad section" id="model-settings" aria-labelledby="model-settings-heading">
    <div class="card-head"><div><h2 id="model-settings-heading">Model &amp; thinking</h2><p>Choose what powers your gateway. Changes apply to new API requests and connection tests.</p></div></div>
    <dl class="model-current"><div><dt>Active model</dt><dd id="active-model">${e(settings.publicModel)}</dd></div><div><dt>Thinking</dt><dd id="active-thinking">${e(settings.thinkingLevel ?? "Provider default")}</dd></div></dl>
    <form id="model-settings-form">
      <label for="model-select">Model</label>
      <select id="model-select" name="model" aria-describedby="model-selection-help"><option value="${e(settings.model)}" data-levels="${e(levels.join(","))}">${e(settings.model)} (current)</option></select>
      <p class="form-note" id="model-selection-help">Load models to see compatible text models available to your connected account.</p>
      <label for="thinking-select">Thinking level</label>
      <select id="thinking-select" name="thinkingLevel" ${levels.length ? "" : "disabled"} aria-describedby="thinking-help">${levels.length ? levels.map(level => `<option value="${level}" ${level === settings.thinkingLevel ? "selected" : ""}>${level[0].toUpperCase() + level.slice(1)}</option>`).join("") : '<option value="">Provider default</option>'}</select>
      <p class="form-note" id="thinking-help">Low favors speed. High allows more reasoning. Available levels depend on the model.</p>
      <div class="actions"><button class="btn" type="submit" id="save-model-settings">Save settings</button><button class="btn btn-secondary" type="button" id="load-models">Load account models</button></div>
      <p class="form-note" id="model-settings-status" role="status" aria-live="polite"></p>
    </form>
    <p class="form-note">${storage} The dashboard selection overrides model names sent by API clients.</p>
    <noscript><p>Enable JavaScript to change model settings.</p></noscript>
  </section>`;
}
