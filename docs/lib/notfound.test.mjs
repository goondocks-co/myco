// docs/lib/notfound.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render404 } from './notfound.mjs';

test('renders a themed 404 with links home and to docs', () => {
  const html = render404();
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /404/);
  assert.match(html, /href="\/"/);
  assert.match(html, /href="\/#docs"/);
});
