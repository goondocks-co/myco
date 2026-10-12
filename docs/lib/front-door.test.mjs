import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { allSlugs } from './nav.mjs';
import { renderMarkdown } from './render.mjs';
import { rewriteHtmlLinks } from './links.mjs';

const homepage = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const llms = fs.readFileSync(new URL('../llms.txt', import.meta.url), 'utf8');

test('homepage links and guide cards resolve to published pages or its own sections', () => {
  const slugs = allSlugs();
  const ids = new Set([...homepage.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const links = [...homepage.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  for (const href of links.filter((href) => href.startsWith('/') || href.startsWith('#'))) {
    const [page, anchor] = href.split('#');
    if (page && page !== '/') assert.ok(slugs.includes(page.slice(1)), `published target: ${href}`);
    else if (anchor) assert.ok(ids.has(anchor), `homepage section: ${href}`);
  }
  for (const slug of slugs) assert.ok(links.includes(`/${slug}`), `guide card: ${slug}`);
});

test('the LLM index covers every published guide', () => {
  const indexed = [...llms.matchAll(/https:\/\/myco\.sh\/([^)\s]+)\.md(?:#[^)]*)?/g)].map((match) => match[1]);
  assert.deepEqual(indexed.sort(), allSlugs().sort());
});

test('the installer migration anchor survives rendering', async () => {
  const upgrade = fs.readFileSync(new URL('../upgrade.md', import.meta.url), 'utf8');
  assert.match(upgrade, /^## Moving from Myco 1\.4$/m);
  assert.match(await renderMarkdown(upgrade), /id="upgrading-from-myco-14"/);
});

test('Deployment, runner and update guide links reach rendered anchors', async () => {
  const pages = new Map(await Promise.all(allSlugs().map(async (slug) => {
    const source = fs.readFileSync(new URL(`../${slug}.md`, import.meta.url), 'utf8');
    return [slug, rewriteHtmlLinks(await renderMarkdown(source), slug)];
  })));
  for (const slug of ['self-hosting', 'runners', 'upgrade']) {
    for (const [, href] of pages.get(slug).matchAll(/href="([^"]+)"/g)) {
      if (!href.startsWith('/') && !href.startsWith('#')) continue;
      const [page, anchor] = href.split('#');
      if (!anchor) continue;
      const target = pages.get(page ? page.slice(1) : slug);
      assert.ok(target, `${slug}: published target ${href}`);
      assert.ok([...target.matchAll(/id="([^"]+)"/g)].some(([, id]) => id === anchor), `${slug}: anchor ${href}`);
    }
  }
});
