import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { getDatabase } from '@myco/db/client.js';
import { SqliteRecordSource } from '@myco/daemon/embedding/record-source.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';

function seedCanopy() {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO canopy_entries (project_id, machine_id, path, content_hash, size_bytes,
      token_estimate, line_count, language, mechanical_updated_at, llm_description, llm_updated_at, embedded)
     VALUES ('proj', 'local', 'a.ts', 'h1', 100, 20, 5, 'typescript', ?, 'desc a', ?, 0),
            ('proj', 'local', 'b.ts', 'h2', 100, 20, 5, 'typescript', ?, 'desc b', ?, 1),
            ('proj', 'local', 'c.ts', 'h3', 100, 20, 5, 'typescript', ?, NULL,     NULL, 0)`,
  ).run(now, now, now, now, now);
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
