/**
 * Phase 0 de-risk: prove bun:sqlite + sqlite-vec loadExtension works on darwin-arm64.
 *
 * Run: bun scripts/bun-spike-sqlite-vec.ts
 */

import { Database } from 'bun:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// Point bun:sqlite at brew's libsqlite3 which has SQLITE_ENABLE_LOAD_EXTENSION.
// On other platforms this would resolve to the equivalent distribution library.
const customSqlitePath = '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib';
if (fs.existsSync(customSqlitePath)) {
  Database.setCustomSQLite(customSqlitePath);
  console.log(`Using custom sqlite: ${customSqlitePath}`);
} else {
  console.warn(`Custom sqlite not found at ${customSqlitePath}; default will likely fail loadExtension.`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const vec0Path = path.join(repoRoot, 'node_modules', 'sqlite-vec-darwin-arm64', 'vec0.dylib');
if (!fs.existsSync(vec0Path)) {
  console.error(`vec0.dylib not found at ${vec0Path}`);
  process.exit(1);
}
console.log(`Loading vec0 from: ${vec0Path}`);

const db = new Database(':memory:');
db.loadExtension(vec0Path);
console.log('loadExtension: OK');

db.run(`CREATE VIRTUAL TABLE vec_test USING vec0(
  id INTEGER PRIMARY KEY,
  embedding FLOAT[4] DISTANCE_METRIC=COSINE
)`);
console.log('CREATE VIRTUAL TABLE: OK');

const sample = [
  { id: 1, vec: [1.0, 0.0, 0.0, 0.0] },
  { id: 2, vec: [0.9, 0.1, 0.0, 0.0] },
  { id: 3, vec: [0.0, 1.0, 0.0, 0.0] },
  { id: 4, vec: [0.0, 0.0, 1.0, 0.0] },
];
const insert = db.prepare('INSERT INTO vec_test (id, embedding) VALUES (?, ?)');
for (const { id, vec } of sample) {
  insert.run(id, new Uint8Array(new Float32Array(vec).buffer));
}
console.log(`Inserted ${sample.length} rows`);

const queryVec = new Float32Array([1.0, 0.0, 0.0, 0.0]);
const results = db
  .prepare(
    `SELECT id, distance FROM vec_test WHERE embedding MATCH ? ORDER BY distance LIMIT 3`,
  )
  .all(new Uint8Array(queryVec.buffer)) as Array<{ id: number; distance: number }>;

console.log('Top-3 nearest neighbours of [1,0,0,0]:');
for (const row of results) {
  console.log(`  id=${row.id} distance=${row.distance.toFixed(4)}`);
}

if (results[0]?.id !== 1 || results[1]?.id !== 2) {
  console.error('FAIL: unexpected order — expected id=1 then id=2');
  process.exit(1);
}
console.log('vec0 similarity order: OK');

db.close();
console.log('\nSPIKE PASS — bun:sqlite + sqlite-vec load and query successfully.');
