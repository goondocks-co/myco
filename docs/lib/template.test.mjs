// docs/lib/template.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from './template.mjs';

const page = renderPage({
  slug: 'quickstart',
  title: 'Quickstart',
  description: 'Install Myco and go.',
  bodyHtml: '<h1 id="quickstart">Quickstart</h1><p>Body.</p>',
});

test('sets title and meta description', () => {
  assert.match(page, /<title>Quickstart — Myco<\/title>/);
  assert.match(page, /<meta name="description" content="Install Myco and go.">/);
});

test('sets canonical and raw-markdown alternate', () => {
  assert.match(page, /<link rel="canonical" href="https:\/\/myco\.sh\/quickstart">/);
  assert.match(page, /<link rel="alternate" type="text\/markdown" href="\/quickstart\.md"/);
});

test('renders the sidebar with all guides and marks the current page active', () => {
  assert.match(page, /href="\/team-host"/);
  assert.match(page, /class="ds-link active"[^>]*href="\/quickstart"/);
});

test('includes the full site nav (version pill + github pill)', () => {
  assert.match(page, /id="nav-version"/);
  assert.match(page, /class="github-pill"/);
  assert.match(page, /id="gh-stars"/);
});

test('includes a View raw Markdown link and the body', () => {
  assert.match(page, /href="\/quickstart\.md"[^>]*>View raw Markdown/);
  assert.match(page, /<p>Body\.<\/p>/);
});

test('escapes HTML special chars in title and sidebar text', () => {
  const p = renderPage({
    slug: 'quickstart',
    title: 'Search & <Recall>',
    description: 'Find & recall <stuff>.',
    bodyHtml: '<p>x</p>',
  });
  assert.match(p, /<title>Search &amp; &lt;Recall&gt; — Myco<\/title>/);
  assert.match(p, /<meta name="description" content="Find &amp; recall &lt;stuff&gt;.">/);
  // breadcrumb element-text
  assert.match(p, /<span>Search &amp; &lt;Recall&gt;<\/span>/);
});
