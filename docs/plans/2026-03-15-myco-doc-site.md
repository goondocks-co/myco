# Myco Doc Site Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-page branded landing site at myco.sh, served via GitHub Pages from the `docs/` directory.

**Architecture:** One `index.html` file with inline CSS and ~15 lines of vanilla JS for tab switching. Assets copied from repo root. GitHub Pages serves from `docs/` on main branch with a CNAME for the custom domain.

**Tech Stack:** HTML, CSS, vanilla JavaScript, GitHub Pages

**Spec:** `docs/specs/2026-03-15-myco-doc-site-design.md`

---

## File Structure

```
docs/
  index.html          — single-page branded site (all CSS/JS inline)
  CNAME               — custom domain file containing "myco.sh"
  assets/
    logo-mark.svg     — copied from repo assets/
    hero.svg          — copied from repo assets/ (for Open Graph)
    favicon.svg       — copied from repo assets/
```

## Chunk 1: Doc Site

### Task 1: Set up docs directory structure

**Files:**
- Create: `docs/CNAME`
- Create: `docs/assets/logo-mark.svg` (copy)
- Create: `docs/assets/hero.svg` (copy)
- Create: `docs/assets/favicon.svg` (copy)

- [ ] **Step 1: Create CNAME file**

```
myco.sh
```

Write this single line (no trailing newline needed) to `docs/CNAME`.

