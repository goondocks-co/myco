// docs/lib/nav.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV, allSlugs } from './nav.mjs';

test('every guide has a slug and title', () => {
  for (const group of NAV) {
    assert.ok(group.group, 'group has a label');
    for (const item of group.items) {
      assert.match(item.slug, /^[a-z0-9/-]+$/, `valid slug: ${item.slug}`);
      assert.ok(item.title.length > 0, `title for ${item.slug}`);
    }
  }
});

test('allSlugs is flat, unique, and covers known guides', () => {
  const slugs = allSlugs();
  assert.equal(new Set(slugs).size, slugs.length, 'no duplicate slugs');
  for (const expected of ['quickstart', 'team-host', 'agent-teams', 'architecture/actors-and-boundaries']) {
    assert.ok(slugs.includes(expected), `includes ${expected}`);
  }
});
