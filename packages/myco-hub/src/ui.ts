import type { ProjectRecord } from './discovery.js';

export function renderHubHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Myco Hub</title>
  <style>
    :root {
      color-scheme: dark;
      --surface: #111111;
      --surface-dim: #0c0c0c;
      --surface-container-lowest: #080808;
      --surface-container-low: #1a1a1a;
      --surface-container: #242424;
      --surface-container-high: #333333;
      --surface-container-highest: #424242;
      --on-surface: #e5e2e1;
      --on-surface-variant: #c1c8c2;
      --outline: #8b928c;
      --outline-variant: #424843;
      --primary: #79c6a4;
      --warning: #d8b35f;
      --destructive: #ff8a7a;
      --ghost-border: color-mix(in srgb, var(--outline-variant), transparent 72%);
      --radius: 6px;
      --font-ui: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-heading: Newsreader, Georgia, serif;
      --font-data: "JetBrains Mono", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html { min-height: 100%; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--surface);
      color: var(--on-surface);
      font: 14px/1.45 var(--font-ui);
    }
    a { color: inherit; }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 248px minmax(0, 1fr);
    }
    .sidebar {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 18px;
      padding: 18px 14px;
      border-right: 1px solid var(--ghost-border);
      background: var(--surface-container-low);
    }
    .brand {
      padding: 6px 10px 12px;
      border-bottom: 1px solid var(--ghost-border);
    }
    .brand-mark {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--font-data);
      font-size: 19px;
      letter-spacing: 0;
      color: #9fc3ee;
    }
    .brand-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--outline);
    }
    .brand-subtitle {
      margin-top: 8px;
      color: var(--on-surface-variant);
      font-family: var(--font-data);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .nav {
      display: grid;
      gap: 4px;
    }
    .nav-item {
      height: 38px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border-radius: var(--radius);
      padding: 0 10px;
      color: var(--on-surface-variant);
      font-family: var(--font-data);
      font-size: 13px;
      text-decoration: none;
      transition: background 160ms ease, color 160ms ease;
    }
    .nav-item:hover,
    .nav-item.active {
      background: var(--surface-container-high);
      color: var(--on-surface);
    }
    .nav-item.active {
      color: #9fc3ee;
      box-shadow: inset 2px 0 0 var(--primary);
    }
    .nav-kicker {
      color: var(--outline);
      font-size: 11px;
      text-transform: uppercase;
    }
    .sidebar-footer {
      margin-top: auto;
      border-top: 1px solid var(--ghost-border);
      padding: 14px 10px 4px;
      color: var(--on-surface-variant);
      font-family: var(--font-data);
      font-size: 12px;
    }
    .main {
      min-width: 0;
      background:
        linear-gradient(90deg, color-mix(in srgb, var(--ghost-border), transparent 82%) 1px, transparent 1px) 0 0 / 56px 56px,
        var(--surface);
    }
    main {
      width: 100%;
      padding: 18px 24px 24px;
    }
    .dashboard {
      display: grid;
      gap: 14px;
      width: 100%;
    }
    .dashboard-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }
    .hub-context {
      min-width: 0;
    }
    .context-label {
      margin: 0;
      color: var(--on-surface-variant);
      font-family: var(--font-data);
      font-size: 11px;
      text-transform: uppercase;
    }
    .machine-name {
      margin-top: 2px;
      overflow: hidden;
      color: var(--on-surface);
      font-family: var(--font-data);
      font-size: 18px;
      font-weight: 740;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    button,
    a.button,
    summary.menu-trigger {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 34px;
      border: 1px solid var(--ghost-border);
      border-radius: var(--radius);
      background: transparent;
      color: var(--on-surface);
      padding: 0 12px;
      text-decoration: none;
      cursor: pointer;
      font: 600 13px/1 var(--font-ui);
      transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
    }
    button:hover,
    a.button:hover,
    summary.menu-trigger:hover {
      border-color: color-mix(in srgb, var(--outline-variant), transparent 20%);
      background: var(--surface-container-high);
    }
    button.primary,
    a.primary {
      border-color: color-mix(in srgb, var(--primary), transparent 8%);
      color: var(--primary);
      background: color-mix(in srgb, var(--primary), transparent 92%);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: .5;
    }
    button:focus-visible,
    a.button:focus-visible,
    summary.menu-trigger:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--primary), transparent 45%);
      outline-offset: 2px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(152px, 1fr));
      gap: 10px;
    }
    .stat-card {
      min-width: 0;
      border: 1px solid var(--ghost-border);
      border-top-color: color-mix(in srgb, var(--primary), transparent 20%);
      border-radius: var(--radius);
      background: color-mix(in srgb, var(--surface-container-low), transparent 10%);
      padding: 12px 14px;
    }
    .stat-label {
      color: var(--on-surface-variant);
      font-family: var(--font-data);
      font-size: 11px;
      text-transform: uppercase;
    }
    .stat-value {
      margin-top: 8px;
      color: #9fc3ee;
      font-family: var(--font-data);
      font-size: clamp(24px, 3vw, 32px);
      font-weight: 760;
      line-height: 1;
    }
    .stat-subtext {
      margin-top: 6px;
      color: var(--on-surface-variant);
      font-family: var(--font-data);
      font-size: 12px;
    }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding-top: 6px;
      margin-bottom: 10px;
    }
    .section-head h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .section-count {
      color: var(--on-surface-variant);
      font-family: var(--font-data);
      font-size: 12px;
    }
    .project-list {
      display: grid;
      gap: 10px;
    }
    .project-row {
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(240px, 1.4fr) 136px minmax(240px, 1fr) auto;
      gap: 14px;
      align-items: center;
      border: 1px solid var(--ghost-border);
      border-radius: var(--radius);
      background: color-mix(in srgb, var(--surface-container-low), transparent 7%);
      padding: 12px 14px;
      transition: background 160ms ease, border-color 160ms ease;
    }
    .project-row:hover {
      border-color: color-mix(in srgb, var(--outline-variant), transparent 44%);
      background: var(--surface-container-low);
    }
    .project-main {
      min-width: 0;
    }
    .project-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 16px;
      font-weight: 750;
    }
    .project-path {
      margin-top: 3px;
      color: var(--on-surface-variant);
      font-family: var(--font-data);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .source {
      margin-top: 8px;
      color: var(--outline);
      font-size: 12px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 28px;
      border-radius: 999px;
      border: 1px solid var(--ghost-border);
      padding: 0 10px;
      color: var(--on-surface);
      white-space: nowrap;
      width: fit-content;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--outline);
    }
    .running .dot { background: var(--primary); box-shadow: 0 0 12px color-mix(in srgb, var(--primary), transparent 45%); }
    .unhealthy .dot { background: var(--destructive); }
    .starting .dot { background: var(--warning); }
    .runtime {
      min-width: 0;
      display: grid;
      gap: 6px;
      color: var(--on-surface-variant);
      font-family: var(--font-data);
      font-size: 12px;
    }
    .runtime-strong {
      color: var(--on-surface);
      font-size: 14px;
      font-weight: 700;
    }
    .mini-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 7px;
    }
    .mini-metric {
      min-width: 0;
      border-radius: var(--radius);
      background: var(--surface-container-lowest);
      padding: 7px 8px;
      border: 1px solid color-mix(in srgb, var(--ghost-border), transparent 26%);
    }
    .mini-label {
      color: var(--outline);
      font-family: var(--font-data);
      font-size: 10px;
      text-transform: uppercase;
    }
    .mini-value {
      margin-top: 3px;
      overflow: hidden;
      color: var(--on-surface);
      font-family: var(--font-data);
      font-size: 15px;
      font-weight: 740;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .actions {
      position: relative;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      align-items: center;
      min-width: 188px;
    }
    .actions .button {
      flex: 0 0 auto;
      min-width: 64px;
      min-height: 34px;
      padding-inline: 14px;
    }
    .project-menu {
      position: relative;
    }
    summary.menu-trigger {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      list-style: none;
      min-height: 34px;
    }
    summary.menu-trigger::-webkit-details-marker { display: none; }
    .chevron {
      border: solid currentColor;
      border-width: 0 1.5px 1.5px 0;
      display: inline-block;
      padding: 3px;
      transform: rotate(45deg) translateY(-1px);
    }
    details[open] .chevron {
      transform: rotate(225deg) translateY(-1px);
    }
    .menu-panel {
      position: absolute;
      right: 0;
      top: calc(100% + 6px);
      z-index: 30;
      display: grid;
      min-width: 144px;
      gap: 4px;
      border: 1px solid var(--ghost-border);
      border-radius: var(--radius);
      background: var(--surface-container-highest);
      padding: 6px;
      box-shadow: 0 18px 48px rgba(0,0,0,.32);
    }
    .menu-panel button {
      width: 100%;
      justify-content: flex-start;
      text-align: left;
      border-color: transparent;
      padding: 0 10px;
    }
    .menu-panel button.danger {
      color: var(--destructive);
    }
    .empty,
    .error {
      border: 1px solid var(--ghost-border);
      border-radius: var(--radius);
      background: var(--surface-container-low);
      padding: 28px;
      color: var(--on-surface-variant);
    }
    .loading {
      display: grid;
      gap: 10px;
    }
    .skeleton {
      min-height: 70px;
      border-radius: var(--radius);
      background: linear-gradient(90deg, var(--surface-container-low), var(--surface-container), var(--surface-container-low));
      background-size: 220% 100%;
      animation: pulse 1.2s ease-in-out infinite;
    }
    @keyframes pulse {
      0% { background-position: 0 0; }
      100% { background-position: -220% 0; }
    }
    @media (max-width: 1080px) {
      .shell { grid-template-columns: 1fr; }
      .sidebar {
        position: sticky;
        top: 0;
        z-index: 20;
        flex-direction: row;
        align-items: center;
        overflow-x: auto;
        gap: 16px;
        padding: 10px 14px;
        border-right: 0;
        border-bottom: 1px solid var(--ghost-border);
      }
      .brand {
        min-width: 152px;
        border-bottom: 0;
        padding: 0;
      }
      .brand-mark {
        font-size: 17px;
      }
      .brand-subtitle {
        display: none;
      }
      .nav {
        grid-auto-flow: column;
        grid-auto-columns: max-content;
      }
      .nav-item {
        height: 34px;
        min-width: 0;
        padding: 0 9px;
        font-size: 12px;
      }
      .sidebar-footer { display: none; }
      main { padding: 14px; }
      .project-row {
        grid-template-columns: minmax(0, 1fr);
        align-items: start;
      }
      .actions {
        justify-content: flex-start;
        min-width: 0;
      }
      .mini-metrics { grid-template-columns: repeat(3, minmax(90px, 1fr)); }
    }
    @media (max-width: 640px) {
      .sidebar {
        align-items: stretch;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px;
      }
      .nav {
        width: 100%;
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: max-content;
        overflow-x: auto;
      }
      .nav-item {
        width: auto;
      }
      .dashboard-toolbar {
        align-items: flex-start;
        flex-direction: column;
      }
      main { padding: 12px; }
      .summary { grid-template-columns: repeat(auto-fit, minmax(136px, 1fr)); }
      .mini-metrics { grid-template-columns: 1fr; }
      .actions {
        width: 100%;
      }
      .actions .button,
      .project-menu,
      summary.menu-trigger {
        width: 100%;
      }
      .menu-panel {
        left: 0;
        right: auto;
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar" aria-label="Hub navigation">
      <div class="brand">
        <div class="brand-mark"><span>myco hub</span><span class="brand-dot"></span></div>
        <div class="brand-subtitle">Local Daemon Network</div>
      </div>
      <nav class="nav">
        <a class="nav-item active" href="/"><span>Dashboard</span><span class="nav-kicker">live</span></a>
        <a class="nav-item" href="/"><span>Projects</span><span class="nav-kicker" id="nav-project-count">0</span></a>
        <a class="nav-item" href="/"><span>Activity</span><span class="nav-kicker">soon</span></a>
        <a class="nav-item" href="/"><span>Insights</span><span class="nav-kicker">soon</span></a>
      </nav>
      <div class="sidebar-footer">
        <div id="hub-port">Port 21000</div>
        <div id="last-refresh">Loading</div>
      </div>
    </aside>
    <div class="main">
      <main>
        <div id="content"></div>
      </main>
    </div>
  </div>
  <script>
    if (window.self !== window.top) {
      window.top.location.href = '/';
    }

    async function api(path, init) {
      const res = await fetch(path, init);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    var loadSequence = 0;
    var actionPending = false;

    function setBusy(value) {
      actionPending = value;
      document.querySelectorAll('button').forEach(function (button) {
        button.disabled = value;
      });
    }

    function statusCell(status) {
      return '<span class="status ' + status + '"><span class="dot"></span>' + status + '</span>';
    }

    function formatNumber(value) {
      if (value === null || value === undefined) return '0';
      if (typeof value === 'string' && value.trim() !== '' && Number.isNaN(Number(value))) return value;
      if (Number.isNaN(Number(value))) return '0';
      return new Intl.NumberFormat().format(Number(value));
    }

    function formatUptime(seconds) {
      const total = Number(seconds || 0);
      if (!total) return 'unknown';
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      if (days > 0) return days + 'd ' + hours + 'h';
      if (hours > 0) return hours + 'h ' + minutes + 'm';
      return Math.max(1, minutes) + 'm';
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]);
    }

    function sourceLabel(source) {
      if (source === 'registration') return 'registered by daemon';
      if (source === 'daemon-api') return 'found by port scan + daemon API';
      if (source === 'process-scan') return 'found by process scan';
      return 'source unknown';
    }

    function statsValue(project, path, fallback) {
      return path.reduce((value, key) => value && value[key], project.stats) ?? fallback;
    }

    async function loadProjectStats(project) {
      if (project.runtime.status !== 'running') return null;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 1200);
      try {
        const res = await fetch('/p/' + encodeURIComponent(project.id) + '/api/stats', {
          signal: controller.signal,
          cache: 'no-store'
        });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      } finally {
        window.clearTimeout(timeout);
      }
    }

    async function action(id, verb) {
      if (actionPending) return;
      setBusy(true);
      try {
        await api('/api/projects/' + encodeURIComponent(id) + '/' + verb, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        document.querySelectorAll('details[open]').forEach((details) => { details.open = false; });
        await load();
      } finally {
        setBusy(false);
      }
    }

    function renderStat(label, value, subtext) {
      return '<article class="stat-card">' +
        '<div class="stat-label">' + escapeHtml(label) + '</div>' +
        '<div class="stat-value">' + escapeHtml(value) + '</div>' +
        '<div class="stat-subtext">' + escapeHtml(subtext) + '</div>' +
      '</article>';
    }

    function renderMiniMetric(label, value) {
      return '<div class="mini-metric">' +
        '<div class="mini-label">' + escapeHtml(label) + '</div>' +
        '<div class="mini-value">' + escapeHtml(value) + '</div>' +
      '</div>';
    }

    function renderProject(project) {
      const runtime = project.runtime;
      const projectId = encodeURIComponent(project.id);
      const version = runtime.version ? 'v' + runtime.version : 'version unknown';
      const port = runtime.port ? ':' + runtime.port : 'no port';
      const activeSessions = statsValue(project, ['daemon', 'active_sessions'], []);
      const activeSessionCount = Array.isArray(activeSessions) ? activeSessions.length : 0;
      const sessionCount = statsValue(project, ['vault', 'session_count'], 'n/a');
      const sporeCount = statsValue(project, ['vault', 'spore_count'], 'n/a');
      const uptime = statsValue(project, ['daemon', 'uptime_seconds'], runtime.uptime_seconds);
      const statsAvailable = project.stats ? 'live stats' : (runtime.status === 'running' ? 'stats unavailable' : 'daemon stopped');
      return '<article class="project-row">' +
        '<div class="project-main">' +
          '<div class="project-name">' + escapeHtml(project.name) + '</div>' +
          '<div class="project-path">' + escapeHtml(project.projectRoot) + '</div>' +
          '<div class="source">' + sourceLabel(project.source) + ' - ' + statsAvailable + '</div>' +
        '</div>' +
        '<div>' + statusCell(runtime.status) + '</div>' +
        '<div class="runtime">' +
          '<div class="runtime-strong">' + escapeHtml(version + ' ' + port) + '</div>' +
          '<div>uptime ' + escapeHtml(formatUptime(uptime)) + '</div>' +
          '<div class="mini-metrics">' +
            renderMiniMetric('Active', formatNumber(activeSessionCount)) +
            renderMiniMetric('Sessions', formatNumber(sessionCount)) +
            renderMiniMetric('Spores', formatNumber(sporeCount)) +
          '</div>' +
        '</div>' +
        '<div class="actions">' +
          '<a class="button primary" href="/view/' + projectId + '/">Open</a>' +
          '<details class="project-menu">' +
            '<summary class="menu-trigger">Manage <span class="chevron"></span></summary>' +
            '<div class="menu-panel">' +
              '<button data-project-id="' + escapeHtml(project.id) + '" data-action="start">Start</button>' +
              '<button data-project-id="' + escapeHtml(project.id) + '" data-action="stop">Stop</button>' +
              '<button data-project-id="' + escapeHtml(project.id) + '" data-action="restart">Restart</button>' +
              '<button class="danger" data-project-id="' + escapeHtml(project.id) + '" data-action="forget">Forget from Hub</button>' +
            '</div>' +
          '</details>' +
        '</div>' +
      '</article>';
    }

    function renderDashboard(projects, hub) {
      const running = projects.filter((project) => project.runtime.status === 'running').length;
      const stopped = projects.filter((project) => project.runtime.status !== 'running').length;
      const active = projects.reduce((sum, project) => {
        const sessions = statsValue(project, ['daemon', 'active_sessions'], []);
        return sum + (Array.isArray(sessions) ? sessions.length : 0);
      }, 0);
      const sessions = projects.reduce((sum, project) => sum + Number(statsValue(project, ['vault', 'session_count'], 0) || 0), 0);
      const spores = projects.reduce((sum, project) => sum + Number(statsValue(project, ['vault', 'spore_count'], 0) || 0), 0);
      const hostname = hub?.hostname || 'local machine';
      return '<div class="dashboard">' +
        '<div class="dashboard-toolbar">' +
          '<div class="hub-context"><p class="context-label">Machine</p><div class="machine-name">' + escapeHtml(hostname) + '</div></div>' +
          '<button id="refresh" type="button">Refresh</button>' +
        '</div>' +
        '<section class="summary" aria-label="Network summary">' +
          renderStat('Projects', formatNumber(projects.length), running + ' running') +
          renderStat('Running', formatNumber(running), stopped + ' stopped') +
          renderStat('Active Sessions', formatNumber(active), 'across live daemons') +
          renderStat('Sessions', formatNumber(sessions), 'indexed locally') +
          renderStat('Spores', formatNumber(spores), 'available context') +
        '</section>' +
        '<section>' +
          '<div class="section-head"><h2>Projects</h2><span class="section-count">' + formatNumber(projects.length) + ' daemons</span></div>' +
          '<div class="project-list">' + projects.map(renderProject).join('') + '</div>' +
        '</section>' +
      '</div>';
    }

    async function load() {
      const sequence = ++loadSequence;
      const content = document.getElementById('content');
      content.innerHTML = '<div class="loading"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
      const data = await api('/api/projects');
      if (sequence !== loadSequence) return;
      if (!data.projects.length) {
        content.innerHTML = '<div class="empty">No Myco projects found. Add scan roots in ~/.myco/hub/config.json if your projects live outside the default locations.</div>';
        document.getElementById('nav-project-count').textContent = '0';
        return;
      }
      const projects = await Promise.all(data.projects.map(async (project) => ({
        ...project,
        stats: await loadProjectStats(project)
      })));
      if (sequence !== loadSequence) return;
      content.innerHTML = renderDashboard(projects, data.hub);
      document.getElementById('nav-project-count').textContent = String(projects.length);
      document.querySelector('.brand-subtitle').textContent = data.hub?.hostname || 'Local Machine';
      document.getElementById('hub-port').textContent = 'Port ' + (data.hub?.port || '21000');
      document.getElementById('last-refresh').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      setBusy(actionPending);
    }

    document.addEventListener('click', (event) => {
      if (event.target.closest('#refresh')) {
        if (actionPending) return;
        load().catch((err) => {
          document.getElementById('content').innerHTML = '<div class="error">' + escapeHtml(err.message) + '</div>';
        });
      }
    });
    document.getElementById('content').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      action(button.dataset.projectId, button.dataset.action).catch((err) => {
        document.getElementById('content').innerHTML = '<div class="error">' + escapeHtml(err.message) + '</div>';
      });
    });
    load().catch((err) => {
      document.getElementById('content').innerHTML = '<div class="error">' + escapeHtml(err.message) + '</div>';
    });
  </script>