- [ ] **Step 2: Copy assets into docs/assets/**

```bash
mkdir -p docs/assets
cp assets/logo-mark.svg docs/assets/logo-mark.svg
cp assets/hero.svg docs/assets/hero.svg
cp assets/favicon.svg docs/assets/favicon.svg
```

- [ ] **Step 3: Verify files exist**

Run: `ls -la docs/CNAME docs/assets/`
Expected: CNAME file and 3 SVG files present

- [ ] **Step 4: Commit**

```bash
git add docs/CNAME docs/assets/
git commit -m "feat: add GitHub Pages structure — CNAME and brand assets"
```

---

### Task 2: Build index.html

**Files:**
- Create: `docs/index.html`

This is the main deliverable — a complete single-page site with all CSS and JS inline. The GitHub repo URL is `https://github.com/goondocks-co/myco`.

- [ ] **Step 1: Write docs/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Myco — The connected intelligence layer for agents and AI-assisted teams</title>
  <meta name="description" content="Capture agent sessions, build an intelligence graph, search it with MCP tools.">

  <!-- Open Graph -->
  <meta property="og:title" content="Myco — The connected intelligence layer">
  <meta property="og:description" content="Capture agent sessions, build an intelligence graph, search it with MCP tools.">
  <meta property="og:image" content="https://myco.sh/assets/hero.svg">
  <meta property="og:url" content="https://myco.sh">
  <meta name="twitter:card" content="summary_large_image">

  <!-- Favicon -->
  <link rel="icon" type="image/svg+xml" href="assets/favicon.svg">

  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;700&display=swap" rel="stylesheet">

  <style>
    /* Reset */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    /* Color tokens */
    :root {
      --base-black: #0a0f0a;
      --base-deep: #0d1f17;
      --base-mid: #132a1e;
      --accent-primary: #22c55e;
      --accent-light: #4ade80;
      --accent-muted: #86efac;
      --text-primary: #e2e8f0;
      --text-secondary: #9ca3af;
    }

    html { scroll-behavior: smooth; }

    body {
      background: var(--base-black);
      color: var(--text-primary);
      font-family: -apple-system, system-ui, sans-serif;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    /* Nav */
    .nav {
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      background: rgba(10, 15, 10, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--base-mid);
    }

    .nav-logo {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
    }

    .nav-logo svg { width: 28px; height: 28px; }

    .nav-logo span {
      font-family: 'Geist Mono', monospace;
      font-size: 20px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -1px;
    }

    .nav-links {
      display: flex;
      gap: 24px;
      align-items: center;
    }

    .nav-links a {
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 14px;
      transition: color 0.2s;
    }

    .nav-links a:hover { color: var(--accent-light); }

    /* Hero */
    .hero {
      text-align: center;
      padding: 100px 24px 80px;
      position: relative;
      overflow: hidden;
    }

    .hero::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 600px;
      height: 600px;
      background: radial-gradient(circle, var(--base-deep) 0%, transparent 70%);
      pointer-events: none;
    }

    .hero-logo { width: 88px; height: 88px; position: relative; }

    .hero h1 {
      font-family: 'Geist Mono', monospace;
      font-size: 48px;
      font-weight: 700;
      letter-spacing: -2px;
      margin-top: 20px;
      position: relative;
    }

    .hero .tagline {
      color: var(--accent-muted);
      font-size: 18px;
      margin-top: 12px;
      position: relative;
    }

    .hero-ctas {
      display: flex;
      gap: 16px;
      justify-content: center;
      margin-top: 32px;
      position: relative;
    }

    .btn {
      display: inline-block;
      padding: 12px 28px;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      text-decoration: none;
      transition: opacity 0.2s;
    }

    .btn:hover { opacity: 0.85; }

    .btn-primary {
      background: var(--accent-primary);
      color: var(--base-black);
    }

    .btn-outline {
      border: 1px solid var(--accent-primary);
      color: var(--accent-primary);
    }

    /* Install */
    .install {
      max-width: 720px;
      margin: 0 auto;
      padding: 80px 24px;
    }

    .install h2 {
      text-align: center;
      font-size: 28px;
      margin-bottom: 32px;
    }

    .tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--base-mid);
      margin-bottom: 24px;
    }

    .tab {
      padding: 10px 20px;
      font-size: 14px;
      color: var(--text-secondary);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 0.2s, border-color 0.2s;
      background: none;
      border-top: none;
      border-left: none;
      border-right: none;
      font-family: inherit;
    }

    .tab:hover { color: var(--accent-light); }

    .tab.active {
      color: var(--accent-primary);
      border-bottom-color: var(--accent-primary);
    }

    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    .code-block {
      background: var(--base-deep);
      border: 1px solid var(--base-mid);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 16px;
      overflow-x: auto;
    }

    .code-block code {
      font-family: 'Geist Mono', monospace;
      font-size: 14px;
      color: var(--accent-muted);
      line-height: 1.7;
    }

    .code-block .comment { color: var(--text-secondary); }

    .install-note {
      color: var(--text-secondary);
      font-size: 14px;
      margin-top: 8px;
    }

    /* Features */
    .features {
      max-width: 960px;
      margin: 0 auto;
      padding: 40px 24px 80px;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
    }

    .feature-card {
      background: var(--base-deep);
      border: 1px solid var(--base-mid);
      border-radius: 12px;
      padding: 28px;
    }

    .feature-card .icon {
      width: 10px;
      height: 10px;
      background: var(--accent-primary);
      border-radius: 50%;
      margin-bottom: 16px;
    }

    .feature-card h3 {
      font-size: 18px;
      margin-bottom: 8px;
    }

    .feature-card p {
      color: var(--text-secondary);
      font-size: 14px;
      line-height: 1.6;
    }

    /* Footer */
    .footer {
      text-align: center;
      padding: 48px 24px;
      border-top: 1px solid var(--base-mid);
    }

    .footer-links {
      display: flex;
      gap: 24px;
      justify-content: center;
      margin-bottom: 16px;
    }

    .footer-links a {
      color: var(--accent-muted);
      text-decoration: none;
      font-size: 14px;
      transition: color 0.2s;
    }

    .footer-links a:hover { color: var(--accent-light); }

    .footer .origin {
      color: var(--text-secondary);
      font-size: 13px;
      font-style: italic;
    }

    /* Mobile */
    @media (max-width: 768px) {
      .nav-links .quick-start-link { display: none; }

      .hero { padding: 60px 24px 50px; }
      .hero h1 { font-size: 36px; }
      .hero .tagline { font-size: 16px; }
      .hero-ctas { flex-direction: column; align-items: center; }
      .hero-logo { width: 64px; height: 64px; }

      .features { grid-template-columns: 1fr; }

      .code-block { font-size: 13px; }
    }
  </style>
