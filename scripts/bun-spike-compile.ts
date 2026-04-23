/**
 * Phase 0: prove that `bun build --compile` with embedded libsqlite3 + vec0.dylib
 * can load the extension at runtime and query a vec0 virtual table.
 *
 * Pattern: embedded files live at /$bunfs/root/<name>, which dlopen cannot read.
 * We extract them to a real temp dir at startup, then pass those paths to the
 * loader APIs.
 *
 * Build:  bun build --compile scripts/bun-spike-compile.ts --outfile /tmp/myco-spike
 * Run:    /tmp/myco-spike
 */

import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// @ts-expect-error - Bun file-embed via import assertion
import libsqliteEmbed from '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib' with { type: 'file' };
// @ts-expect-error
import vec0Embed from '../node_modules/sqlite-vec-darwin-arm64/vec0.dylib' with { type: 'file' };

async function materialize(embedPath: string, targetName: string): Promise<string> {
  const cacheDir = path.join(os.tmpdir(), 'myco-runtime');
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, targetName);
  if (!fs.existsSync(target)) {
    // Bun.file can read /$bunfs/ embeds; Bun.write materializes to a real path.
    await Bun.write(target, Bun.file(embedPath));
    fs.chmodSync(target, 0o755);
  }
  return target;
}

const libsqlitePath = await materialize(libsqliteEmbed, 'libsqlite3.dylib');
const vec0Path = await materialize(vec0Embed, 'vec0.dylib');
console.log(`libsqlite3 → ${libsqlitePath}`);
console.log(`vec0       → ${vec0Path}`);

Database.setCustomSQLite(libsqlitePath);

const db = new Database(':memory:');
db.loadExtension(vec0Path);
console.log('loadExtension: OK');

db.run(`CREATE VIRTUAL TABLE vec_test USING vec0(
  id INTEGER PRIMARY KEY,
  embedding FLOAT[4] DISTANCE_METRIC=COSINE
)`);

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

const queryVec = new Float32Array([1.0, 0.0, 0.0, 0.0]);
const results = db
  .prepare(`SELECT id, distance FROM vec_test WHERE embedding MATCH ? ORDER BY distance LIMIT 3`)
  .all(new Uint8Array(queryVec.buffer)) as Array<{ id: number; distance: number }>;

console.log('Top-3 nearest neighbours of [1,0,0,0]:');
for (const row of results) {
  console.log(`  id=${row.id} distance=${row.distance.toFixed(4)}`);
}

if (results[0]?.id !== 1 || results[1]?.id !== 2) {
  console.error('FAIL: unexpected order');
  process.exit(1);
}

db.close();
console.log('\nCOMPILE SPIKE PASS — embedded libsqlite3 + vec0 works in compiled binary.');