</body>
</html>`;
}

export function renderProjectFrameHtml(project: ProjectRecord, projects: ProjectRecord[] = [project]): string {
  const encodedId = encodeURIComponent(project.id);
  const name = escapeHtml(project.name);
  const root = escapeHtml(project.projectRoot);
  const options = projects
    .map((item) => {
      const selected = item.id === project.id ? ' selected' : '';
      return `<option value="${escapeHtml(item.id)}"${selected}>${escapeHtml(item.name)}</option>`;
    })
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name} - Myco Hub</title>
  <style>
    :root {
      color-scheme: dark;
      --bar: #151812;
      --fg: #f2f0e8;
      --muted: #a4a69d;
      --line: #34362f;
      --accent: #79c6a4;
      --hover: #20241d;
    }
    * { box-sizing: border-box; }
    html, body {
      height: 100%;
      margin: 0;
      background: #050609;
      color: var(--fg);
      font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow: hidden;
    }
    .hubbar {
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 14px;
      background: var(--bar);
      border-bottom: 1px solid var(--line);
    }
    .identity {
      min-width: 0;
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .hub {
      height: 30px;
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      color: var(--accent);
      font-weight: 700;
      letter-spacing: 0;
      text-decoration: none;
      white-space: nowrap;
    }
    .hub:hover { background: var(--hover); }
    .project {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 650;
    }
    select {
      width: 220px;
      max-width: 26vw;
      height: 30px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--bar);
      color: var(--fg);
      padding: 0 28px 0 10px;
      font: inherit;
    }
    .path {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex: 0 0 auto;
    }
    button {
      height: 28px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: transparent;
      color: var(--fg);
      padding: 0 10px;
      text-decoration: none;
      cursor: pointer;
      font: inherit;
    }
    button:hover { background: var(--hover); }
    iframe {
      width: 100%;
      height: calc(100vh - 48px);
      border: 0;
      display: block;
      background: #050609;
    }
  </style>
</head>
<body>
  <div class="hubbar">
    <div class="identity">
      <a class="hub" href="/" target="_top">Back to Hub</a>
      <select id="project-switcher" aria-label="Project">${options}</select>
      <span class="path">${root}</span>
    </div>
    <div class="actions">
      <button id="reload">Reload Project</button>
    </div>
  </div>
  <iframe id="project" src="/p/${encodedId}/" title="${name}"></iframe>
  <script>
    var projectId = ${JSON.stringify(project.id)};
    var iframe = document.getElementById('project');
    function projectSrc() {
      return '/p/' + encodeURIComponent(projectId) + '/?hub_frame=1&reload=' + Date.now();
    }
    document.getElementById('reload').addEventListener('click', function () {
      iframe.src = projectSrc();
    });
    document.getElementById('project-switcher').addEventListener('change', function (event) {
      window.location.href = '/view/' + encodeURIComponent(event.target.value) + '/';
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] ?? char));
}