</head>
<body>

  <!-- Nav -->
  <nav class="nav">
    <a href="/" class="nav-logo">
      <svg viewBox="0 0 160 160" fill="none">
        <g stroke-linecap="round" stroke-linejoin="round">
          <path d="M30,130 L30,40 L80,85 L130,40 L130,130" stroke="#22c55e" stroke-width="8" opacity="0.85"/>
          <circle cx="30" cy="130" r="7" fill="#22c55e" opacity="0.9"/>
          <circle cx="30" cy="40" r="7" fill="#4ade80" opacity="0.8"/>
          <circle cx="80" cy="85" r="8" fill="#22c55e" opacity="0.95"/>
          <circle cx="130" cy="40" r="7" fill="#4ade80" opacity="0.8"/>
          <circle cx="130" cy="130" r="7" fill="#22c55e" opacity="0.9"/>
        </g>
      </svg>
      <span>myco</span>
    </a>
    <div class="nav-links">
      <a href="#install" class="quick-start-link">Quick Start</a>
      <a href="https://github.com/goondocks-co/myco" target="_blank" rel="noopener">GitHub</a>
    </div>
  </nav>

  <!-- Hero -->
  <section class="hero">
    <svg class="hero-logo" viewBox="0 0 160 160" fill="none">
      <g stroke-linecap="round" stroke-linejoin="round">
        <path d="M30,130 L30,40 L80,85 L130,40 L130,130" stroke="#22c55e" stroke-width="8" opacity="0.85"/>
        <circle cx="30" cy="130" r="7" fill="#22c55e" opacity="0.9"/>
        <circle cx="30" cy="40" r="7" fill="#4ade80" opacity="0.8"/>
        <circle cx="80" cy="85" r="8" fill="#22c55e" opacity="0.95"/>
        <circle cx="130" cy="40" r="7" fill="#4ade80" opacity="0.8"/>
        <circle cx="130" cy="130" r="7" fill="#22c55e" opacity="0.9"/>
        <line x1="30" y1="85" x2="80" y2="85" stroke="#4ade80" stroke-width="2" opacity="0.2"/>
        <line x1="80" y1="85" x2="130" y2="85" stroke="#4ade80" stroke-width="2" opacity="0.2"/>
        <circle cx="30" cy="85" r="4" fill="#86efac" opacity="0.35"/>
        <circle cx="130" cy="85" r="4" fill="#86efac" opacity="0.35"/>
      </g>
    </svg>
    <h1>myco</h1>
    <p class="tagline">The connected intelligence layer for agents and AI-assisted teams</p>
    <div class="hero-ctas">
      <a href="#install" class="btn btn-primary">Get Started</a>
      <a href="https://github.com/goondocks-co/myco" target="_blank" rel="noopener" class="btn btn-outline">View on GitHub</a>
    </div>
  </section>

  <!-- Install -->
  <section class="install" id="install">
    <h2>Get Started</h2>
    <div class="tabs">
      <button class="tab active" data-tab="claude-code">Claude Code</button>
      <button class="tab" data-tab="cursor">Cursor</button>
      <button class="tab" data-tab="vscode">VS Code</button>
    </div>

    <div class="tab-panel active" id="panel-claude-code">
      <div class="code-block"><code><span class="comment"># From the Goondocks marketplace</span>
claude plugin marketplace add goondocks-co/myco
claude plugin install myco@goondocks-plugins

<span class="comment"># Or install directly from the repo</span>
claude plugin add goondocks-co/myco</code></div>
      <p class="install-note">Then initialize in your project:</p>
      <div class="code-block"><code>/myco:init</code></div>
    </div>

    <div class="tab-panel" id="panel-cursor">
      <div class="code-block"><code>Settings → Extensions → Marketplace → Search "myco" → Install</code></div>
      <p class="install-note">Then initialize in your project:</p>
      <div class="code-block"><code>/myco:init</code></div>
    </div>

    <div class="tab-panel" id="panel-vscode">
      <div class="code-block"><code>1. Press Ctrl+Shift+X (or Cmd+Shift+X on macOS)
