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
