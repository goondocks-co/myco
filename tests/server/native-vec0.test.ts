/**
 * The sqlite-vec extension the self-hosted server loads: `server/local-run.ts`
 * hands `getVec0Path()` to the server's vector store, which loads it into its
 * SQLite database. The path must name a loadable extension whose vec0 tables
 * rank by cosine distance.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import { getVec0Path, resolveDevNativeDeps } from '@myco/runtime/native-deps.js';

describe('the vec0 extension path', () => {
  it('names a file that loads as sqlite-vec and ranks a vec0 table by cosine distance', () => {
    resolveDevNativeDeps();
    const vec0 = getVec0Path();
    expect(fs.statSync(vec0).isFile()).toBe(true);

    const db = new Database(':memory:');
    try {
      db.loadExtension(vec0);
      expect((db.query('SELECT vec_version() AS v').get() as { v: string }).v).toMatch(/^v\d/);
      db.run('CREATE VIRTUAL TABLE v USING vec0(id TEXT PRIMARY KEY, embedding float[3] distance_metric=cosine)');
      const insert = db.prepare('INSERT INTO v(id, embedding) VALUES (?, ?)');
      insert.run('x', new Float32Array([1, 0, 0]));
      insert.run('y', new Float32Array([0, 1, 0]));
      const nearest = db.query('SELECT id FROM v WHERE embedding MATCH ? AND k = 2 ORDER BY distance').all(new Float32Array([0.1, 1, 0])) as Array<{ id: string }>;
      expect(nearest.map((row) => row.id)).toEqual(['y', 'x']);
    } finally {
      db.close();
    }
  });
});