2. Type @agentPlugins myco in the search box
3. Click Install</code></div>
      <p class="install-note">Then initialize in your project:</p>
      <div class="code-block"><code>/myco:init</code></div>
    </div>
  </section>

  <!-- Features -->
  <section class="features">
    <div class="feature-card">
      <div class="icon"></div>
      <h3>Capture</h3>
      <p>Plugin hooks record prompts and responses. A background daemon detects plans, specs, and decisions — extracting them as first-class vault entries.</p>
    </div>
    <div class="feature-card">
      <div class="icon"></div>
      <h3>Connect</h3>
      <p>Obsidian backlinks create a navigable intelligence graph. Sessions link to plans, plans link to decisions, decisions link to memories. Browse it visually or let agents traverse it.</p>
    </div>
    <div class="feature-card">
      <div class="icon"></div>
      <h3>Search</h3>
      <p>Vector embeddings enable semantic search. Agents find conceptually related context via MCP tools — not keyword matching, real understanding. The index rebuilds from Markdown source of truth.</p>
    </div>
  </section>

  <!-- Footer -->
  <footer class="footer">
    <div class="footer-links">
      <a href="https://github.com/goondocks-co/myco" target="_blank" rel="noopener">GitHub</a>
      <a href="https://github.com/goondocks-co/myco/blob/main/docs/quickstart.md" target="_blank" rel="noopener">Quick Start</a>
      <a href="https://github.com/goondocks-co/myco/blob/main/LICENSE" target="_blank" rel="noopener">MIT License</a>
    </div>
    <p class="origin">Named after mycorrhizal networks — the underground systems that connect trees in a forest.</p>
  </footer>

  <!-- Tab switching -->
  <script>
    document.querySelectorAll('.tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
        tab.classList.add('active');
        document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
      });
    });
  </script>

</body>
</html>
```

- [ ] **Step 2: Validate HTML structure**

Run: `grep -c '<section' docs/index.html`
Expected: 3 (hero, install, features)

Run: `grep -c 'tab-panel' docs/index.html`
Expected: 6 (3 div definitions + 3 id references in JS)

Run: `grep 'myco.sh' docs/index.html`
Expected: matches in og:url and og:image

- [ ] **Step 3: Verify favicon reference**

Run: `grep 'favicon.svg' docs/index.html`
Expected: matches the `<link rel="icon">` tag

- [ ] **Step 4: Verify all three install panels have /myco:init**

Run: `grep -c 'myco:init' docs/index.html`
Expected: 3 (one per platform panel)

- [ ] **Step 5: Commit**

```bash
git add docs/index.html
git commit -m "feat: add branded landing page — myco.sh single-page site"
```

---

### Task 3: Verify site structure

**Files:** None (verification only)

- [ ] **Step 1: Verify all required files exist**

Run: `ls -la docs/index.html docs/CNAME docs/assets/logo-mark.svg docs/assets/hero.svg docs/assets/favicon.svg`
Expected: All 5 files present

- [ ] **Step 2: Verify HTML contains all required sections**

Run: `grep -c '<section' docs/index.html && grep -c '<nav' docs/index.html && grep -c '<footer' docs/index.html`
Expected: 3 sections, 1 nav, 1 footer

- [ ] **Step 3: Verify CNAME content**

Run: `cat docs/CNAME`
Expected: `myco.sh`

- [ ] **Step 4: (Human) Visual verification**

This step requires a human. Serve locally and check in a browser:

```bash
python3 -m http.server 8080 --directory docs
```

Open `http://localhost:8080` and verify:
- Nav, hero, tabbed install, features, footer all render correctly
- Tab switching works
- Mobile responsive at <768px
- Favicon appears in browser tab

**Post-implementation:** Enable GitHub Pages in repo settings (source = `docs/` folder on `main` branch) and configure DNS for `myco.sh`.
