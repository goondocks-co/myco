export function renderHubHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Myco Hub</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f7f3;
      --fg: #20211f;
      --muted: #6b6f68;
      --line: #d8d8cf;
      --panel: #ffffff;
      --accent: #276f55;
      --bad: #9f2d20;
      --warn: #8b650f;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #171815;
        --fg: #edece5;
        --muted: #a4a69d;
        --line: #34362f;
        --panel: #20221d;
        --accent: #79c6a4;
        --bad: #ff8a7a;
        --warn: #d8b35f;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--fg);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 650;
      letter-spacing: 0;
    }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 24px;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    button, a.button {
      height: 32px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: transparent;
      color: var(--fg);
      padding: 0 10px;
      text-decoration: none;
      cursor: pointer;
      font: inherit;
    }
    button.primary, a.primary {
      border-color: var(--accent);
      color: var(--accent);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
    }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: middle;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      text-transform: uppercase;
    }
    tr:last-child td { border-bottom: 0; }
    .path {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      word-break: break-all;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--muted);
    }
    .running .dot { background: var(--accent); }
    .unhealthy .dot { background: var(--bad); }
    .starting .dot { background: var(--warn); }
    .actions {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .empty {
      border: 1px solid var(--line);
      background: var(--panel);
      padding: 32px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <header>
    <h1>Myco Hub</h1>
    <div class="toolbar">
      <button id="refresh">Refresh</button>
    </div>
  </header>
  <main>
    <div id="content"></div>
  </main>
  <script>
    async function api(path, init) {
      const res = await fetch(path, init);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    function statusCell(status) {
      return '<span class="status ' + status + '"><span class="dot"></span>' + status + '</span>';
    }

    async function action(id, verb) {
      await api('/api/projects/' + encodeURIComponent(id) + '/' + verb, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      await load();
    }

    async function load() {
      const content = document.getElementById('content');
      content.textContent = 'Loading...';
      const data = await api('/api/projects');
      if (!data.projects.length) {
        content.innerHTML = '<div class="empty">No Myco projects found. Add scan roots in ~/.myco/hub/config.json if your projects live outside the default locations.</div>';
        return;
      }
      content.innerHTML = '<table><thead><tr><th>Project</th><th>Status</th><th>Runtime</th><th></th></tr></thead><tbody>' +
        data.projects.map((project) => {
          const runtime = project.runtime;
          const open = '<a class="button primary" href="/p/' + encodeURIComponent(project.id) + '/">Open</a>';
          const start = '<button onclick="action(\\'' + project.id + '\\', \\'start\\')">Start</button>';
          const stop = '<button onclick="action(\\'' + project.id + '\\', \\'stop\\')">Stop</button>';
          const restart = '<button onclick="action(\\'' + project.id + '\\', \\'restart\\')">Restart</button>';
          const version = runtime.version ? 'v' + runtime.version : '';
          const port = runtime.port ? ':' + runtime.port : '';
          return '<tr>' +
            '<td><strong>' + project.name + '</strong><div class="path">' + project.projectRoot + '</div></td>' +
            '<td>' + statusCell(runtime.status) + '</td>' +
            '<td>' + [version, port].filter(Boolean).join(' ') + '</td>' +
            '<td><div class="actions">' + open + start + stop + restart + '</div></td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>';
    }

    document.getElementById('refresh').addEventListener('click', load);
    window.action = action;
    load().catch((err) => {
      document.getElementById('content').innerHTML = '<div class="empty">' + err.message + '</div>';
    });
  </script>
</body>
</html>`;
}
