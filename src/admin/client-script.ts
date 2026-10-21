/**
 * Client behaviour for the server-rendered admin dashboard.
 *
 * No secrets or user strings are interpolated into this script.
 * Charts are re-painted from the spec the server sends, so the browser and
 * the server always agree on geometry and wording.
 */
export const ADMIN_SCRIPT = `
(() => {
  const csrf = document.querySelector('input[name="csrf_token"]')?.value;
  const byId = id => document.getElementById(id);
  const request = async (path, payload) => {
    const res = await fetch(path, {method:'POST', headers:{'x-csrf-token':csrf, 'Accept':'application/json', ...(payload ? {'Content-Type':'application/json'} : {})}, cache:'no-store', ...(payload ? {body:JSON.stringify(payload)} : {})});
    const data = await res.json();
    if (!res.ok) {
      const error = new Error(typeof data.error === 'string' ? data.error : 'Request failed. Refresh the dashboard and try again.');
      error.durationMs = data.durationMs;
      throw error;
    }
    return data;
  };
  const modelSelect = byId('model-select');
  const thinkingSelect = byId('thinking-select');
  const settingsStatus = byId('model-settings-status');
  const syncThinking = () => {
    const previous = thinkingSelect.value;
    const levels = (modelSelect.selectedOptions[0]?.dataset.levels || '').split(',').filter(Boolean);
    thinkingSelect.replaceChildren();
    for (const level of levels.length ? levels : ['']) {
      const option = document.createElement('option'); option.value = level;
      option.textContent = level ? level[0].toUpperCase() + level.slice(1) : 'Provider default';
      thinkingSelect.appendChild(option);
    }
    thinkingSelect.disabled = levels.length === 0;
    if (levels.includes(previous)) thinkingSelect.value = previous;
    else if (levels.includes('high')) thinkingSelect.value = 'high';
  };
  modelSelect?.addEventListener('change', () => { syncThinking(); settingsStatus.textContent = 'Unsaved changes. Select Save settings to apply.'; });
  thinkingSelect?.addEventListener('change', () => { settingsStatus.textContent = 'Unsaved changes. Select Save settings to apply.'; });
  byId('load-models')?.addEventListener('click', async () => {
    const button = byId('load-models'); button.disabled = true; byId('save-model-settings').disabled = true;
    settingsStatus.textContent = 'Loading models from your account…';
    try {
      const data = await request('/admin/actions/models');
      const previous = modelSelect.value;
      const current = modelSelect.selectedOptions[0]?.cloneNode(true);
      modelSelect.replaceChildren();
      for (const model of data.models) {
        const option = document.createElement('option'); option.value = model.id;
        option.textContent = model.name === model.id ? model.id : model.name + ' · ' + model.id;
        option.dataset.levels = model.thinkingLevels.join(','); modelSelect.appendChild(option);
      }
      if (!data.models.some(model => model.id === previous) && current) {
        current.textContent = previous + ' (not in account list)'; modelSelect.prepend(current);
      }
      modelSelect.value = previous; syncThinking();
      settingsStatus.textContent = data.models.length ? 'Account models loaded. Choose a model and save your settings.' : 'No compatible text models were returned. Your active settings have not changed.';
    } catch (error) { settingsStatus.textContent = error.message; }
    finally { button.disabled = false; byId('save-model-settings').disabled = false; }
  });
  byId('model-settings-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = byId('save-model-settings'); button.disabled = true; byId('load-models').disabled = true;
    modelSelect.disabled = true; const previousDisabled = thinkingSelect.disabled; thinkingSelect.disabled = true;
    settingsStatus.textContent = 'Validating and saving settings…';
    try {
      await request('/admin/actions/model-settings', {model:modelSelect.value, thinkingLevel:thinkingSelect.value || null});
      try { sessionStorage.setItem('model-settings-saved', '1'); } catch { /* Storage may be disabled by browser policy. */ }
      window.location.hash = 'model-settings';
      window.location.reload();
    } catch (error) { settingsStatus.textContent = error.message; }
    finally { button.disabled = false; byId('load-models').disabled = false; modelSelect.disabled = false; thinkingSelect.disabled = previousDisabled; }
  });
  try {
    if (settingsStatus && sessionStorage.getItem('model-settings-saved')) {
      sessionStorage.removeItem('model-settings-saved'); settingsStatus.textContent = 'Settings saved. New requests use the model and thinking level shown above.';
    }
  } catch { /* Continue normally when browser storage is disabled. */ }
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const target = byId(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(target.value ?? target.textContent);
      byId('copy-status').textContent = 'Copied to clipboard.';
    } catch {
      if (target.select) target.select();
      else { const range = document.createRange(); range.selectNodeContents(target); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
      byId('copy-status').textContent = 'Clipboard access is unavailable. The text is selected; copy it manually.';
    }
  }));
  const hideKey = () => { const input = byId('api-key'); input.value = ''; input.type = 'password'; byId('copy-key').disabled = true; byId('reveal-key').textContent = 'Reveal key'; };
  let revealVersion = 0;
  byId('reveal-key')?.addEventListener('click', async () => {
    if (byId('api-key').value) { revealVersion++; hideKey(); return; }
    const button = byId('reveal-key'); button.disabled = true; const version = ++revealVersion;
    try {
      const data = await request('/admin/actions/api-key');
      if (version !== revealVersion || document.hidden) return;
      byId('api-key').type = 'text'; byId('api-key').value = data.key;
      byId('copy-key').disabled = false; button.textContent = 'Hide key';
    } catch (error) { byId('copy-status').textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && byId('api-key')) { revealVersion++; hideKey(); } });
  window.addEventListener('pagehide', () => { if (byId('api-key')) { revealVersion++; hideKey(); } });

  // --- Chart painting -------------------------------------------------------
  // The server owns the geometry; the browser only turns the spec into DOM.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (name, attrs) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  };
  const paintChart = (host, spec) => {
    if (!host || !spec) return;
    host.replaceChildren();
    if (spec.empty) {
      const message = document.createElement('p');
      message.className = 'chart-empty';
      message.textContent = spec.emptyMessage || 'No data yet.';
      host.appendChild(message);
      return;
    }
    const svg = svgEl('svg', {
      class: 'chart-svg',
      viewBox: '0 0 ' + spec.width + ' ' + spec.height,
      role: 'img',
      'aria-label': spec.summary,
      focusable: 'false',
      stroke: 'none',
      preserveAspectRatio: 'xMidYMid meet',
    });
    svg.appendChild(svgEl('line', { class: 'chart-axis', x1: 0, y1: spec.baseline, x2: spec.width, y2: spec.baseline }));
    for (const y of spec.gridLines) svg.appendChild(svgEl('line', { class: 'chart-rule', x1: 0, y1: y, x2: spec.width, y2: y }));
    if (spec.areaPoints) svg.appendChild(svgEl('polygon', { class: 'chart-area', points: spec.areaPoints }));
    if (spec.linePoints) svg.appendChild(svgEl('polyline', { class: 'chart-line', points: spec.linePoints }));
    for (const bar of spec.bars) {
      const rect = svgEl('rect', { class: 'chart-bar', x: bar.x.toFixed(2), y: bar.y.toFixed(2), width: bar.width.toFixed(2), height: bar.height, rx: 3 });
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = bar.title;
      rect.appendChild(title);
      svg.appendChild(rect);
    }
    for (const label of spec.labels) {
      const text = svgEl('text', { class: 'chart-label', x: label.x, y: label.y, 'text-anchor': label.anchor });
      text.textContent = label.text;
      svg.appendChild(text);
    }
    host.appendChild(svg);
  };
  const paintMeta = (host, text) => { if (host) host.textContent = text; };
  const formatNumber = value => Number(value).toLocaleString();

  const refreshUsage = async () => {
    const res = await fetch('/admin/api/operations', {cache:'no-store'});
    if (!res.ok) return;
    const data = await res.json();
    ['requests','inputTokens','outputTokens','failed'].forEach(key => {
      const node = byId('metric-' + key);
      if (node) node.textContent = formatNumber(data[key]);
    });
    const duration = byId('metric-averageDurationMs');
    if (duration) {
      duration.textContent = data.requests ? formatNumber(data.averageDurationMs) : '—';
      const unit = document.querySelector('[data-unit-for="metric-averageDurationMs"]');
      if (unit) unit.textContent = data.requests ? 'ms' : '';
    }
    byId('cancelled-count').textContent = data.cancelled;
    if (data.lastSuccessAt) byId('last-success').textContent = new Date(data.lastSuccessAt).toISOString().replace('T',' ').slice(0,19) + ' UTC';
    const rows = byId('recent-rows'); rows.replaceChildren();
    data.recent.forEach(item => {
      const row = document.createElement('tr');
      [new Date(item.time).toISOString().replace('T',' ').slice(0,19), item.model, item.source, item.durationMs + ' ms'].forEach(text => { const cell = document.createElement('td'); cell.textContent = text; row.appendChild(cell); });
      const cell = document.createElement('td'); const label = document.createElement('span');
      const result = ['success','failed','cancelled'].includes(item.result) ? item.result : 'failed';
      label.className = 'result result-' + result; label.textContent = result[0].toUpperCase() + result.slice(1);
      cell.appendChild(label); row.appendChild(cell);
      rows.appendChild(row);
    });
    if (data.charts) {
      paintChart(byId('chart-volume'), data.charts.volume);
      paintChart(byId('chart-latency'), data.charts.latency);
      const volume = data.charts.volume.stats;
      paintMeta(byId('chart-volume-meta'), volume.total ? formatNumber(volume.total) + ' request' + (volume.total === 1 ? '' : 's') + ' · peak ' + formatNumber(volume.peak) + ' per bucket' : 'No data yet');
      const latency = data.charts.latency.stats;
      paintMeta(byId('chart-latency-meta'), latency.total ? 'min ' + formatNumber(latency.min) + ' · median ' + formatNumber(latency.median) + ' · max ' + formatNumber(latency.max) + ' ms' : 'No data yet');
    }
  };
  byId('connection-test-form')?.addEventListener('submit', async event => {
    event.preventDefault(); const button = byId('test-button'); const output = byId('test-result');
    button.disabled = true; button.textContent = 'Testing connection…'; output.hidden = false;
    output.className = 'test-result'; output.textContent = 'Waiting for Antigravity. This can take up to 30 seconds.';
    try {
      const data = await request('/admin/actions/test-connection');
      output.className = 'test-result test-success';
      output.textContent = 'Connection successful · ' + data.durationMs + ' ms · ' + data.model + '\\n\\n' + data.response;
    } catch (error) { output.className = 'test-result test-error'; output.textContent = error.message + (typeof error.durationMs === 'number' ? ' (' + error.durationMs + ' ms)' : ''); }
    finally {
      button.textContent = 'Please wait…';
      setTimeout(() => { button.disabled = false; button.textContent = 'Run connection test'; }, 10000);
      refreshUsage().catch(() => {});
    }
  });
  const updateNav = () => {
    document.querySelectorAll('.nav-link').forEach(link => {
      const active = link.hash === (location.hash || '#overview');
      link.classList.toggle('nav-active', active);
      if (active) link.setAttribute('aria-current','location'); else link.removeAttribute('aria-current');
    });
  };
  window.addEventListener('hashchange', updateNav); updateNav();
})();
`;
