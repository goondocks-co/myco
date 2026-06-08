// docs/lib/links.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteLink, rewriteHtmlLinks } from './links.mjs';

test('same-dir .md link becomes a clean root URL', () => {
  assert.equal(rewriteLink('groves.md', 'quickstart'), '/groves');
});

test('preserves anchors', () => {
  assert.equal(rewriteLink('skills.md#configuring', 'agent-harness'), '/skills#configuring');
});

test('subdir target from a top-level page', () => {
  assert.equal(
    rewriteLink('architecture/actors-and-boundaries.md', 'agent-tools'),
    '/architecture/actors-and-boundaries',
  );
});

test('relative link from inside a subdir resolves to root', () => {
  assert.equal(rewriteLink('../agent-tools.md', 'architecture/actors-and-boundaries'), '/agent-tools');
});

test('outside-the-docs-tree .md becomes a GitHub blob URL', () => {
  assert.equal(
    rewriteLink('../../AGENTS.md#actors-and-boundaries', 'architecture/actors-and-boundaries'),
    'https://github.com/goondocks-co/myco/blob/main/AGENTS.md#actors-and-boundaries',
  );
});

test('external and anchor links pass through', () => {
  assert.equal(rewriteLink('https://example.com/x.md', 'quickstart'), 'https://example.com/x.md');
  assert.equal(rewriteLink('#section', 'quickstart'), '#section');
});

test('rewriteHtmlLinks updates only href attributes', () => {
  const html = '<p>See <a href="groves.md">Groves</a> and <a href="https://x.com">x</a>.</p>';
  assert.equal(
    rewriteHtmlLinks(html, 'quickstart'),
    '<p>See <a href="/groves">Groves</a> and <a href="https://x.com">x</a>.</p>',
  );
});
