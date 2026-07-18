// docs/lib/template.mjs
import { NAV } from './nav.mjs';

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

function sidebar(currentSlug) {
  return NAV.map(
    (group) => `
      <div class="ds-group">
        <div class="ds-group-label">${escText(group.group)}</div>
        ${group.items
          .map(
            (item) =>
              `<a class="ds-link${item.slug === currentSlug ? ' active' : ''}" href="/${item.slug}">${escText(item.title)}</a>`,
          )
          .join('\n        ')}
      </div>`,
  ).join('\n');
}

export function renderPage({ slug, title, description, bodyHtml }) {
  const canonical = `https://myco.sh/${slug}`;
  const rawMd = `/${slug}.md`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escText(title)} — Myco</title>
<meta name="description" content="${escAttr(description)}">
<link rel="canonical" href="${canonical}">
<link rel="alternate" type="text/markdown" href="${rawMd}" title="Markdown source">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Myco">
<meta property="og:title" content="${escAttr(title)} — Myco">
<meta property="og:description" content="${escAttr(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="https://myco.sh/assets/myco-hero-wide.jpg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escAttr(title)} — Myco">
<meta name="twitter:description" content="${escAttr(description)}">
<meta name="twitter:image" content="https://myco.sh/assets/myco-hero-wide.jpg">
<link rel="icon" type="image/svg+xml" href="/assets/favicon-sage.svg">
<link rel="stylesheet" href="/colors_and_type.css">
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/docs.css">
</head>
<body class="docs-body">
<nav class="nav">
  <div class="nav-inner">
    <a class="brand" href="/">
      <img class="brand-mark" src="/assets/logo-mark.svg" alt="Myco">
      <span class="brand-wm">myco</span>
      <span class="brand-tag" id="nav-version">loading…</span>
    </a>
    <div class="nav-links">
      <a href="/#how">How it works</a>
      <a href="/#lifecycle">Skills</a>
      <a href="/#cortex">Cortex</a>
      <a href="/#team">Team Host</a>
      <a href="/#agents">Agents</a>
      <a href="/#docs">Docs</a>
      <a href="/#sponsor">Sponsor</a>
    </div>
    <div class="nav-right">
      <a class="github-pill" href="https://github.com/goondocks-co/myco" target="_blank" rel="noopener">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
        github<span class="stars" id="gh-stars">★ —</span>
      </a>
      <a class="btn btn-primary" href="/#install">Get started<span class="chev">→</span></a>
    </div>
  </div>
</nav>

<div class="docs-shell">
  <aside class="docs-sidebar">
    <a class="ds-home" href="/#docs">← All docs</a>
    ${sidebar(slug)}
  </aside>
  <main class="docs-main">
    <nav class="docs-crumb" aria-label="Breadcrumb"><a href="/#docs">Docs</a> / <span>${escText(title)}</span></nav>
    <article class="docs-prose">
${bodyHtml}
    </article>
    <footer class="docs-page-foot">
      <a class="docs-raw" href="${rawMd}">View raw Markdown ↗</a>
      <a class="docs-edit" href="https://github.com/goondocks-co/myco/blob/main/docs/${slug}.md">Edit on GitHub ↗</a>
    </footer>
  </main>
</div>
<script>
  // Populate the nav version pill and GitHub star count (same source as the
  // homepage: npm dist-tags + the GitHub repo API). Best-effort, fails quiet.
  (function () {
    function setText(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; }
    function fmtStars(n) {
      if (n == null) return '★ —';
      if (n >= 1000) return '★ ' + (n / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
      return '★ ' + n;
    }
    fetch('https://registry.npmjs.org/@goondocks%2Fmyco')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var tags = data && data['dist-tags'];
        var v = tags && (tags.latest || tags.beta);
        if (!v) { setText('nav-version', 'beta'); return; }
        var isBeta = tags && !tags.latest && tags.beta;
        setText('nav-version', (isBeta ? 'beta · ' : '') + 'v' + v);
      })
      .catch(function () { setText('nav-version', 'beta'); });
    fetch('https://api.github.com/repos/goondocks-co/myco')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && typeof data.stargazers_count === 'number') setText('gh-stars', fmtStars(data.stargazers_count));
      })
      .catch(function () {});
  })();
</script>
</body>
</html>
`;
}
