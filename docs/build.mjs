// docs/build.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NAV, allSlugs } from './lib/nav.mjs';
import { extractTitle, extractDescription } from './lib/extract.mjs';
import { renderMarkdown } from './lib/render.mjs';
import { rewriteHtmlLinks } from './lib/links.mjs';
import { renderPage } from './lib/template.mjs';
import { render404 } from './lib/notfound.mjs';

const DOCS = import.meta.dirname;
const OUT = path.join(DOCS, '_site');

// Static files/dirs copied verbatim. sitemap.xml is generated, not copied.
const COPY = [
  'assets', 'fonts',
  'colors_and_type.css', 'site.css', 'docs.css',
  'index.html', 'install.sh', 'install.ps1',
  'CNAME', 'robots.txt', 'llms.txt',
];

async function copyInto(name) {
  const src = path.join(DOCS, name);
  const dest = path.join(OUT, name);
  await fs.cp(src, dest, { recursive: true });
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  for (const name of COPY) await copyInto(name);

  const slugs = allSlugs();
  const built = new Set(slugs.map((s) => `/${s}`));

  for (const slug of slugs) {
    const srcMd = path.join(DOCS, `${slug}.md`);
    let markdown;
    try {
      markdown = await fs.readFile(srcMd, 'utf8');
    } catch {
      throw new Error(`Missing source for manifest slug "${slug}": expected docs/${slug}.md`);
    }

    // Preserve the raw .md at its URL (LLM surface).
    const rawDest = path.join(OUT, `${slug}.md`);
    await fs.mkdir(path.dirname(rawDest), { recursive: true });
    await fs.copyFile(srcMd, rawDest);

    const title = extractTitle(markdown) ?? slug;
    const description = extractDescription(markdown);
    const body = rewriteHtmlLinks(await renderMarkdown(markdown), slug);

    // Verify internal doc links resolve to a built page.
    for (const href of internalDocLinks(body)) {
      if (!built.has(href)) {
        throw new Error(`Broken internal link in ${slug}.md: ${href} -> no such page`);
      }
    }

    const html = renderPage({ slug, title, description, bodyHtml: body });
    const htmlDest = path.join(OUT, `${slug}.html`);
    await fs.mkdir(path.dirname(htmlDest), { recursive: true });
    await fs.writeFile(htmlDest, html);
  }

  await fs.writeFile(path.join(OUT, '404.html'), render404());
  await fs.writeFile(path.join(OUT, 'sitemap.xml'), sitemap(slugs));

  await verifyOutputs(slugs);

  console.log(`Built ${slugs.length} guides + 404 + sitemap into ${OUT}`);
}

// Post-build guard: the rendered HTML link-check (in the loop) covers
// guide-to-guide links; this covers the LLM surface and the copied homepage.
async function verifyOutputs(slugs) {
  // 1. Raw .md (the LLM surface) survives for every guide.
  for (const slug of slugs) {
    try {
      await fs.access(path.join(OUT, `${slug}.md`));
    } catch {
      throw new Error(`Raw markdown missing from build output: ${slug}.md`);
    }
  }
  // 2. llms.txt is present and its myco.sh/*.md links still resolve.
  const llms = await fs.readFile(path.join(OUT, 'llms.txt'), 'utf8');
  for (const m of llms.matchAll(/https:\/\/myco\.sh\/([^)\s]+\.md)/g)) {
    try {
      await fs.access(path.join(OUT, m[1]));
    } catch {
      throw new Error(`llms.txt references a missing file: ${m[1]}`);
    }
  }
  // 3. The copied homepage has no leftover raw-markdown doc links (Task 11).
  // Only check non-external hrefs (skip https?:// links like FUNDING.md on GitHub).
  const index = await fs.readFile(path.join(OUT, 'index.html'), 'utf8');
  const leftover = [...index.matchAll(/href="(?!https?:\/\/)([^"]+\.md)"/g)].map((m) => m[1]);
  if (leftover.length) {
    throw new Error(`index.html still links to raw markdown: ${leftover.join(', ')}`);
  }
}

// Clean doc links produced by rewriteHtmlLinks look like href="/slug" or
// href="/slug#anchor" with no file extension. Ignore section anchors on the
// homepage (e.g. /#docs) and asset paths (which contain a dot).
function internalDocLinks(html) {
  const out = [];
  const re = /href="(\/[^"#]*)(#[^"]*)?"/g;
  let m;
  while ((m = re.exec(html))) {
    const p = m[1];
    if (p === '/' || p.includes('.')) continue; // homepage or asset
    out.push(p);
  }
  return out;
}

function sitemap(slugs) {
  const today = process.env.DOCS_BUILD_DATE || new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: 'https://myco.sh/', priority: '1.0' },
    ...slugs.map((s) => ({ loc: `https://myco.sh/${s}`, priority: '0.7' })),
    { loc: 'https://myco.sh/llms.txt', priority: '0.6' },
  ];
  const body = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <priority>${u.priority}</priority>\n  </url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
