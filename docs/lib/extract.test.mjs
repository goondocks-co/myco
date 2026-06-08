// docs/lib/extract.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTitle, extractDescription } from './extract.mjs';

const SAMPLE = `# Quickstart

Install Myco, open the [dashboard](groves.md), and configure providers.

## 1. Install

Some later text.`;

test('extractTitle returns the first H1', () => {
  assert.equal(extractTitle(SAMPLE), 'Quickstart');
});

test('extractTitle returns null when no H1', () => {
  assert.equal(extractTitle('no heading here'), null);
});

test('extractDescription returns the first paragraph as plain text', () => {
  assert.equal(
    extractDescription(SAMPLE),
    'Install Myco, open the dashboard, and configure providers.',
  );
});

test('extractDescription skips headings, lists, quotes, and code', () => {
  const md = `# Title

> a blockquote

- a list item

The real description sentence.`;
  assert.equal(extractDescription(md), 'The real description sentence.');
});

test('extractDescription keeps bold-lead and inline-code-lead paragraphs', () => {
  // Real docs (skills.md, canopy.md) open with **bold**; platform-packages.md
  // opens with `inline code`. These must NOT be skipped as list/quote markers.
  assert.equal(
    extractDescription('# Title\n\n**Memory is table stakes.** It goes further.'),
    'Memory is table stakes. It goes further.',
  );
  assert.equal(
    extractDescription('# Title\n\n`@goondocks/myco` ships as a shell.'),
    '@goondocks/myco ships as a shell.',
  );
});
