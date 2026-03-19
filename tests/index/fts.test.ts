import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MycoIndex } from '@myco/index/sqlite';
import { initFts, searchFts } from '@myco/index/fts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('FTS5 Search', () => {
  let tmpDir: string;
  let index: MycoIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-fts-'));
    index = new MycoIndex(path.join(tmpDir, 'index.db'));
    initFts(index);

    index.upsertNote({
      path: 'sessions/s1.md', type: 'session', id: 's1', title: 'JWT Middleware Refactor',
      content: 'Refactored the JWT middleware to use rotating keys with RS256 algorithm.',
      frontmatter: { type: 'session' }, created: '2026-03-12T09:00:00Z',
    });
    index.upsertNote({
      path: 'spores/m1.md', type: 'spore', id: 'm1', title: 'CORS Proxy Gotcha',
      content: 'The CORS proxy strips auth headers. Must add X-Forwarded-Auth.',
      frontmatter: { type: 'spore' }, created: '2026-03-12T10:00:00Z',
    });
    index.upsertNote({
      path: 'plans/p1.md', type: 'plan', id: 'p1', title: 'Auth Redesign',
      content: 'Replace static JWT secret with rotating key pairs.',
      frontmatter: { type: 'plan' }, created: '2026-03-12T00:00:00Z',
    });
  });

  afterEach(() => {
    index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds notes by keyword', () => {
    const results = searchFts(index, 'JWT');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by type', () => {
    const results = searchFts(index, 'JWT', { type: 'session' });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('session');
  });

  it('returns snippets', () => {
    const results = searchFts(index, 'CORS');
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toContain('CORS');
  });

  it('returns empty for no matches', () => {
    const results = searchFts(index, 'xyznonexistent');
    expect(results).toEqual([]);
  });

  it('respects limit', () => {
    const results = searchFts(index, 'JWT OR CORS OR auth', { limit: 1 });
    expect(results).toHaveLength(1);
  });
});
