import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { V715 } from '@myco-server-worker/db/schema-v715.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { applySchemaSteps } from './helpers/migrate.ts';

it('the storage step keeps every pending object release and backup a Deployment held, and starts each release with no attempts', async () => {
  const sqlite = new Database(':memory:');
  const db = sqliteRelationalStore(sqlite);
  await applySchemaSteps(db, SCHEMA_STEPS.filter((step) => step.version < V715));
  sqlite.run(`INSERT INTO object_releases(physical,kind,created_at) VALUES ('blobs/proj_a/aa',  'blob', 10), ('backups/bk_1.jsonl', 'backup', 20)`);
  sqlite.run(`INSERT INTO backups(id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned,sha256)
    VALUES ('bk_1','backups/bk_1.jsonl',5,128,'{"spores":1}',714,'myco 2.0',1,'${'a'.repeat(64)}')`);
  const backups = sqlite.query('SELECT * FROM backups').all();

  await applySchemaSteps(db, SCHEMA_STEPS.filter((step) => step.version === V715));

  expect(sqlite.query('SELECT physical,kind,created_at,retry_at,attempts FROM object_releases ORDER BY physical').all()).toEqual([
    { physical: 'backups/bk_1.jsonl', kind: 'backup', created_at: 20, retry_at: 0, attempts: 0 },
    { physical: 'blobs/proj_a/aa', kind: 'blob', created_at: 10, retry_at: 0, attempts: 0 },
  ]);
  expect(sqlite.query('SELECT * FROM backups').all()).toEqual(backups);
  expect(sqlite.query('SELECT slot,physical FROM object_reconciliation_cursor').all()).toEqual([{ slot: 1, physical: '' }]);
  expect(sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
});
