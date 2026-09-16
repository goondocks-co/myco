import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materializeRecoveryStaging } from '@myco/server/recovery-materialize.js';
import { SCHEMA_QUERY, schemaObjects } from '@myco/server/recovery-schema.js';
import { exportedTables } from '@myco/server/recovery-snapshot.js';
import { STAGING_FORMAT } from '@myco/server/recovery-contract.js';
import { sqliteEnv } from '../../myco-server/helpers/fixtures.js';

export const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: unknown): string => {
  if (value === null) return 'NULL';
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  if (typeof value === 'string') return "'" + value.replaceAll("'", "''") + "'";
  return String(value);
};
const digestOf = (body: Uint8Array | string) => createHash('sha256').update(body).digest('hex');
const fingerprint = (file: string) => ({ sha256: digestOf(fs.readFileSync(file)), bytes: fs.statSync(file).size });

/**
 * A safe staging: a migrated source database with every numeric value inside the ceilings Myco writes, exported in the
 * provider's statement shape, with the source's own schema objects captured beside it.
 */
export function stagingFixture(seed: (db: Database) => void = () => {}) {
  const source = sqliteEnv();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-materialize-'));
  const staging = path.join(root, 'staging');
  const destination = path.join(root, 'artifact');
  fs.mkdirSync(path.join(staging, 'objects', 'proj_1'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'objects', 'backups'), { recursive: true });
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const blobDigest = digestOf(bytes);
  const body = "line; one\nquoted '🌱' /* text */ -- still text";
  source.sqlite.run(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at)
    VALUES ('proj_1',?,?,'application/octet-stream','mt_fixture',1)`, [blobDigest, bytes.length]);
  source.sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,title)
    VALUES ('proj_1','s_materialize','m_fixture','mt_fixture',1,1,'Recovered 🌱 title')`);
  source.sqlite.run(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,tool_name,success,duration_ms,created_at,token_id,received_at,input_blob_key)
    VALUES ('proj_1','tc_1','s_materialize','evt_1','Bash',1,2592000000,1,'mt_fixture',1,?)`, [blobDigest]);
  const backupKey = 'backups/lineage__1__bk_pinned.jsonl';
  const backupBody = '{"format":"myco-backup/1"}\n';
  source.sqlite.run('INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned, sha256) VALUES (?,?,1,?,\'{}\',13,\'fixture\',1,?)',
    ['pinned', backupKey, Buffer.byteLength(backupBody), digestOf(backupBody)]);
  source.sqlite.exec('CREATE TABLE recovery_fixture(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, bytes BLOB)');
  source.sqlite.run('INSERT INTO recovery_fixture VALUES (71, NULL, NULL)');
  source.sqlite.run('DELETE FROM recovery_fixture');
  source.sqlite.run('INSERT INTO recovery_fixture VALUES (3, ?, ?)', [body, bytes]);
  seed(source.sqlite);

  const schema = schemaObjects.parse(source.sqlite.query(SCHEMA_QUERY).all());
  const sql = ['PRAGMA defer_foreign_keys=TRUE;'];
  for (const table of exportedTables(schema)) {
    if (table === 'sqlite_sequence') sql.push('DELETE FROM sqlite_sequence;');
    else sql.push(source.sqlite.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)!.sql + ';');
    for (const row of source.sqlite.query<Record<string, unknown>, []>(`SELECT * FROM ${quote(table)}`).all()) {
      sql.push(`INSERT INTO ${quote(table)} (${Object.keys(row).map(quote).join(',')}) VALUES (${Object.values(row).map(literal).join(',')});`);
    }
  }
  fs.writeFileSync(path.join(staging, 'd1.sql'), sql.join('\n'));
  fs.writeFileSync(path.join(staging, 'schema.json'), JSON.stringify(schema, null, 2));
  fs.writeFileSync(path.join(staging, 'objects', 'proj_1', blobDigest), bytes);
  fs.writeFileSync(path.join(staging, 'objects', backupKey), backupBody);
  const manifest = {
    format: STAGING_FORMAT,
    source: { target: 'cloudflare' as const, locator: 'fixture-account/fixture-database/fixture-bucket' },
    status: 'complete' as const,
    startedAt: '2026-09-16T00:00:00.000Z',
    completedAt: '2026-09-16T00:01:00.000Z',
    database: fingerprint(path.join(staging, 'd1.sql')),
    schema: fingerprint(path.join(staging, 'schema.json')),
    exportBookmark: '00000004-00015960-000050e7-fixture',
    configuration: { accountId: 'fixture-account', databaseId: 'fixture-database' },
    credentialsRequired: ['MYCO_WRAP_KEY'],
    objects: [
      { key: `proj_1/${blobDigest}`, bytes: bytes.length, sha256: blobDigest },
      { key: backupKey, bytes: Buffer.byteLength(backupBody), sha256: digestOf(backupBody) },
    ],
  };
  const write = (value: unknown = manifest) => fs.writeFileSync(path.join(staging, 'recovery.json'), JSON.stringify(value, null, 2));
  write();
  return {
    source, root, staging, destination, manifest, write, bytes, blobDigest, body, backupKey, backupBody, fingerprint,
    materialize: (to = destination) => materializeRecoveryStaging({ staging, destination: to }),
    cleanup: () => { source.sqlite.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
