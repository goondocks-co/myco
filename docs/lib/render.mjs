// docs/lib/render.mjs
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import Shiki from '@shikijs/markdown-it';

let mdPromise;

async function buildMd() {
  const md = MarkdownIt({ html: true, linkify: true, typographer: true });
  // Keep linkify: true so explicit https://... URLs stay clickable, but disable
  // fuzzy/schemeless matching so bare filenames like CLAUDE.md aren't auto-linked
  // (markdown-it's linkify treats .md, .sh, .ts, .io, etc. as valid TLDs).
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
  md.use(anchor, { tabIndex: false });
  // Single dark theme (the site is dark-only) → Shiki emits a self-contained
  // <pre class="shiki <theme>"> with inline colors, no extra theme-switch CSS.
  // 'vesper' is a warm, low-contrast dark theme that sits closer to the
  // sage/ochre/terracotta palette than the blue-tinted github-dark. Final
  // color choice is confirmed in the Task 12 screenshot pass.
  md.use(await Shiki({ theme: 'vesper' }));
  return md;
}

export async function renderMarkdown(markdown) {
  if (!mdPromise) mdPromise = buildMd();
  const md = await mdPromise;
  return md.render(markdown);
}
