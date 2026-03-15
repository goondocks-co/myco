# Myco Doc Site — Design Spec

**Date:** 2026-03-15
**Status:** Draft
**Author:** Chris + Claude

## Overview

A single-page branded landing site for Myco, served at `myco.sh` via GitHub Pages. Static HTML + CSS + minimal vanilla JS. No build step, no framework. The page introduces Myco, provides tabbed install instructions for all three supported platforms, highlights key features, and drives visitors to the GitHub repo.

## Site Structure

```
docs/
  index.html          — single-page site
  CNAME               — contains "myco.sh"
  assets/
    logo-mark.svg     — copy of repo assets/logo-mark.svg
    hero.svg          — copy of repo assets/hero.svg
    favicon.svg       — copy of repo assets/favicon.svg
```

GitHub Pages serves from `docs/` on the `main` branch. No GitHub Actions workflow needed.

**Existing `docs/quickstart.md`** stays in the repo as a reference but is not served by Pages. Its content is folded into the HTML page.

## DNS & Deployment

- `CNAME` file in `docs/` contains `myco.sh`
- DNS: A records pointing to GitHub Pages IPs (`185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`), or a CNAME record pointing to `<user>.github.io`
- GitHub handles HTTPS automatically for custom domains
- Enable GitHub Pages in repo settings: source = `docs/` folder on `main` branch

## Page Layout

**Layout: Nav + Sections** — sticky top nav, hero, tabbed install, feature cards, footer.

### 1. Nav Bar (sticky)

- **Left:** Logo mark SVG (inline, small) + "myco" in Geist Mono Bold
- **Right:** Two links — "Quick Start" (anchor to `#install` section), "GitHub" (external link to repo, opens in new tab)
- Background: `base-black` (#0a0f0a) with subtle bottom border (#132a1e)
- Becomes slightly more opaque/blurred on scroll (CSS only, `backdrop-filter`)

### 2. Hero Section

- Centered layout, generous vertical padding
- Logo mark SVG rendered large (80-100px)
- "myco" wordmark below: Geist Mono Bold, ~48px, `text-primary`
- Tagline below: system sans-serif, ~18px, `accent-muted`
- Two CTA buttons side by side:
  - **"Get Started"** — solid `accent-primary` background, dark text, scrolls to `#install`
  - **"View on GitHub"** — outlined with `accent-primary` border, green text, links to repo
- Background: `base-black` with radial glow of `base-deep` behind the logo (same treatment as hero.svg)

### 3. Install Section (`#install`)

- Section heading: "Install" or "Get Started"
- **Tab bar:** Three tabs — "Claude Code" (default active), "Cursor", "VS Code"
  - Active tab: `accent-primary` text + bottom border
  - Inactive tabs: `text-secondary`, hover shows `accent-light`
- **Tab panels:** Each contains platform-specific install instructions in styled code blocks

**Claude Code panel** (default):
```bash
# From the Goondocks marketplace
claude plugin marketplace add goondocks-co/myco
claude plugin install myco@goondocks-plugins

# Or install directly from the repo
claude plugin add goondocks-co/myco
```

Then initialize:
```
/myco:init
```

**Cursor panel:**
```
Settings → Extensions → Marketplace → Search "myco" → Install
```

Then initialize:
```
/myco:init
```

**VS Code panel:**
1. Press `Ctrl+Shift+X` (or `Cmd+Shift+X` on macOS)
2. Type `@agentPlugins myco` in the search box
3. Click **Install**

Then initialize:
```
/myco:init
```

- Code blocks: `base-deep` background, `accent-muted` text, rounded corners, monospace font
- Each panel ends with the `/myco:init` command since it's common across platforms

### 4. Features Section

Three cards in a horizontal row (stacks vertically on mobile):

**Card 1: Capture**
- Icon/accent: a node symbol in `accent-primary`
- Title: "Capture"
- Body: "Plugin hooks record prompts and responses. A background daemon detects plans, specs, and decisions — extracting them as first-class vault entries."

**Card 2: Connect**
- Title: "Connect"
- Body: "Obsidian backlinks create a navigable intelligence graph. Sessions link to plans, plans link to decisions, decisions link to memories. Browse it visually or let agents traverse it."

**Card 3: Search**
- Title: "Search"
- Body: "Vector embeddings enable semantic search. Agents find conceptually related context via MCP tools — not keyword matching, real understanding. The index rebuilds from Markdown source of truth."

- Card background: `base-deep`
- Card border: subtle `base-mid` or 1px solid `#1a2a1e`
- Card border-radius: 12px

### 5. Footer

- Minimal, centered
- Links: GitHub (repo root) · Quick Start (`https://github.com/goondocks-co/myco/blob/main/docs/quickstart.md`) · MIT License
- Optional one-liner: "Named after mycorrhizal networks — the underground systems that connect trees in a forest."
- Text in `text-secondary`, links in `accent-muted`

## Styling

**All CSS in `<head>`** — no external stylesheet.

**Color tokens (from brand spec):**

| Token | Hex | Usage |
|-------|-----|-------|
| `base-black` | `#0a0f0a` | Page background, nav background |
| `base-deep` | `#0d1f17` | Card backgrounds, code blocks, surfaces |
| `base-mid` | `#132a1e` | Borders, subtle dividers |
| `accent-primary` | `#22c55e` | CTAs, active tabs, icons |
| `accent-light` | `#4ade80` | Hover states, secondary accents |
| `accent-muted` | `#86efac` | Tagline, code text, footer links |
| `text-primary` | `#e2e8f0` | Headings, body text |
| `text-secondary` | `#9ca3af` | Muted text, inactive tabs |

**Typography:**
- Wordmark + code: Geist Mono (loaded from Google Fonts, Bold 700 + Regular 400)
- Body + tagline: `-apple-system, system-ui, sans-serif`

**Responsive breakpoints:**
- Desktop (>768px): nav horizontal, feature cards in a row, hero large
- Mobile (≤768px): nav shows logo + GitHub link only (no hamburger — keeps JS minimal), feature cards stack vertically, hero scales down, code blocks scroll horizontally

## Interactivity

**Tab switching (~15 lines vanilla JS):**
```javascript
document.querySelectorAll('[data-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    // Remove active from all tabs and panels
    // Add active to clicked tab and corresponding panel
  });
});
```

**Smooth scroll for CTA:**
```html
<a href="#install" style="scroll-behavior: smooth;">Get Started</a>
```
Or set `scroll-behavior: smooth` on `html` in CSS.

No other JavaScript. No analytics, no tracking, no third-party scripts.

## Assets

Copy (not symlink) these files from the repo root `assets/` into `docs/assets/`:
- `logo-mark.svg`
- `hero.svg` (not used directly on the page, but available for Open Graph)
- `favicon.svg`

The favicon is referenced in `<head>`:
```html
<link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
```

**Open Graph meta tags** in `<head>` for social sharing:
```html
<meta property="og:title" content="Myco — The connected intelligence layer">
<meta property="og:description" content="Capture agent sessions, build an intelligence graph, search it with MCP tools.">
<meta property="og:image" content="https://myco.sh/assets/hero.svg">
<meta property="og:url" content="https://myco.sh">
<meta name="twitter:card" content="summary_large_image">
```

## What's NOT in scope

- Multiple pages — this is a single `index.html`
- Build step or static site generator
- Light mode toggle
- Blog, changelog, or documentation subpages
- Analytics or tracking scripts
- The `docs/quickstart.md` content beyond what's on the install tabs (full quickstart stays in repo)
