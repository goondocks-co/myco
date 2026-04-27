/**
 * Tests for the /canopy/entries daemon HTTP handlers (list, detail, reembed).
 *
 * The handlers are pure functions over a plain args object so they can be
 * called directly without standing up the HTTP server. The route layer is a
 * thin shim that pulls `project_id` from the daemon context and forwards
 * query/path params verbatim.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb, seedCanopyEntry } from '../../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import {
  handleCanopyEntriesList,
  handleCanopyEntryGet,
  handleCanopyEntryReembed,
} from '@myco/daemon/api/canopy-read.js';

const PROJECT_ID = '/repo/myco';
const epochNow = () => Math.floor(Date.now() / 1000);

interface SeedOpts {
  path: string;
  language?: string | null;
  description?: string | null;
  embedded?: 0 | 1;
}

function seedEntry(opts: SeedOpts) {
  const now = epochNow();
  seedCanopyEntry(getDatabase(), {
    project_id: PROJECT_ID,
    path: opts.path,
    size_bytes: 0,
    token_estimate: 0,
    line_count: 0,
    language: opts.language ?? null,
    exports_json: '[]',
    imports_json: '[]',
    mechanical_updated_at: now,
    llm_description: opts.description ?? null,
    llm_updated_at: opts.description ? now : null,
    embedded: opts.embedded ?? 0,
  });
}

function seedTrio() {
  // a.ts: typescript, described, embedded=1
  seedEntry({ path: 'a.ts', language: 'typescript', description: 'describes a', embedded: 1 });
  // src/b.ts: typescript, no description, embedded=0
  seedEntry({ path: 'src/b.ts', language: 'typescript', embedded: 0 });
  // c.py: python, described, embedded=0
  seedEntry({ path: 'c.py', language: 'python', description: 'describes c', embedded: 0 });
}

describe('handleCanopyEntriesList', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('returns rows scoped to the project plus total/limit/offset', async () => {
    seedTrio();
    const res = await handleCanopyEntriesList({ project_id: PROJECT_ID });
    expect(res.total).toBe(3);
    expect(res.limit).toBe(50);
    expect(res.offset).toBe(0);
    expect(res.rows).toHaveLength(3);
    // Ordered by path ASC.
    expect((res.rows as Array<{ path: string }>).map(r => r.path))
      .toEqual(['a.ts', 'c.py', 'src/b.ts']);
  });

  it('paginates via limit/offset and reports the unpaginated total', async () => {
    seedTrio();
    const res = await handleCanopyEntriesList({ project_id: PROJECT_ID, limit: 1, offset: 1 });
    expect(res.total).toBe(3);
    expect(res.limit).toBe(1);
    expect(res.offset).toBe(1);
    expect(res.rows).toHaveLength(1);
    expect((res.rows as Array<{ path: string }>)[0].path).toBe('c.py');
  });

  it('filters by language', async () => {
    seedTrio();
    const res = await handleCanopyEntriesList({ project_id: PROJECT_ID, language: 'python' });
    expect(res.total).toBe(1);
    expect((res.rows as Array<{ path: string }>)[0].path).toBe('c.py');
  });

  it('filters by described=true', async () => {
    seedTrio();
    const res = await handleCanopyEntriesList({ project_id: PROJECT_ID, described: true });
    expect(res.total).toBe(2);
    expect((res.rows as Array<{ path: string }>).map(r => r.path)).toEqual(['a.ts', 'c.py']);
  });

  it('filters by described=false', async () => {
    seedTrio();
    const res = await handleCanopyEntriesList({ project_id: PROJECT_ID, described: false });
    expect(res.total).toBe(1);
    expect((res.rows as Array<{ path: string }>)[0].path).toBe('src/b.ts');
  });

  it('filters by embedded=true', async () => {
    seedTrio();
    const res = await handleCanopyEntriesList({ project_id: PROJECT_ID, embedded: true });
    expect(res.total).toBe(1);
    expect((res.rows as Array<{ path: string }>)[0].path).toBe('a.ts');
  });

  it('filters by embedded=false', async () => {
    seedTrio();
    const res = await handleCanopyEntriesList({ project_id: PROJECT_ID, embedded: false });
    expect(res.total).toBe(2);
    expect((res.rows as Array<{ path: string }>).map(r => r.path)).toEqual(['c.py', 'src/b.ts']);
  });

  it('filters by path_prefix', async () => {
    seedTrio();
    const res = await handleCanopyEntriesList({ project_id: PROJECT_ID, path_prefix: 'src/' });
    expect(res.total).toBe(1);
    expect((res.rows as Array<{ path: string }>)[0].path).toBe('src/b.ts');
  });

  it('does not leak rows from other projects', async () => {
    seedTrio();
    seedCanopyEntry(getDatabase(), {
      project_id: '/repo/other',
      path: 'a.ts',
      size_bytes: 0,
      token_estimate: 0,
      line_count: 0,
      language: 'typescript',
      exports_json: '[]',
      imports_json: '[]',
      mechanical_updated_at: epochNow(),
      embedded: 0,
    });
    const res = await handleCanopyEntriesList({ project_id: PROJECT_ID });
    expect(res.total).toBe(3);
  });
});

describe('handleCanopyEntryGet', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('returns the row for an existing path', async () => {
    seedTrio();
    const row = await handleCanopyEntryGet({ project_id: PROJECT_ID, path: 'a.ts' }) as Record<string, unknown>;
    expect(row.path).toBe('a.ts');
    expect(row.language).toBe('typescript');
    expect(row.embedded).toBe(1);
  });

  it('handles paths with subdirectories', async () => {
    seedTrio();
    const row = await handleCanopyEntryGet({ project_id: PROJECT_ID, path: 'src/b.ts' }) as Record<string, unknown>;
    expect(row.path).toBe('src/b.ts');
  });

  it('throws when the entry does not exist', async () => {
    seedTrio();
    await expect(
      handleCanopyEntryGet({ project_id: PROJECT_ID, path: 'missing.ts' }),
    ).rejects.toThrow(/not found/i);
  });

  it('does not return rows from other projects', async () => {
    seedTrio();
    await expect(
      handleCanopyEntryGet({ project_id: '/repo/other', path: 'a.ts' }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('handleCanopyEntryReembed', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('flips embedded to 0 for the targeted row and returns ok', async () => {
    seedTrio();
    const before = getDatabase()
      .prepare('SELECT embedded FROM canopy_entries WHERE project_id = ? AND path = ?')
      .get(PROJECT_ID, 'a.ts') as { embedded: number };
    expect(before.embedded).toBe(1);

    const res = await handleCanopyEntryReembed({ project_id: PROJECT_ID, path: 'a.ts' });
    expect(res).toEqual({ ok: true });

    const after = getDatabase()
      .prepare('SELECT embedded FROM canopy_entries WHERE project_id = ? AND path = ?')
      .get(PROJECT_ID, 'a.ts') as { embedded: number };
    expect(after.embedded).toBe(0);
  });

  it('throws when the entry does not exist', async () => {
    seedTrio();
    await expect(
      handleCanopyEntryReembed({ project_id: PROJECT_ID, path: 'missing.ts' }),
    ).rejects.toThrow(/not found/i);
  });

  it('does not modify rows in other projects', async () => {
    seedTrio();
    await expect(
      handleCanopyEntryReembed({ project_id: '/repo/other', path: 'a.ts' }),
    ).rejects.toThrow(/not found/i);
    const row = getDatabase()
      .prepare('SELECT embedded FROM canopy_entries WHERE project_id = ? AND path = ?')
      .get(PROJECT_ID, 'a.ts') as { embedded: number };
    expect(row.embedded).toBe(1);
  });
});
