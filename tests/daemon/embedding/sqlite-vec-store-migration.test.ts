import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getVec0Path, resolveDevNativeDeps } from '@myco/runtime/native-deps.js';
import { SqliteVecVectorStore } from '@myco/daemon/embedding/sqlite-vec-store';
import { EMBEDDING_DIMENSIONS } from '@myco/db/schema';

const DIMS = EMBEDDING_DIMENSIONS;
const unit = (axis: number): number[] => { const v = new Array(DIMS).fill(0); v[axis] = 1; return v; };

describe('SqliteVecVectorStore v0 -> v1 migration', () => {
  let tmpDir: string | undefined;
  let store: SqliteVecVectorStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('upgrades an old (record_id, embedding) table — vectors preserved, columns backfilled, no re-embed', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-vecmig-'));
    const dbPath = path.join(tmpDir, 'vectors.db');

    // --- Build a v0 database by hand: old vec0 layout (no partition/metadata
    //     columns) + the embedding_metadata domain_metadata the backfill reads.
    resolveDevNativeDeps();
    const old = new Database(dbPath);
    old.loadExtension(getVec0Path());
    old.run(`CREATE VIRTUAL TABLE vec_spores USING vec0(record_id TEXT PRIMARY KEY, embedding float[${DIMS}] distance_metric=cosine)`);
    old.run(`CREATE TABLE embedding_metadata (
      namespace TEXT NOT NULL, record_id TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL,
      dimensions INTEGER NOT NULL, content_hash TEXT NOT NULL, embedded_at INTEGER NOT NULL,
      domain_metadata TEXT, PRIMARY KEY (namespace, record_id))`);
    const insVec = old.prepare('INSERT INTO vec_spores(record_id, embedding) VALUES (?, ?)');
    const insMeta = old.prepare(
      `INSERT INTO embedding_metadata(namespace, record_id, model, provider, dimensions, content_hash, embedded_at, domain_metadata)
       VALUES ('spores', ?, 'm', 'p', ${DIMS}, 'h', 1, ?)`,
    );
    insVec.run('a-decision', new Float32Array(unit(0)));
    insMeta.run('a-decision', JSON.stringify({ project_id: 'proj_a', observation_type: 'decision' }));
    insVec.run('b-wisdom', new Float32Array(unit(1)));
    insMeta.run('b-wisdom', JSON.stringify({ project_id: 'proj_a', observation_type: 'wisdom' }));
    expect((old.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0);
    old.close();

    // --- Opening through the store triggers the migration.
    store = new SqliteVecVectorStore(dbPath);

    // Schema upgraded: version bumped and the table now carries the partition key.
    const check = new Database(dbPath, { readonly: true });
    check.loadExtension(getVec0Path());
    expect((check.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    const ddl = (check.query(`SELECT sql FROM sqlite_master WHERE name = 'vec_spores'`).get() as { sql: string }).sql;
    expect(ddl).toContain('partition key');
    check.close();

    // Vectors preserved (no re-embed): unfiltered search returns both, with the
    // ORIGINAL geometry — querying along axis 1 ranks b (the axis-1 vector) first.
    const all = store.search(unit(1), { namespace: 'spores', limit: 10, threshold: -1 });
    expect(all.map((r) => r.id).sort()).toEqual(['a-decision', 'b-wisdom']);
    expect(all[0].id).toBe('b-wisdom');

    // Backfilled columns work in-KNN: nearest is the decision row, but a
    // limit-1 wisdom filter still returns b — proving the column was populated.
    const filtered = store.search(unit(0), { namespace: 'spores', limit: 1, threshold: -1, filters: { observation_type: 'wisdom' } });
    expect(filtered.map((r) => r.id)).toEqual(['b-wisdom']);
  });

  it('is a no-op on a fresh (already-v1) database', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-vecfresh-'));
    const dbPath = path.join(tmpDir, 'vectors.db');
    store = new SqliteVecVectorStore(dbPath); // fresh → created v1
    const check = new Database(dbPath, { readonly: true });
    check.loadExtension(getVec0Path());
    expect((check.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    check.close();
  });
});
