/** No secrets or user strings are interpolated into this script. */
export const ADMIN_SCRIPT = `
(() => {
  const csrf = document.querySelector('input[name="csrf_token"]')?.value;
  const byId = id => document.getElementById(id);
  const request = async path => {
    const res = await fetch(path, {method:'POST', headers:{'x-csrf-token':csrf, 'Accept':'application/json'}, cache:'no-store'});
    const data = await res.json();
    if (!res.ok) {
      const error = new Error(typeof data.error === 'string' ? data.error : 'Request failed. Refresh the dashboard and try again.');
      error.durationMs = data.durationMs;
      throw error;
    }
    return data;
  };
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
  const refreshUsage = async () => {
    const res = await fetch('/admin/api/operations', {cache:'no-store'});
    if (!res.ok) return;
    const data = await res.json();
    ['requests','inputTokens','outputTokens','failed','averageDurationMs'].forEach(key => {
      byId('metric-' + key).textContent = Number(data[key]).toLocaleString() + (key === 'averageDurationMs' ? ' ms' : '');
    });
    byId('cancelled-count').textContent = data.cancelled;
    if (data.lastSuccessAt) byId('last-success').textContent = new Date(data.lastSuccessAt).toISOString().replace('T',' ').slice(0,19) + ' UTC';
    const rows = byId('recent-rows'); rows.replaceChildren();
    data.recent.forEach(item => {
      const row = document.createElement('tr');
      [new Date(item.time).toISOString().replace('T',' ').slice(0,19), item.model, item.source, item.durationMs + ' ms'].forEach(text => { const cell = document.createElement('td'); cell.textContent = text; row.appendChild(cell); });
      const cell = document.createElement('td'); const label = document.createElement('span');
      const result = ['success','failed','cancelled'].includes(item.result) ? item.result : 'failed';
      label.className = 'result-label result-' + result; label.textContent = result[0].toUpperCase() + result.slice(1);
      cell.appendChild(label); row.appendChild(cell);
      rows.appendChild(row);
    });
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
