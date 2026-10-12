import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { allSlugs } from './nav.mjs';
import { renderMarkdown } from './render.mjs';

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
  assert.match(upgrade, /^## Upgrading from Myco 1\.4$/m);
  assert.match(await renderMarkdown(upgrade), /id="upgrading-from-myco-14"/);
});
