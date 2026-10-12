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
  for (const expected of ['quickstart', 'self-hosting', 'upgrade', 'dashboard', 'how-myco-learns', 'configuration', 'troubleshooting', 'agents', 'agent-tools', 'external-agents', 'architecture/actors-and-boundaries']) {
    assert.ok(slugs.includes(expected), `includes ${expected}`);
  }
});


test('uses the published user-doc groups and excludes retired pages', () => {
  assert.deepEqual(NAV.map((group) => group.group), ['Getting started', 'Using Myco', 'Reference']);
  for (const retired of ['team-host', 'groves', 'lifecycle', 'canopy', 'skills', 'agent-harness', 'symbionts', 'migrating-from-oak', 'agent-teams']) {
    assert.ok(!allSlugs().includes(retired), `excludes ${retired}`);
  }
});
