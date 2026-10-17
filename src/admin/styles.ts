/** Shared, self-contained light theme for the server-rendered admin pages. */
export const ADMIN_CSS = `
  :root { color-scheme:light; --canvas:#f6f7f5; --surface:#fff; --ink:#23332e; --muted:#65716b; --border:#e1e7e1; --accent:#236653; --accent-hover:#184c3d; --tint:#edf4ef; --danger:#a23935; }
  *, *::before, *::after { box-sizing:border-box; }
  html { scroll-padding-top:24px; }
  body { margin:0; background:var(--canvas); color:var(--ink); font:14px/1.6 'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Arial,sans-serif; -webkit-font-smoothing:antialiased; }
  ::selection { background:#cce5d7; color:#153d30; }
  a { color:var(--accent); text-underline-offset:3px; }
  button,input { font:inherit; }
  button,a,input,summary { -webkit-tap-highlight-color:transparent; }
  :focus-visible { outline:3px solid #43866d; outline-offset:4px; }
  h1,h2,h3,p { margin:0; }
  h1,h2,h3 { line-height:1.25; font-weight:600; text-wrap:balance; }
  h1 { font-size:32px; letter-spacing:-.035em; }
  h2 { font-size:19px; letter-spacing:-.025em; }
  h3 { font-size:14px; }
  p { max-width:70ch; }
  code { font-size:.88em; overflow-wrap:anywhere; }
  .icon { width:19px; height:19px; flex-shrink:0; vertical-align:middle; }
  .skip-link { position:fixed; top:8px; left:8px; padding:10px 18px; background:var(--surface); z-index:10; transform:translateY(-160%); }
  .skip-link:focus { transform:none; }
  .brand { display:flex; align-items:center; gap:11px; color:var(--ink); text-decoration:none; font-size:18px; font-weight:650; letter-spacing:-.4px; }
  .brand-mark { width:37px; height:37px; background:var(--accent); color:white; border-radius:11px; display:grid; place-items:center; }
  .brand-mark .icon { width:26px; height:26px; }
  .brand-subtitle { display:block; color:var(--muted); font-size:10px; font-weight:400; letter-spacing:.15px; }
  .sidebar { width:240px; padding:34px 22px 22px; background:#f0f3ef; border-right:1px solid var(--border); position:fixed; inset:0 auto 0 0; display:flex; flex-direction:column; }
  .sidebar nav { display:grid; gap:7px; margin-top:49px; }
  .nav-link { display:flex; align-items:center; gap:12px; padding:11px 14px; border-radius:7px; text-decoration:none; color:#56665c; font-weight:500; }
  .nav-link:hover { background:#e6ece5; color:var(--ink); }
  .nav-active { color:var(--accent); background:#e0eade; }
  .sidebar-bottom { margin-top:auto; padding-top:28px; }
  .workspace-label { display:flex; align-items:center; gap:10px; font-size:12px; font-weight:600; padding:18px 3px; border-top:1px solid #dce3da; }
  .workspace-label small { display:block; color:var(--muted); font-size:11px; font-weight:400; }
  .workspace-avatar { width:32px; height:32px; display:grid; place-items:center; background:#e0e6dc; border-radius:50%; color:#526247; }
  .logout-button { width:100%; display:flex; gap:10px; align-items:center; background:none; border:0; border-radius:6px; padding:10px 8px; color:var(--muted); cursor:pointer; text-align:left; font-size:12px; }
  .logout-button:hover { background:#e6ece5; color:var(--ink); }
  .workspace { margin-left:240px; }
  .topbar { min-height:76px; display:flex; justify-content:space-between; align-items:center; gap:12px; padding:16px 44px; border-bottom:1px solid var(--border); color:var(--muted); font-size:12px; }
  .topbar strong { color:var(--ink); font-weight:500; }
  .breadcrumb-separator { margin:0 13px; color:#929c95; }
  .private-label { display:flex; align-items:center; gap:7px; font-size:11px; }
  .private-label .icon { width:15px; height:15px; }
  .main-content { max-width:1300px; margin:0 auto; padding:43px 44px 24px; }
  .page-heading { display:flex; justify-content:space-between; align-items:center; gap:20px; margin-bottom:30px; scroll-margin-top:25px; }
  .page-heading p { color:var(--muted); margin-top:9px; font-size:13px; }
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:9px; min-height:42px; border:1px solid transparent; border-radius:7px; padding:10px 16px; background:var(--accent); color:white; font-weight:600; font-size:12px; cursor:pointer; text-decoration:none; line-height:1.4; transition:background-color 140ms ease-out,border-color 140ms ease-out; }
  .btn:hover { background:var(--accent-hover); }
  .btn-secondary { background:var(--surface); border-color:#d9e1d9; color:#42574b; }
  .btn-secondary:hover { background:#f0f4ef; border-color:#bdccbf; }
  .btn-danger { color:var(--danger); background:transparent; }
  .btn-danger:hover { background:#fcf0ed; }
  .btn:disabled { background:#e9ede8; border-color:#e0e5df; color:#737e75; cursor:not-allowed; }
  .btn-small { min-height:36px; padding:8px 12px; font-size:11px; }
  .btn .icon { width:16px; height:16px; }
  .btn-wide { width:100%; }
  .connection-panel { background:var(--surface); border:1px solid var(--border); border-radius:13px; overflow:hidden; margin-bottom:30px; }
  .connection-summary { display:flex; justify-content:space-between; align-items:center; gap:22px; padding:27px 30px 25px; background:#f1f6f0; }
  .connection-copy h2 { margin:13px 0 8px; font-size:24px; }
  .connection-copy p { color:#52664f; font-size:13px; max-width:60ch; }
  .status-badge { display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:600; }
  .status-dot { width:6px; height:6px; border-radius:50%; background:currentColor; }
  .badge-connected { color:#286440; }
  .badge-attention { color:#946019; }
  .badge-disconnected { color:#58695a; }
  .connection-symbol { flex-shrink:0; width:70px; height:70px; border:1px solid #cddccb; border-radius:50%; display:grid; place-items:center; color:#87a283; }
  .connection-symbol .icon { width:44px; height:44px; stroke-width:1; }
  dl { margin:0; }
  .account-facts { display:grid; grid-template-columns:1.1fr 1fr 1fr; padding:24px 30px; gap:22px; }
  dt { font-size:11px; color:var(--muted); margin-bottom:5px; }
  dd { margin:0; font-size:13px; font-weight:500; overflow-wrap:anywhere; }
  .mode-dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:#638c6e; margin-right:6px; vertical-align:middle; }
  .inline-status { display:inline-block; margin-left:6px; font-size:10px; font-weight:500; }
  .healthy { color:#2d6f45; }
  .degraded { color:#a05b18; }
  .connection-footer { border-top:1px solid #edf0eb; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:14px; padding:13px 30px; }
  .connection-footer>span { color:var(--muted); font-size:11px; display:flex; gap:7px; align-items:center; }
  .connection-footer>span .icon { width:14px; height:14px; }
  .actions { display:flex; align-items:center; flex-wrap:wrap; gap:4px; }
  .content-columns { display:grid; grid-template-columns:minmax(0,1fr) 230px; gap:30px; align-items:start; }
  .primary-column { min-width:0; }
  .panel { border:1px solid var(--border); border-radius:12px; padding:25px; background:var(--surface); margin-bottom:18px; scroll-margin-top:24px; }
  .section-title { display:flex; gap:12px; align-items:center; }
  .section-title h2,.section-heading { font-size:17px; font-weight:600; letter-spacing:-.025em; }
  .section-title p,.summary-description { display:block; margin-top:5px; color:var(--muted); font-weight:400; font-size:12px; line-height:1.5; }
  .section-icon { width:36px; height:36px; flex-shrink:0; display:grid; place-items:center; color:#52735b; background:#f0f4ee; border-radius:9px; }
  .oauth-method { padding:25px 0; }
  .oauth-method h3 { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .oauth-method p { margin:9px 0 16px; color:var(--muted); font-size:12px; }
  .small-label { color:#4e6e50; background:#edf4e9; border-radius:4px; font-size:10px; padding:3px 7px; font-weight:500; }
  .setup-note { color:#66634b; background:#f7f6ef; border-radius:7px; padding:12px; font-size:12px; }
  .disclosure { border-top:1px solid var(--border); padding-top:18px; }
  summary { cursor:pointer; display:flex; justify-content:space-between; align-items:center; gap:16px; list-style:none; border-radius:4px; }
  summary::-webkit-details-marker { display:none; }
  summary strong { font-size:13px; font-weight:600; }
  summary:hover strong,summary:hover .section-heading { color:var(--accent); }
  .disclosure-chevron { width:15px; height:15px; color:var(--muted); transition:transform 160ms ease-out; }
  details[open]>summary .disclosure-chevron { transform:rotate(90deg); }
  .disclosure-content { padding-top:20px; }
  .steps { padding-left:22px; margin:0 0 20px; font-size:12px; }
  .steps li { padding-left:4px; margin-bottom:12px; }
  .steps li::marker { color:var(--accent); font-weight:600; }
  .steps span { display:block; color:var(--muted); margin-top:3px; }
  .callback-form { margin-top:22px; }
  .form-group { margin-bottom:17px; }
  label { display:block; font-size:12px; font-weight:600; margin-bottom:7px; }
  input[type=text],input[type=password] { width:100%; min-height:44px; padding:11px 13px; border:1px solid #cdd7cd; border-radius:7px; background:#fdfefd; color:var(--ink); font-size:13px; caret-color:var(--accent); }
  input::placeholder { color:#6c776e; opacity:1; }
  input:hover { border-color:#a6b8a7; }
  input:focus { border-color:var(--accent); }
  .optional-label,.required-label { float:right; color:var(--muted); font-size:10px; font-weight:400; margin-top:2px; }
  .muted { color:var(--muted); font-size:12px; margin-bottom:18px; }
  .detail-section { padding:5px 0 22px; }
  .detail-section h2 { font-size:14px; margin-bottom:9px; }
  .token-facts { display:grid; gap:21px; font-variant-numeric:tabular-nums; }
  .token-facts dd { font-size:12px; }
  .help-note { border-top:1px solid var(--border); padding:22px 0; color:var(--muted); }
  .help-note>.icon { color:#64836a; width:22px; height:22px; margin-bottom:10px; }
  .help-note h3 { color:#4e6253; font-size:12px; margin-bottom:8px; }
  .help-note p { font-size:12px; }
  .page-footer { padding-top:20px; margin-top:12px; border-top:1px solid var(--border); display:flex; align-items:flex-start; gap:30px; color:var(--muted); font-size:10px; }
  .page-footer>span { white-space:nowrap; }
  .page-footer p { max-width:85ch; margin-left:auto; }
  .flash { padding:13px 16px; border-radius:8px; margin-bottom:20px; font-size:13px; overflow-wrap:anywhere; }
  .flash-success { background:#eaf4ec; border:1px solid #c9dfcf; color:#2a5b3d; }
  .flash-error { background:#fcf0ec; border:1px solid #ebd1c8; color:#8a3930; }
  .auth-page { min-height:100svh; }
  .auth-header { padding:32px 40px; }
  .auth-main { width:min(100% - 40px,440px); margin:clamp(24px,8vh,100px) auto 40px; }
  .auth-panel { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:36px; }
  .auth-panel h1 { font-size:29px; margin-bottom:10px; }
  .auth-panel .intro { color:var(--muted); font-size:14px; margin-bottom:28px; }
  .feature-icon { display:grid; place-items:center; width:45px; height:45px; background:var(--tint); color:var(--accent); border-radius:12px; margin-bottom:25px; }
  .feature-icon .icon { width:24px; height:24px; }
  .form-note { color:var(--muted); font-size:11px; margin-top:16px; }
  .auth-footer { color:var(--muted); text-align:center; margin-top:23px; font-size:11px; }
  @media(min-width:1500px) { .main-content { padding-top:52px; } }
  @media(max-width:1180px) { .sidebar { width:210px; padding-inline:17px; } .workspace { margin-left:210px; } .main-content { padding:30px 28px; } .topbar { padding-inline:28px; } .content-columns { grid-template-columns:minmax(0,1fr) 190px; gap:24px; } }
  @media(max-width:980px) { .content-columns { grid-template-columns:1fr; } .details-column { display:grid; grid-template-columns:1fr 1fr; gap:28px; } .help-note { border-top:0; border-left:1px solid var(--border); padding:5px 0 5px 22px; } .page-heading { align-items:flex-start; } .refresh-status { padding:11px; } .refresh-status span { display:none; } .account-facts { gap:16px; padding:22px; } .connection-summary { padding:24px; } .connection-footer { padding-inline:22px; } h1 { font-size:28px; } }
  @media(max-width:720px) { .sidebar { position:static; width:auto; padding:18px 20px 0; border-right:0; border-bottom:1px solid var(--border); display:grid; grid-template-columns:1fr auto; gap:16px; } .sidebar .brand { font-size:17px; } .sidebar nav { margin:0; grid-column:1/-1; grid-row:2; display:flex; gap:5px; padding-bottom:12px; overflow-x:auto; } .nav-link { gap:7px; padding:9px 11px; font-size:12px; white-space:nowrap; } .nav-link .icon { width:16px; height:16px; } .sidebar-bottom { padding:0; margin:0; grid-column:2; grid-row:1; align-self:center; } .workspace-label { display:none; } .logout-button { font-size:11px; } .workspace { margin-left:0; } .topbar { min-height:52px; padding:12px 20px; } .main-content { padding:27px 20px; } .connection-symbol { width:53px; height:53px; } .connection-symbol .icon { width:35px; height:35px; } .connection-copy h2 { font-size:22px; } .account-facts { grid-template-columns:1fr 1fr; row-gap:20px; } .account-facts>div:first-child { grid-column:1/-1; } .page-footer { display:block; } .page-footer p { margin-top:8px; } .btn-small { min-height:42px; } }
  @media(max-width:420px) { .main-content { padding:24px 16px; } .sidebar { padding-inline:16px; } .sidebar nav { gap:0; } .nav-link { padding-inline:9px; } .nav-link .icon { display:none; } .topbar { padding-inline:16px; } .private-label { font-size:10px; } h1 { font-size:26px; } .page-heading { gap:10px; } .page-heading p { font-size:12px; } .connection-symbol { display:none; } .connection-summary,.panel { padding:21px; } .account-facts { grid-template-columns:1fr; } .connection-footer { align-items:flex-start; } .details-column { grid-template-columns:1fr; gap:0; } .help-note { border-left:0; border-top:1px solid var(--border); padding:20px 0; } .auth-header { padding:24px; } .auth-panel { padding:27px; } .auth-main { width:calc(100% - 32px); } }
  [hidden] { display:none !important; }
  .section-heading-row { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; }
  .section-heading-row .muted { margin:0; font-size:11px; }
  .section-description { margin:10px 0 20px; }
  .usage-section { margin-bottom:30px; padding:6px 0 22px; border-bottom:1px solid var(--border); scroll-margin-top:24px; }
  .usage-section h2 { font-size:17px; }
  .usage-metrics { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:20px; margin-top:22px; }
  .usage-metrics dd { font-size:25px; font-weight:600; letter-spacing:-.025em; font-variant-numeric:tabular-nums; }
  .usage-metrics dt { font-size:12px; }
  .usage-section .form-note { max-width:100ch; }
  .test-prompt { padding:13px 15px; border:1px solid var(--border); border-radius:7px; color:#4d6253; margin-bottom:16px; font-size:13px; }
  .inline-note { display:inline-block; margin:8px 0 0 12px; }
  .test-result { margin-top:18px; padding:14px; border-radius:7px; background:var(--canvas); color:var(--muted); white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; }
  .test-success { background:#eaf4ec; color:#2a5b3d; }
  .test-error { background:#fcf0ec; color:#8a3930; }
  .copy-field { display:flex; gap:8px; margin-bottom:18px; }
  .copy-field input { min-width:0; flex:1; font-size:12px; }
  .copy-field .btn { flex-shrink:0; padding-inline:12px; }
  .code-disclosure { margin-top:22px; }
  .code-heading { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:10px; }
  pre { background:#f3f5f2; color:#34503e; border-radius:8px; padding:16px; font:12px/1.7 Consolas,monospace; overflow-x:auto; margin:0 0 24px; tab-size:2; }
  .health-label { font-size:13px; font-weight:600; color:#425f49; margin:8px 0; }
  .text-link { display:inline-block; font-size:12px; margin-top:17px; }
  .storage-section { border-top:1px solid var(--border); padding-top:22px; }
  .storage-notice { background:#f4f0e5; color:#76602e; padding:12px; font-size:12px; margin-top:20px; border-radius:7px; }
  .activity-panel { margin-top:12px; }
  .table-scroll { overflow-x:auto; border-radius:5px; }
  table { width:100%; border-collapse:collapse; font-size:12px; text-align:left; }
  th { font-weight:500; font-size:11px; color:var(--muted); background:#f6f8f5; }
  th,td { padding:12px; border-bottom:1px solid var(--border); }
  td { font-variant-numeric:tabular-nums; overflow-wrap:anywhere; max-width:240px; }
  td:first-child { white-space:nowrap; }
  .result-label { font-size:11px; font-weight:500; }
  .result-success { color:#2d6f45; } .result-failed { color:#a23935; } .result-cancelled { color:#796139; }
  .empty-state { padding:30px 14px; text-align:center; color:var(--muted); }
  @media(max-width:980px) { .details-column { grid-template-columns:1fr 1fr; } .storage-section { border-top:0; padding-top:5px; } .details-column .help-note { grid-column:1/-1; border-left:0; padding-left:0; } .usage-metrics { gap:12px; } .usage-metrics dd { font-size:22px; } }
  @media(max-width:720px) { .usage-metrics { grid-template-columns:repeat(3,minmax(0,1fr)); row-gap:20px; } .sidebar nav { max-width:calc(100vw - 40px); } .copy-field { flex-wrap:wrap; } .copy-field input { flex-basis:100%; } .copy-field .btn { flex:1; } .inline-note { margin-left:0; display:block; } table { min-width:620px; } .usage-section .section-heading-row { align-items:flex-start; flex-direction:column; gap:7px; } }
  @media(max-width:420px) { .details-column { grid-template-columns:1fr; } .storage-section { border-top:1px solid var(--border); padding-top:22px; } .usage-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } .usage-metrics dd { font-size:24px; } .section-heading-row h2 { font-size:17px; } }
  @media(prefers-reduced-motion:reduce) { *,*::before,*::after { transition:none !important; scroll-behavior:auto !important; } }
`;
