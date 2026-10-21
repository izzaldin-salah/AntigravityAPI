/**
 * Shared, self-contained light theme for the server-rendered admin pages.
 *
 * Design intent: low-glare surfaces, generous type (13px floor for supporting
 * text), a single spacing rhythm, and one restrained accent so the eye lands
 * on status and numbers rather than chrome.
 *
 * Everything is driven by the token layer at the top. If a colour is needed,
 * add a token — do not introduce a raw hex further down the file.
 */
export const ADMIN_CSS = `
  :root {
    color-scheme: light;

    /* ---- Surfaces ---- */
    --canvas: #f4f6f3;
    --surface: #ffffff;
    --surface-sunken: #f9faf8;
    --surface-inset: #f0f3ee;
    --surface-hover: #edf1ec;

    /* ---- Lines ---- */
    --line: #e3e8e1;
    --line-strong: #d3dbd1;
    --line-soft: #edf1ec;

    /* ---- Text ---- */
    --ink: #1e2b25;
    --ink-secondary: #43534b;
    --ink-muted: #62716a;
    --ink-inverse: #ffffff;

    /* ---- Accent ---- */
    --accent: #1f6a52;
    --accent-hover: #175540;
    --accent-ink: #144736;
    --accent-tint: #e9f2ed;
    --accent-tint-strong: #d7e8de;
    --accent-line: #b9d5c5;

    /* ---- Status ---- */
    --ok: #246b45;
    --ok-tint: #e8f3ec;
    --ok-line: #c3ddcd;
    --warn: #8a5a12;
    --warn-tint: #fbf1dd;
    --warn-line: #ecdab3;
    --bad: #a13a31;
    --bad-tint: #fbeeec;
    --bad-line: #edcdc6;
    --info: #2a5c86;
    --info-tint: #e9f1f8;
    --info-line: #c7d9e8;

    /* ---- Spacing (4px rhythm) ---- */
    --s1: 4px;
    --s2: 8px;
    --s3: 12px;
    --s4: 16px;
    --s5: 20px;
    --s6: 24px;
    --s7: 32px;
    --s8: 40px;
    --s9: 48px;

    /* ---- Radius ---- */
    --r-sm: 6px;
    --r-md: 10px;
    --r-lg: 14px;
    --r-full: 999px;

    /* ---- Elevation ---- */
    --shadow-sm: 0 1px 2px rgba(30,43,37,.05);
    --shadow-md: 0 1px 2px rgba(30,43,37,.04), 0 6px 16px -8px rgba(30,43,37,.10);
    --shadow-lg: 0 2px 4px rgba(30,43,37,.04), 0 12px 32px -12px rgba(30,43,37,.16);

    /* ---- Type ---- */
    --font: "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  }

  *, *::before, *::after { box-sizing: border-box; }
  html { scroll-padding-top: 24px; -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--canvas);
    color: var(--ink);
    font: 15px/1.65 var(--font);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  ::selection { background: var(--accent-tint-strong); color: var(--accent-ink); }
  a { color: var(--accent); text-underline-offset: 3px; }
  button, input, select, textarea { font: inherit; color: inherit; }
  button, a, input, summary, [tabindex] { -webkit-tap-highlight-color: transparent; }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; border-radius: var(--r-sm); }
  h1, h2, h3, h4, p, dl, dd, figure { margin: 0; }
  h1, h2, h3, h4 { line-height: 1.25; font-weight: 600; text-wrap: balance; }
  h1 { font-size: 30px; letter-spacing: -.032em; }
  h2 { font-size: 19px; letter-spacing: -.024em; }
  h3 { font-size: 15px; letter-spacing: -.01em; }
  p { max-width: 68ch; }
  code, pre, .mono { font-family: var(--font-mono); }
  code { font-size: .9em; overflow-wrap: anywhere; }
  [hidden] { display: none !important; }
  .icon { width: 18px; height: 18px; flex-shrink: 0; vertical-align: middle; }

  .skip-link {
    position: fixed; top: 8px; left: 8px; z-index: 40;
    padding: 10px 18px; background: var(--surface); color: var(--ink);
    border-radius: var(--r-md); box-shadow: var(--shadow-lg);
    transform: translateY(-180%);
  }
  .skip-link:focus { transform: none; }

  /* ---------------------------------------------------------------- Brand */
  .brand {
    display: flex; align-items: center; gap: 12px;
    color: var(--ink); text-decoration: none;
    font-size: 18px; font-weight: 650; letter-spacing: -.02em;
  }
  .brand-mark {
    width: 38px; height: 38px; flex-shrink: 0;
    background: var(--accent); color: var(--ink-inverse);
    border-radius: 11px; display: grid; place-items: center;
  }
  .brand-mark .icon { width: 25px; height: 25px; }
  .brand-subtitle {
    display: block; color: var(--ink-muted);
    font-size: 12px; font-weight: 400; letter-spacing: .01em;
  }

  /* -------------------------------------------------------------- Layout */
  .app { min-height: 100svh; }
  .sidebar {
    position: fixed; inset: 0 auto 0 0; z-index: 20;
    width: 248px; padding: var(--s7) var(--s5) var(--s5);
    background: var(--surface); border-right: 1px solid var(--line);
    display: flex; flex-direction: column;
  }
  .sidebar nav { display: grid; gap: 2px; margin-top: var(--s8); }
  .nav-section {
    padding: 0 var(--s3); margin: var(--s5) 0 var(--s2);
    font-size: 11px; font-weight: 600; letter-spacing: .09em;
    text-transform: uppercase; color: var(--ink-muted);
  }
  .nav-section:first-child { margin-top: 0; }
  .nav-link {
    display: flex; align-items: center; gap: 11px;
    padding: 9px var(--s3); border-radius: var(--r-md);
    color: var(--ink-secondary); font-size: 14px; font-weight: 500;
    text-decoration: none;
    transition: background-color 140ms ease-out, color 140ms ease-out;
  }
  .nav-link:hover { background: var(--surface-hover); color: var(--ink); }
  .nav-link .icon { width: 17px; height: 17px; color: var(--ink-muted); }
  .nav-link:hover .icon { color: var(--ink-secondary); }
  .nav-active { background: var(--accent-tint); color: var(--accent-ink); font-weight: 600; }
  .nav-active .icon { color: var(--accent); }
  .sidebar-bottom { margin-top: auto; padding-top: var(--s6); }
  .workspace-label {
    display: flex; align-items: center; gap: 11px;
    padding: var(--s4) var(--s2);
    border-top: 1px solid var(--line);
    font-size: 13px; font-weight: 600;
  }
  .workspace-label small { display: block; color: var(--ink-muted); font-size: 12px; font-weight: 400; }
  .workspace-avatar {
    width: 32px; height: 32px; flex-shrink: 0;
    display: grid; place-items: center;
    background: var(--accent-tint); color: var(--accent-ink);
    border-radius: var(--r-full); font-size: 13px;
  }
  .logout-button {
    width: 100%; display: flex; align-items: center; gap: 10px;
    background: none; border: 0; border-radius: var(--r-md);
    padding: 9px var(--s3); color: var(--ink-muted);
    cursor: pointer; text-align: left; font-size: 13px; font-weight: 500;
    transition: background-color 140ms ease-out, color 140ms ease-out;
  }
  .logout-button:hover { background: var(--surface-hover); color: var(--ink); }
  .logout-button .icon { width: 16px; height: 16px; }

  .workspace { margin-left: 248px; min-height: 100svh; }
  .topbar {
    position: sticky; top: 0; z-index: 15;
    min-height: 64px; display: flex; align-items: center;
    justify-content: space-between; gap: var(--s4);
    padding: var(--s3) var(--s8);
    background: color-mix(in srgb, var(--canvas) 88%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--line);
    color: var(--ink-muted); font-size: 13px;
  }
  .topbar strong { color: var(--ink); font-weight: 600; }
  .breadcrumb-separator { margin: 0 10px; color: var(--line-strong); }
  .private-label { display: flex; align-items: center; gap: 7px; font-size: 12px; }
  .private-label .icon { width: 15px; height: 15px; }
  .main-content {
    max-width: 1280px; margin: 0 auto;
    padding: var(--s8) var(--s8) var(--s7);
    display: flex; flex-direction: column; gap: var(--s5);
  }
  /* Flex and grid children default to min-width:auto, which lets wide content
     (tables, long values) push the page wider than the viewport. */
  .main-content > *, .content-columns > *, .primary-column > *, .details-column > *, .card { min-width: 0; }
  .page-heading {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: var(--s5); margin-bottom: var(--s2); scroll-margin-top: 84px;
  }
  .page-heading p { color: var(--ink-secondary); margin-top: 7px; font-size: 14px; }
  .page-heading-actions { display: flex; gap: var(--s2); flex-shrink: 0; }

  /* ------------------------------------------------------------- Buttons */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 40px; padding: 9px var(--s4);
    background: var(--accent); color: var(--ink-inverse);
    border: 1px solid transparent; border-radius: var(--r-md);
    font-size: 14px; font-weight: 600; line-height: 1.4;
    cursor: pointer; text-decoration: none; white-space: nowrap;
    transition: background-color 140ms ease-out, border-color 140ms ease-out, box-shadow 140ms ease-out;
  }
  .btn:hover { background: var(--accent-hover); }
  .btn:active { transform: translateY(0.5px); }
  .btn .icon { width: 16px; height: 16px; }
  .btn-secondary { background: var(--surface); border-color: var(--line-strong); color: var(--ink-secondary); box-shadow: var(--shadow-sm); }
  .btn-secondary:hover { background: var(--surface-hover); border-color: var(--line-strong); color: var(--ink); }
  .btn-danger { background: var(--surface); color: var(--bad); border-color: var(--bad-line); }
  .btn-danger:hover { background: var(--bad-tint); border-color: var(--bad); color: var(--bad); }
  .btn:disabled { background: var(--surface-inset); border-color: var(--line); color: var(--ink-muted); cursor: not-allowed; box-shadow: none; }
  .btn-small { min-height: 34px; padding: 6px var(--s3); font-size: 13px; }
  .btn-wide { width: 100%; }

  /* --------------------------------------------------------------- Cards */
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-sm);
  }
  .card-pad { padding: var(--s6); }
  .card-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: var(--s4); margin-bottom: var(--s5);
    flex-wrap: wrap;
  }
  .card-head-text { min-width: 0; flex: 1 1 220px; }
  .card-head h2 { font-size: 17px; }
  .card-head p { color: var(--ink-muted); font-size: 13px; margin-top: 4px; }
  .card-head > .pill, .card-head > .meta { flex-shrink: 0; }
  .card-icon {
    width: 34px; height: 34px; flex-shrink: 0;
    display: grid; place-items: center;
    border-radius: var(--r-md);
    background: var(--accent-tint); color: var(--accent);
  }
  .card-icon .icon { width: 18px; height: 18px; }
  .card-title-row { display: flex; align-items: center; gap: 11px; min-width: 0; }
  .card-title-row > div { min-width: 0; }
  .card-head .meta { color: var(--ink-muted); font-size: 13px; white-space: nowrap; }

  /* -------------------------------------------------------- Status pill */
  .pill {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 4px 11px; border-radius: var(--r-full);
    font-size: 12.5px; font-weight: 600; line-height: 1.5;
    border: 1px solid transparent;
  }
  .pill .dot { width: 7px; height: 7px; border-radius: var(--r-full); background: currentColor; flex-shrink: 0; }
  .pill-ok { background: var(--ok-tint); color: var(--ok); border-color: var(--ok-line); }
  .pill-warn { background: var(--warn-tint); color: var(--warn); border-color: var(--warn-line); }
  .pill-bad { background: var(--bad-tint); color: var(--bad); border-color: var(--bad-line); }
  .pill-muted { background: var(--surface-inset); color: var(--ink-secondary); border-color: var(--line); }
  .pill-info { background: var(--info-tint); color: var(--info); border-color: var(--info-line); }

  /* --------------------------------------------------------- Hero panel */
  .hero {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: var(--s6); padding: var(--s6);
    background: linear-gradient(180deg, var(--accent-tint) 0%, var(--surface) 62%);
    border-bottom: 1px solid var(--line);
  }
  .hero h2 { margin: 13px 0 7px; font-size: 23px; }
  .hero p { color: var(--ink-secondary); font-size: 14px; max-width: 60ch; }
  .hero-symbol {
    flex-shrink: 0; width: 64px; height: 64px;
    display: grid; place-items: center;
    border-radius: var(--r-full);
    background: var(--surface); border: 1px solid var(--accent-line);
    color: var(--accent);
    box-shadow: var(--shadow-sm);
  }
  .hero-symbol .icon { width: 38px; height: 38px; stroke-width: 1; }

  .fact-row {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
    padding: var(--s5) var(--s6);
    border-bottom: 1px solid var(--line-soft);
  }
  .fact-row > div { padding-right: var(--s4); }
  .fact-row dt { font-size: 12px; color: var(--ink-muted); margin-bottom: 5px; }
  .fact-row dd { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
  .card-foot {
    display: flex; justify-content: space-between; align-items: center;
    flex-wrap: wrap; gap: var(--s4);
    padding: var(--s4) var(--s6);
  }
  .card-foot-note { display: flex; align-items: center; gap: 8px; color: var(--ink-muted); font-size: 13px; }
  .card-foot-note .icon { width: 15px; height: 15px; }
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s2); }

  /* ----------------------------------------------------------- Stat grid */
  .stat-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--s3); }
  .stat {
    padding: var(--s4);
    background: var(--surface-sunken);
    border: 1px solid var(--line-soft);
    border-radius: var(--r-md);
  }
  .stat dt { font-size: 12.5px; color: var(--ink-muted); margin-bottom: 6px; }
  .stat dd {
    font-size: 26px; font-weight: 600; letter-spacing: -.03em;
    font-variant-numeric: tabular-nums; line-height: 1.15;
  }
  .stat-unit { font-size: 14px; font-weight: 500; color: var(--ink-muted); letter-spacing: 0; }

  /* -------------------------------------------------------------- Charts */
  .chart-layout { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s4); }
  .chart-layout-spaced { margin-top: var(--s5); }
  .chart-figure {
    padding: var(--s4);
    background: var(--surface-sunken);
    border: 1px solid var(--line-soft);
    border-radius: var(--r-md);
    min-width: 0;
  }
  .chart-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s3); margin-bottom: var(--s4); flex-wrap: wrap; }
  .chart-head h3 { font-size: 14px; }
  .chart-meta { font-size: 12.5px; color: var(--ink-muted); font-variant-numeric: tabular-nums; text-align: right; }
  .chart-body {
    position: relative;
    background: var(--surface-sunken);
    border: 1px solid var(--line-soft);
    border-radius: var(--r-md);
    padding: var(--s3) var(--s4) 0;
  }
  .chart-svg { display: block; width: 100%; height: auto; overflow: visible; stroke: none; }
  .chart-axis { stroke: var(--line-strong); stroke-width: 1; }
  .chart-rule { stroke: var(--line-soft); stroke-width: 1; }
  .chart-bar { fill: var(--accent); fill-opacity: .82; }
  .chart-bar:hover { fill-opacity: 1; }
  .chart-line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .chart-area { fill: var(--accent); fill-opacity: .1; }
  .chart-label { fill: var(--ink-secondary); font-size: 11.5px; font-family: var(--font); }
  .chart-empty {
    display: grid; place-items: center; min-height: 132px;
    color: var(--ink-muted); font-size: 13px; text-align: center;
  }

  /* -------------------------------------------------------------- Table */
  .table-scroll { overflow-x: auto; border-radius: var(--r-md); border: 1px solid var(--line-soft); max-width: 100%; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; text-align: left; }
  thead th {
    position: sticky; top: 0; z-index: 1;
    padding: 10px var(--s4);
    background: var(--surface-sunken);
    border-bottom: 1px solid var(--line);
    font-size: 12px; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; color: var(--ink-muted);
    white-space: nowrap;
  }
  tbody td {
    padding: 11px var(--s4);
    border-bottom: 1px solid var(--line-soft);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere; max-width: 260px;
  }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr { transition: background-color 120ms ease-out; }
  tbody tr:hover { background: var(--surface-sunken); }
  td:first-child { white-space: nowrap; color: var(--ink-secondary); }
  .cell-model { font-weight: 500; }
  .result {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 9px; border-radius: var(--r-full);
    font-size: 12px; font-weight: 600; border: 1px solid transparent;
  }
  .result-success { background: var(--ok-tint); color: var(--ok); border-color: var(--ok-line); }
  .result-failed { background: var(--bad-tint); color: var(--bad); border-color: var(--bad-line); }
  .result-cancelled { background: var(--warn-tint); color: var(--warn); border-color: var(--warn-line); }
  .empty-state { padding: var(--s8) var(--s4); text-align: center; color: var(--ink-muted); font-size: 14px; }

  /* -------------------------------------------------------------- Forms */
  .form-group { margin-bottom: var(--s4); }
  label { display: block; font-size: 13.5px; font-weight: 600; margin-bottom: 7px; }
  input[type=text], input[type=password], input[type=url], select {
    width: 100%; min-height: 40px;
    padding: 9px 12px;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-md);
    color: var(--ink); font-size: 14px;
    caret-color: var(--accent);
    transition: border-color 140ms ease-out, box-shadow 140ms ease-out;
  }
  input::placeholder { color: var(--ink-muted); opacity: 1; }
  input:hover:not(:disabled) { border-color: var(--ink-muted); }
  input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint); outline: none; }
  .model-current { display: flex; flex-wrap: wrap; gap: 16px 40px; margin: 0 0 24px; padding: 16px; background: var(--surface-inset); border-radius: var(--r-md); }
  .model-current dt { color: var(--ink-muted); font-size: 12px; margin-bottom: 6px; }
  .model-current dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
  #active-thinking { text-transform: capitalize; }
  #model-settings-form select { margin-top: 6px; }
  input:disabled { background: var(--surface-inset); color: var(--ink-muted); cursor: not-allowed; }
  .optional-label { float: right; color: var(--ink-muted); font-size: 12px; font-weight: 400; margin-top: 2px; }
  .copy-field { display: flex; gap: var(--s2); margin-bottom: var(--s4); }
  .copy-field input { min-width: 0; flex: 1; font-size: 13.5px; font-family: var(--font-mono); }
  .copy-field .btn { flex-shrink: 0; }
  .form-note { color: var(--ink-muted); font-size: 13px; margin-top: var(--s2); }
  .note-flush { margin-top: 0; }
  .note-spaced { margin-bottom: var(--s5); }
  .inline-note { display: inline-block; margin: 8px 0 0 12px; }

  /* ------------------------------------------------------------- Alerts */
  .flash {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 12px var(--s4); border-radius: var(--r-md);
    margin-bottom: var(--s5); font-size: 14px; overflow-wrap: anywhere;
    border: 1px solid;
  }
  .flash-success { background: var(--ok-tint); border-color: var(--ok-line); color: var(--ok); }
  .flash-error { background: var(--bad-tint); border-color: var(--bad-line); color: var(--bad); }
  .flash .icon { width: 17px; height: 17px; margin-top: 2px; }

  .notice {
    padding: var(--s4); border-radius: var(--r-md);
    font-size: 13.5px; line-height: 1.6;
    border: 1px solid;
  }
  .notice-warn { background: var(--warn-tint); border-color: var(--warn-line); color: #6f4a10; }

  /* ---------------------------------------------------------- Disclosure */
  .disclosure { border-top: 1px solid var(--line); padding-top: var(--s4); }
  .disclosure-spaced { margin-top: var(--s5); }
  summary {
    cursor: pointer; display: flex; justify-content: space-between; align-items: center;
    gap: var(--s4); list-style: none; border-radius: var(--r-sm);
  }
  summary::-webkit-details-marker { display: none; }
  summary strong { font-size: 14px; font-weight: 600; }
  summary:hover strong { color: var(--accent); }
  .summary-description { display: block; margin-top: 3px; color: var(--ink-muted); font-size: 13px; font-weight: 400; }
  .disclosure-chevron { width: 16px; height: 16px; color: var(--ink-muted); flex-shrink: 0; transition: transform 160ms ease-out; }
  details[open] > summary .disclosure-chevron { transform: rotate(90deg); }
  .disclosure-content { padding-top: var(--s5); }
  .steps { padding-left: 20px; margin: 0 0 var(--s5); font-size: 13.5px; }
  .steps li { padding-left: 4px; margin-bottom: var(--s3); }
  .steps li::marker { color: var(--accent); font-weight: 600; }
  .steps span { display: block; color: var(--ink-muted); margin-top: 2px; }
  .callback-form { margin-top: var(--s5); }

  /* ---------------------------------------------------------- Code block */
  .code-block { border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; margin-bottom: var(--s4); }
  .code-head {
    display: flex; justify-content: space-between; align-items: center; gap: var(--s3);
    padding: 9px var(--s3) 9px var(--s4);
    background: var(--surface-sunken);
    border-bottom: 1px solid var(--line);
  }
  .code-head h3 { font-size: 13px; color: var(--ink-secondary); }
  pre {
    margin: 0; padding: var(--s4);
    background: var(--surface-sunken);
    font: 13px/1.7 var(--font-mono);
    color: var(--ink-secondary);
    overflow-x: auto; tab-size: 2;
  }

  /* ------------------------------------------------------------- Layout2 */
  .content-columns { display: grid; grid-template-columns: minmax(0, 1fr) 288px; gap: var(--s5); align-items: start; }
  .primary-column { min-width: 0; display: grid; gap: var(--s5); }
  .details-column { display: grid; gap: var(--s5); min-width: 0; }
  .section { scroll-margin-top: 84px; }

  .fact-list { display: grid; gap: var(--s4); }
  .fact-list-spaced { margin-bottom: var(--s4); }
  .fact-list dt { font-size: 12.5px; color: var(--ink-muted); margin-bottom: 3px; }
  .fact-list dd { font-size: 13.5px; font-weight: 500; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .health-label { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; margin-bottom: var(--s2); }
  .health-label .dot { width: 8px; height: 8px; border-radius: var(--r-full); background: currentColor; }
  .health-ok { color: var(--ok); }
  .health-warn { color: var(--warn); }
  .health-bad { color: var(--bad); }
  .text-link { display: inline-block; font-size: 13.5px; font-weight: 500; margin-top: var(--s4); }
  .oauth-block { padding-top: var(--s5); }
  .oauth-block h3 { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
  .oauth-block p { margin: 8px 0 var(--s4); color: var(--ink-secondary); font-size: 13.5px; }
  .small-label {
    background: var(--accent-tint); color: var(--accent-ink);
    border-radius: var(--r-sm); padding: 2px 8px;
    font-size: 11.5px; font-weight: 600; letter-spacing: .01em;
  }
  .help-note { color: var(--ink-muted); }
  .help-note h3 { color: var(--ink-secondary); font-size: 14px; margin: 10px 0 6px; }
  .help-note p { font-size: 13px; line-height: 1.6; }
  .help-note .icon { width: 20px; height: 20px; color: var(--accent); }
  .test-prompt {
    padding: 12px var(--s4);
    background: var(--surface-sunken);
    border: 1px solid var(--line-soft);
    border-radius: var(--r-md);
    color: var(--ink-secondary); margin-bottom: var(--s4); font-size: 14px;
  }
  .test-result {
    margin-top: var(--s4); padding: var(--s4);
    border-radius: var(--r-md);
    background: var(--surface-inset); color: var(--ink-secondary);
    white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px;
    border: 1px solid var(--line);
  }
  .test-success { background: var(--ok-tint); color: var(--ok); border-color: var(--ok-line); }
  .test-error { background: var(--bad-tint); color: var(--bad); border-color: var(--bad-line); }
  .page-footer {
    display: flex; align-items: flex-start; gap: var(--s6);
    margin-top: var(--s7); padding-top: var(--s5);
    border-top: 1px solid var(--line);
    color: var(--ink-muted); font-size: 12.5px;
  }
  .page-footer > span { white-space: nowrap; }
  .page-footer p { max-width: 80ch; margin-left: auto; }

  /* ---------------------------------------------------------- Auth pages */
  .auth-page { min-height: 100svh; display: flex; flex-direction: column; }
  .auth-header { padding: var(--s7) var(--s8); }
  .auth-main { width: min(100% - 40px, 432px); margin: clamp(24px, 7vh, 88px) auto var(--s8); }
  .auth-panel { padding: var(--s7); }
  .auth-panel h1 { font-size: 27px; margin-bottom: 9px; }
  .auth-panel .intro { color: var(--ink-secondary); font-size: 14.5px; margin-bottom: var(--s6); }
  .feature-icon {
    display: grid; place-items: center;
    width: 44px; height: 44px;
    background: var(--accent-tint); color: var(--accent);
    border-radius: var(--r-md); margin-bottom: var(--s5);
  }
  .feature-icon .icon { width: 23px; height: 23px; }
  .auth-footer { color: var(--ink-muted); text-align: center; margin-top: var(--s5); font-size: 12.5px; }

  /* ---------------------------------------------------------- Responsive */
  @media (min-width: 1500px) { .main-content { padding-top: var(--s9); } }
  @media (max-width: 1240px) {
    .sidebar { width: 220px; padding-inline: var(--s4); }
    .workspace { margin-left: 220px; }
    .main-content { padding: var(--s7) var(--s6); }
    .topbar { padding-inline: var(--s6); }
    .content-columns { grid-template-columns: minmax(0, 1fr) 250px; gap: var(--s4); }
    .stat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  @media (max-width: 1000px) {
    .content-columns { grid-template-columns: 1fr; }
    .details-column { grid-template-columns: 1fr 1fr; gap: var(--s4); }
    .chart-layout { grid-template-columns: 1fr; }
    .page-heading { align-items: flex-start; }
    .refresh-status .btn-label { display: none; }
    .fact-row { gap: var(--s4); padding: var(--s5); }
    .hero { padding: var(--s5); }
    .card-foot { padding-inline: var(--s5); }
    h1 { font-size: 27px; }
  }
  @media (max-width: 760px) {
    .app { display: block; }
    .sidebar {
      position: static; width: auto; padding: var(--s4) var(--s5) 0;
      border-right: 0; border-bottom: 1px solid var(--line);
      display: grid; grid-template-columns: 1fr auto; gap: var(--s3);
    }
    .sidebar .brand { font-size: 17px; }
    .sidebar nav {
      margin: 0; grid-column: 1 / -1; grid-row: 2;
      display: flex; gap: 4px; padding-bottom: var(--s3);
      overflow-x: auto; scrollbar-width: none;
    }
    .sidebar nav::-webkit-scrollbar { display: none; }
    .nav-section { display: none; }
    .nav-link { gap: 7px; padding: 8px 11px; font-size: 13px; white-space: nowrap; }
    .nav-link .icon { width: 15px; height: 15px; }
    .sidebar-bottom { padding: 0; margin: 0; grid-column: 2; grid-row: 1; align-self: center; }
    .workspace-label { display: none; }
    .logout-button { font-size: 13px; padding: 8px; }
    .logout-button span { display: none; }
    .workspace { margin-left: 0; }
    .topbar { min-height: 52px; padding: 10px var(--s5); }
    .main-content { padding: var(--s6) var(--s5); }
    .hero-symbol { width: 52px; height: 52px; }
    .hero-symbol .icon { width: 31px; height: 31px; }
    .hero h2 { font-size: 21px; }
    .fact-row { grid-template-columns: 1fr 1fr; row-gap: var(--s4); }
    .fact-row > div:first-child { grid-column: 1 / -1; }
    .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .details-column { grid-template-columns: 1fr; }
    .card-head { flex-direction: column; align-items: stretch; gap: var(--s3); }
    .card-head .meta { white-space: normal; }
    .page-footer { display: block; }
    .page-footer p { margin-top: 6px; }
    .btn-small { min-height: 40px; }
    .copy-field { flex-wrap: wrap; }
    .copy-field input { flex-basis: 100%; }
    .copy-field .btn { flex: 1; }
    .inline-note { margin-left: 0; display: block; }
    table { min-width: 620px; }
  }
  @media (max-width: 430px) {
    .main-content { padding: var(--s5) var(--s4); }
    .sidebar { padding-inline: var(--s4); }
    .nav-link { padding-inline: 10px; }
    .nav-link .icon { display: none; }
    .topbar { padding-inline: var(--s4); }
    .private-label { font-size: 11.5px; }
    h1 { font-size: 24px; }
    .page-heading { gap: var(--s3); }
    .page-heading p { font-size: 13.5px; }
    .hero-symbol { display: none; }
    .hero, .card-pad, .chart-card { padding: var(--s4); }
    .fact-row { grid-template-columns: 1fr; padding: var(--s4); }
    .card-foot { padding-inline: var(--s4); }
    .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s2); }
    .stat dd { font-size: 22px; }
    .auth-header { padding: var(--s5); }
    .auth-panel { padding: var(--s5); }
    .auth-main { width: calc(100% - 32px); }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      transition: none !important;
      animation: none !important;
      scroll-behavior: auto !important;
    }
  }
`;
