import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupCloudflareDeployment } from '@myco/server/cloudflare-backup.js';
import { writeDeploymentRecord, type CloudflareFetch } from '@myco/server/cloudflare.js';
import type { CommandRunner } from '@myco/server/runner.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';

const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: unknown): string => {
  if (value === null) return 'NULL';
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  if (typeof value === 'string') return "'" + value.replaceAll("'", "''") + "'";
  return String(value);
};

function fixture() {
  const source = sqliteEnv();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cloud-backup-'));
  const mycoHome = path.join(root, 'home');
  const destination = path.join(root, 'archive');
  const record = { accountId: 'fixture-account', databaseId: 'fixture-database', databaseName: 'myco-server',
    bucketName: 'myco-server-blobs', workerName: 'myco-server', storeId: 'fixture-store',
    vectorIndexName: 'fixture-vectors', wrapKeySecretName: 'fixture-wrap-key',
    versionId: 'fixture-version', deployedAt: '2026-09-13T00:00:00.000Z' };
  writeDeploymentRecord({ ...record, ...{ unexpectedCredential: 'fixture-private-value' } }, mycoHome);
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  // The blob was uploaded under its own generation: R2 holds it under that name, and the artifact keeps the logical key.
  const generation = crypto.randomUUID();
  source.sqlite.run(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
    VALUES ('proj_1',?,?,'application/octet-stream','mt_fixture',1,?)`, [digest, bytes.length, generation]);
  source.sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,title)
    VALUES ('proj_1','s_backup','m_fixture','mt_fixture',1,1,'Recovered 🌱 title')`);
  const backupKey = 'backups/lineage__1__bk_pinned.jsonl';
  const backupBody = '{"format":"myco-backup/1"}\n';
  source.sqlite.run(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned) VALUES ('pinned',?,1,?,'{}',13,'fixture',1)`, [backupKey, Buffer.byteLength(backupBody)]);
  source.sqlite.exec('CREATE TABLE recovery_fixture(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, bytes BLOB)');
  source.sqlite.run('INSERT INTO recovery_fixture VALUES (71, NULL, NULL)');
  source.sqlite.run('DELETE FROM recovery_fixture');
  const body = "line; one\nquoted '🌱' /* text */ -- still text";
  source.sqlite.run('INSERT INTO recovery_fixture VALUES (3, ?, ?)', [body, bytes]);
  let drift = false;
  let downloadFails = false;
  let metadataReads = 0;
  const calls: string[][] = [];
  const runner: CommandRunner = { async run(command, args, options) {
    calls.push([...args]);
    expect(command).toBe('npx');
    expect(args.slice(0, 2)).toEqual(['--no-install', 'wrangler']);
    expect(options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(record.accountId);
    expect(options?.cwd?.startsWith(mycoHome)).toBe(true);
    if (args.includes('auth')) return { code: 0, stdout: JSON.stringify({ type: 'oauth', token: 'fixture-operator-token' }), stderr: '' };
    expect(fs.readFileSync(args[args.indexOf('-c') + 1]!, 'utf8')).toContain(record.databaseId);
    if (args.includes('execute')) {
      if (drift && ++metadataReads === 2) source.sqlite.exec('CREATE TABLE changed_schema(id TEXT)');
      const rows = source.sqlite.query(args[args.indexOf('--command') + 1]!).all();
      return { code: 0, stdout: JSON.stringify([{ success: true, results: rows }]), stderr: '' };
    }
    if (args.includes('export')) {
      const tables = args.flatMap((arg, i) => arg === '--table' ? [args[i + 1]!] : []);
      const sql = ['PRAGMA defer_foreign_keys=TRUE;'];
      for (const table of tables) {
        if (table === 'sqlite_sequence') sql.push('DELETE FROM sqlite_sequence;');
        else sql.push(source.sqlite.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)!.sql + ';');
        for (const row of source.sqlite.query<Record<string, unknown>, []>(`SELECT * FROM ${quote(table)}`).all()) {
          sql.push(`INSERT INTO ${quote(table)} (${Object.keys(row).map(quote).join(',')}) VALUES (${Object.values(row).map(literal).join(',')});`);
        }
      }
      fs.writeFileSync(args[args.indexOf('--output') + 1]!, sql.join('\n'));
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected provider command ${args.join(' ')}`);
  } };
  const fetchObject: CloudflareFetch = async (input, init) => {
    const prefix = `https://api.cloudflare.com/client/v4/accounts/${record.accountId}/r2/buckets/${record.bucketName}/objects/`;
    expect(String(input).startsWith(prefix)).toBe(true);
    const key = String(input).slice(prefix.length);
    expect([`proj_1/${digest}~${generation}`, backupKey]).toContain(key);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-operator-token');
    return downloadFails ? new Response('object unavailable', { status: 503 }) : new Response(key === backupKey ? backupBody : bytes);
  };
  return { source, root, mycoHome, destination, record, runner, calls, body, bytes, digest, backupKey, backupBody,
    drift: () => { drift = true; }, downloadFails: (value: boolean) => { downloadFails = value; },
    backup: () => backupCloudflareDeployment({ accountId: record.accountId, mycoHome, destination, runner, fetch: fetchObject }),
    cleanup: () => { source.sqlite.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

it('reconstructs FTS and triggers, preserves sequence high-water and exact values, and resumes interrupted R2 copy', async () => {
  const f = fixture();
  try {
    f.downloadFails(true);
    await expect(f.backup()).rejects.toThrow('HTTP 503');
    expect(JSON.parse(fs.readFileSync(path.join(f.destination, 'recovery.json'), 'utf8')).status).toBe('content');
    f.downloadFails(false);
    const result = await f.backup();
    expect(result.status).toBe('complete');
    expect(JSON.stringify(result)).not.toContain('fixture-private-value');
    expect(f.calls.filter((call) => call.includes('export'))).toHaveLength(1);
    expect(f.calls.find((call) => call.includes('export'))).toContain('sqlite_sequence');
    expect(new Uint8Array(fs.readFileSync(path.join(f.destination, 'blobs', 'proj_1', f.digest)))).toEqual(f.bytes);
    expect(fs.readFileSync(path.join(f.destination, 'blobs', f.backupKey), 'utf8')).toBe(f.backupBody);
    const recovered = new Database(path.join(f.destination, 'myco.sqlite'));
    try {
      expect(recovered.query('SELECT * FROM recovery_fixture').get()).toEqual({ id: 3, body: f.body, bytes: f.bytes });
      expect(recovered.query("INSERT INTO recovery_fixture(body) VALUES('next') RETURNING id").get()).toEqual({ id: 72 });
      expect(recovered.query("SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH 'Recovered'").all()).toHaveLength(1);
      recovered.exec("UPDATE sessions SET title='Continuation proof' WHERE session_id='s_backup'");
      expect(recovered.query("SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH 'Continuation'").all()).toHaveLength(1);
      expect(recovered.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { recovered.close(); }
    expect(f.source.sqlite.query("SELECT title FROM sessions WHERE session_id='s_backup'").get()).toEqual({ title: 'Recovered 🌱 title' });
  } finally { f.cleanup(); }
});

it('refuses schema drift and leaves the artifact incomplete', async () => {
  const f = fixture();
  try {
    f.drift();
    await expect(f.backup()).rejects.toThrow('schema or configuration changed');
    expect(fs.existsSync(path.join(f.destination, 'myco.sqlite'))).toBe(false);
    expect(f.calls.some((call) => call.includes('get'))).toBe(false);
  } finally { f.cleanup(); }
});

it('refuses a conflicting account before provider commands or destination writes', async () => {
  const f = fixture();
  try {
    await expect(backupCloudflareDeployment({ accountId: 'other', mycoHome: f.mycoHome, destination: f.destination, runner: f.runner })).rejects.toThrow('account does not match');
    expect(f.calls).toHaveLength(0);
    expect(fs.existsSync(f.destination)).toBe(false);
  } finally { f.cleanup(); }
});
