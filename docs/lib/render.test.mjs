// docs/lib/render.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './render.mjs';

test('renders headings with anchor ids', async () => {
  const html = await renderMarkdown('## Install Steps\n\nText.');
  assert.match(html, /<h2[^>]*id="install-steps"/);
});

test('renders GFM tables', async () => {
  const html = await renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<table>/);
});

test('highlights fenced code (Shiki emits a styled pre)', async () => {
  const html = await renderMarkdown('```bash\nmyco doctor\n```');
  assert.match(html, /<pre[^>]*class="[^"]*shiki/);
});

test('does not auto-link bare filenames like CLAUDE.md', async () => {
  const html = await renderMarkdown('See CLAUDE.md and SKILL.md for the rules.');
  assert.doesNotMatch(html, /href="http:\/\/CLAUDE\.md"/);
  assert.doesNotMatch(html, /href="http:\/\/SKILL\.md"/);
});

test('still auto-links explicit http(s) URLs in prose', async () => {
  const html = await renderMarkdown('Visit https://example.com for more.');
  assert.match(html, /<a href="https:\/\/example\.com"/);
});
