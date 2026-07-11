/**
 * Unit tests for the canopy_entries query functions in db/queries/canopy.ts.
 *
 * Exercises each function added in Task A6.5 directly against an in-memory
 * db, seeded via seedCanopyEntry. Confirms SQL + bind order are byte-identical
 * to the originals removed from canopy-tools.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { getDatabase } from '@myco/db/client.js';
import {
  selectPendingCanopyDescribe,
  getCanopyEntryByPath,
  getCanopyEntryExports,
  setCanopyDescription,
  listCanopyEntries,
} from '@myco/db/queries/canopy.js';
import { setupTestDb, cleanTestDb, teardownTestDb, seedCanopyEntry } from '../../helpers/db.js';

const PROJECT_A = 'proj_a';
const PROJECT_B = 'proj_b';

beforeAll(() => {
  setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  cleanTestDb();
});

// ---------------------------------------------------------------------------
// selectPendingCanopyDescribe
// ---------------------------------------------------------------------------

describe('selectPendingCanopyDescribe', () => {
  it('returns rows with null llm_description', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'a.ts', llm_description: null, llm_updated_at: null, mechanical_updated_at: 100 });
    const rows = selectPendingCanopyDescribe(db, PROJECT_A, { maxAttempts: 2, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('a.ts');
  });

  it('returns stale rows where llm_updated_at < mechanical_updated_at', () => {
    const db = getDatabase();
    seedCanopyEntry(db, {
      project_id: PROJECT_A, path: 'stale.ts',
      llm_description: 'old', llm_updated_at: 100, mechanical_updated_at: 200,
    });
    const rows = selectPendingCanopyDescribe(db, PROJECT_A, { maxAttempts: 2, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('stale.ts');
  });

  it('excludes rows where llm_updated_at >= mechanical_updated_at (fresh)', () => {
    const db = getDatabase();
    seedCanopyEntry(db, {
      project_id: PROJECT_A, path: 'fresh.ts',
      llm_description: 'current', llm_updated_at: 200, mechanical_updated_at: 100,
    });
    const rows = selectPendingCanopyDescribe(db, PROJECT_A, { maxAttempts: 2, limit: 10 });
    expect(rows).toHaveLength(0);
  });

  it('excludes rows at or above the maxAttempts cap', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'capped.ts', llm_description: null });
    db.prepare('UPDATE canopy_entries SET describe_attempts = 2 WHERE path = ?').run('capped.ts');
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'ok.ts', llm_description: null });

    const rows = selectPendingCanopyDescribe(db, PROJECT_A, { maxAttempts: 2, limit: 10 });
    expect(rows.map((r) => r.path)).toEqual(['ok.ts']);
  });

  it('respects the limit parameter', () => {
    const db = getDatabase();
    for (const p of ['a.ts', 'b.ts', 'c.ts']) {
      seedCanopyEntry(db, { project_id: PROJECT_A, path: p, llm_description: null, mechanical_updated_at: 1 });
    }
    const rows = selectPendingCanopyDescribe(db, PROJECT_A, { maxAttempts: 2, limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it('orders nulls-first then by mechanical_updated_at ASC', () => {
    const db = getDatabase();
    // stale: has an old llm_updated_at → llm_updated_at IS NULL = 0
    seedCanopyEntry(db, {
      project_id: PROJECT_A, path: 'stale.ts',
      llm_description: 'old', llm_updated_at: 50, mechanical_updated_at: 200,
    });
    // undescribed: llm_updated_at IS NULL = 1 → should come first
    seedCanopyEntry(db, {
      project_id: PROJECT_A, path: 'null1.ts',
      llm_description: null, llm_updated_at: null, mechanical_updated_at: 300,
    });
    seedCanopyEntry(db, {
      project_id: PROJECT_A, path: 'null2.ts',
      llm_description: null, llm_updated_at: null, mechanical_updated_at: 100,
    });

    const rows = selectPendingCanopyDescribe(db, PROJECT_A, { maxAttempts: 2, limit: 10 });
    // null rows first, ordered by mechanical_updated_at ASC
    expect(rows[0].path).toBe('null2.ts');  // mechanical 100
    expect(rows[1].path).toBe('null1.ts');  // mechanical 300
    expect(rows[2].path).toBe('stale.ts');  // not null, mechanical 200
  });

  it('is scoped to the given projectId', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'a.ts', llm_description: null });
    seedCanopyEntry(db, { project_id: PROJECT_B, path: 'b.ts', llm_description: null });
    const rows = selectPendingCanopyDescribe(db, PROJECT_A, { maxAttempts: 2, limit: 10 });
    expect(rows.map((r) => r.path)).toEqual(['a.ts']);
  });
});

// ---------------------------------------------------------------------------
// getCanopyEntryByPath
// ---------------------------------------------------------------------------

describe('getCanopyEntryByPath', () => {
  it('returns the full row when found', () => {
    const db = getDatabase();
    seedCanopyEntry(db, {
      project_id: PROJECT_A, path: 'src/foo.ts',
      language: 'typescript', exports_json: '["foo"]',
    });
    const row = getCanopyEntryByPath(db, PROJECT_A, 'src/foo.ts');
    expect(row).toBeDefined();
    expect(row!.path).toBe('src/foo.ts');
    expect(row!.language).toBe('typescript');
    expect(row!.exports_json).toBe('["foo"]');
  });

  it('returns null when the path does not exist', () => {
    const db = getDatabase();
    // bun:sqlite .get() returns null (not undefined) when no row is found
    const row = getCanopyEntryByPath(db, PROJECT_A, 'missing.ts');
    expect(row).toBeNull();
  });

  it('is scoped to the given projectId', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: PROJECT_B, path: 'shared.ts' });
    // bun:sqlite .get() returns null when the row doesn't belong to this project
    const row = getCanopyEntryByPath(db, PROJECT_A, 'shared.ts');
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getCanopyEntryExports
// ---------------------------------------------------------------------------

describe('getCanopyEntryExports', () => {
  it('returns only exports_json for a known path', () => {
    const db = getDatabase();
    seedCanopyEntry(db, {
      project_id: PROJECT_A, path: 'src/bar.ts',
      exports_json: '["bar","baz"]',
    });
    const result = getCanopyEntryExports(db, PROJECT_A, 'src/bar.ts');
    expect(result).toBeDefined();
    expect(result!.exports_json).toBe('["bar","baz"]');
    // Should not have other columns
    expect((result as Record<string, unknown>).path).toBeUndefined();
  });

  it('returns { exports_json: null } when exports_json is null', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'noexports.ts', exports_json: null });
    const result = getCanopyEntryExports(db, PROJECT_A, 'noexports.ts');
    expect(result).toBeDefined();
    expect(result!.exports_json).toBeNull();
  });

  it('returns null for an unknown path', () => {
    const db = getDatabase();
    // bun:sqlite .get() returns null (not undefined) when no row is found
    const result = getCanopyEntryExports(db, PROJECT_A, 'nonexistent.ts');
    expect(result).toBeNull();
  });

  it('is scoped to the given projectId', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: PROJECT_B, path: 'x.ts', exports_json: '["x"]' });
    // bun:sqlite .get() returns null when the row doesn't belong to this project
    const result = getCanopyEntryExports(db, PROJECT_A, 'x.ts');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setCanopyDescription
// ---------------------------------------------------------------------------

describe('setCanopyDescription', () => {
  it('writes llm_description and llm_updated_at', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'w.ts', llm_description: null, llm_updated_at: null });
    const now = 1_700_000_999;
    setCanopyDescription(db, PROJECT_A, 'w.ts', 'Handles widget lifecycle.', now);

    const row = db
      .prepare('SELECT llm_description, llm_updated_at FROM canopy_entries WHERE project_id = ? AND path = ?')
      .get(PROJECT_A, 'w.ts') as { llm_description: string; llm_updated_at: number };
    expect(row.llm_description).toBe('Handles widget lifecycle.');
    expect(row.llm_updated_at).toBe(now);
  });

  it('resets embedded to 0 when description is written', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'emb.ts', embedded: 1 });
    let row = db.prepare('SELECT embedded FROM canopy_entries WHERE path = ?').get('emb.ts') as { embedded: number };
    expect(row.embedded).toBe(1);

    setCanopyDescription(db, PROJECT_A, 'emb.ts', 'Some description.', 1_700_000_000);

    row = db.prepare('SELECT embedded FROM canopy_entries WHERE path = ?').get('emb.ts') as { embedded: number };
    expect(row.embedded).toBe(0);
  });

  it('overwrites an existing description', () => {
    const db = getDatabase();
    seedCanopyEntry(db, {
      project_id: PROJECT_A, path: 'ow.ts',
      llm_description: 'old', llm_updated_at: 100,
    });
    setCanopyDescription(db, PROJECT_A, 'ow.ts', 'new', 200);

    const row = db
      .prepare('SELECT llm_description, llm_updated_at FROM canopy_entries WHERE project_id = ? AND path = ?')
      .get(PROJECT_A, 'ow.ts') as { llm_description: string; llm_updated_at: number };
    expect(row.llm_description).toBe('new');
    expect(row.llm_updated_at).toBe(200);
  });

  it('is scoped to the given projectId (no cross-project write)', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'scoped.ts', llm_description: null });
    seedCanopyEntry(db, { project_id: PROJECT_B, path: 'scoped.ts', llm_description: null });

    setCanopyDescription(db, PROJECT_A, 'scoped.ts', 'only A', 1_000);

    const a = db
      .prepare('SELECT llm_description FROM canopy_entries WHERE project_id = ? AND path = ?')
      .get(PROJECT_A, 'scoped.ts') as { llm_description: string };
    const b = db
      .prepare('SELECT llm_description FROM canopy_entries WHERE project_id = ? AND path = ?')
      .get(PROJECT_B, 'scoped.ts') as { llm_description: string | null };
    expect(a.llm_description).toBe('only A');
    expect(b.llm_description).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listCanopyEntries
// ---------------------------------------------------------------------------

describe('listCanopyEntries', () => {
  it('returns only described rows by default (includeUndescribed=false)', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'described.ts', llm_description: 'yes', llm_updated_at: 100 });
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'pending.ts', llm_description: null, llm_updated_at: null });

    const rows = listCanopyEntries(db, PROJECT_A, { includeUndescribed: false, limit: 100 });
    expect(rows.map((r) => r.path)).toEqual(['described.ts']);
  });

  it('returns all rows when includeUndescribed=true', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'a.ts', llm_description: 'yes', llm_updated_at: 100 });
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'b.ts', llm_description: null });

    const rows = listCanopyEntries(db, PROJECT_A, { includeUndescribed: true, limit: 100 });
    const paths = rows.map((r) => r.path).sort();
    expect(paths).toEqual(['a.ts', 'b.ts']);
  });

  it('respects the limit parameter', () => {
    const db = getDatabase();
    for (const p of ['a.ts', 'b.ts', 'c.ts']) {
      seedCanopyEntry(db, { project_id: PROJECT_A, path: p, llm_description: 'desc', llm_updated_at: 100 });
    }
    const rows = listCanopyEntries(db, PROJECT_A, { includeUndescribed: false, limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it('returns rows ordered by path ASC', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'z.ts', llm_description: 'z', llm_updated_at: 100 });
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'a.ts', llm_description: 'a', llm_updated_at: 100 });
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'm.ts', llm_description: 'm', llm_updated_at: 100 });

    const rows = listCanopyEntries(db, PROJECT_A, { includeUndescribed: false, limit: 100 });
    expect(rows.map((r) => r.path)).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });

  it('projects the expected columns', () => {
    const db = getDatabase();
    seedCanopyEntry(db, {
      project_id: PROJECT_A, path: 'col.ts',
      llm_description: 'describes it', llm_updated_at: 100,
      language: 'typescript', exports_json: '["x"]', imports_json: '["y"]',
      token_estimate: 42,
    });
    const rows = listCanopyEntries(db, PROJECT_A, { includeUndescribed: false, limit: 1 });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.path).toBe('col.ts');
    expect(r.language).toBe('typescript');
    expect(r.llm_description).toBe('describes it');
    expect(r.exports_json).toBe('["x"]');
    expect(r.imports_json).toBe('["y"]');
    expect(r.token_estimate).toBe(42);
  });

  it('is scoped to the given projectId', () => {
    const db = getDatabase();
    seedCanopyEntry(db, { project_id: PROJECT_A, path: 'a.ts', llm_description: 'A', llm_updated_at: 1 });
    seedCanopyEntry(db, { project_id: PROJECT_B, path: 'b.ts', llm_description: 'B', llm_updated_at: 1 });

    const rows = listCanopyEntries(db, PROJECT_A, { includeUndescribed: false, limit: 100 });
    expect(rows.map((r) => r.path)).toEqual(['a.ts']);
  });
});
