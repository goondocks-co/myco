import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleMycoSearch } from '@myco/mcp/tools/search';
import { MycoIndex } from '@myco/index/sqlite';
import { initFts } from '@myco/index/fts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('myco_search', () => {
  let tmpDir: string;
  let index: MycoIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-search-'));
    index = new MycoIndex(path.join(tmpDir, 'index.db'));
    initFts(index);

    index.upsertNote({
      path: 'sessions/s1.md', type: 'session', id: 's1',
      title: 'Auth Middleware Refactor',
      content: 'Refactored JWT middleware to use RS256 rotating keys.',
      frontmatter: { type: 'session', id: 's1', user: 'chris' },
      created: '2026-03-12T09:00:00Z',
    });
    index.upsertNote({
      path: 'memories/m1.md', type: 'memory', id: 'm1',
      title: 'CORS Proxy Gotcha',
      content: 'The CORS proxy strips auth headers silently.',
      frontmatter: { type: 'memory', id: 'm1', observation_type: 'gotcha' },
      created: '2026-03-12T10:00:00Z',
    });
  });

  afterEach(() => {
    index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('searches across all types', async () => {
    const results = await handleMycoSearch(index, { query: 'auth' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by type', async () => {
    const results = await handleMycoSearch(index, { query: 'auth', type: 'memory' });
    expect(results.every((r) => r.type === 'memory')).toBe(true);
  });

  it('respects limit', async () => {
    const results = await handleMycoSearch(index, { query: 'auth OR CORS', limit: 1 });
    expect(results).toHaveLength(1);
  });
});
