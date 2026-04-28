import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { getDatabase } from '@myco/db/client.js';
import { SqliteRecordSource } from '@myco/daemon/embedding/record-source.js';
import { setupTestDb, cleanTestDb, teardownTestDb, seedCanopyEntry } from '../helpers/db.js';

function seedCanopy() {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const base = {
    project_id: 'proj',
    size_bytes: 100,
    token_estimate: 20,
    line_count: 5,
    language: 'typescript',
    mechanical_updated_at: now,
  } as const;
  seedCanopyEntry(db, { ...base, path: 'a.ts', content_hash: 'h1', llm_description: 'desc a', llm_updated_at: now, embedded: 0 });
  seedCanopyEntry(db, { ...base, path: 'b.ts', content_hash: 'h2', llm_description: 'desc b', llm_updated_at: now, embedded: 1 });
  seedCanopyEntry(db, { ...base, path: 'c.ts', content_hash: 'h3', llm_description: null,     llm_updated_at: null, embedded: 0 });
}

describe('SqliteRecordSource — canopy_entries', () => {
  let source: SqliteRecordSource;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    seedCanopy();
    source = new SqliteRecordSource();
  });

  it('getEmbeddableRows returns only rows with description and embedded=0', () => {
    const rows = source.getEmbeddableRows('canopy_entries', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'proj:a.ts',
      text: 'desc a',
      metadata: expect.objectContaining({ project_id: 'proj', path: 'a.ts', language: 'typescript' }),
    });
  });

  it('getActiveRecordIds returns described entries regardless of embedded state', () => {
    const ids = source.getActiveRecordIds('canopy_entries').sort();
    expect(ids).toEqual(['proj:a.ts', 'proj:b.ts']);
  });

  it('getRecordContent returns rows for synthesized ids', () => {
    const rows = source.getRecordContent('canopy_entries', ['proj:a.ts', 'proj:b.ts']);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === 'proj:b.ts')?.text).toBe('desc b');
  });

  it('markEmbedded flips the relational flag using the synthesized id', () => {
    source.markEmbedded('canopy_entries', 'proj:a.ts');
    expect(source.getPendingCount('canopy_entries')).toBe(0);
    const remaining = source.getEmbeddableRows('canopy_entries', 10);
    expect(remaining.find((r) => r.id === 'proj:a.ts')).toBeUndefined();
  });

  it('clearEmbedded resets the flag using the synthesized id', () => {
    source.clearEmbedded('canopy_entries', 'proj:b.ts');
    expect(source.getPendingCount('canopy_entries')).toBe(2);
  });

  it('clearAllEmbedded scoped to canopy_entries flips all rows', () => {
    source.clearAllEmbedded('canopy_entries');
    expect(source.getPendingCount('canopy_entries')).toBe(2); // a + b; c is not active
  });

  it('getPendingCount counts described un-embedded only', () => {
    expect(source.getPendingCount('canopy_entries')).toBe(1);
  });
});
