import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupCloudflareDeployment } from '@myco/server/cloudflare-backup.js';
import * as cloudflare from '@myco/server/cloudflare.js';
import { writeDeploymentRecord, type CloudflareFetch, type OperatorObjectTimeouts } from '@myco/server/cloudflare.js';
import { RECOVERY_RETRY, verifyRecoveryBundle, type RecoveryRetryPolicy } from '@myco/server/recovery-bundle.js';
import type { CommandRunner } from '@myco/server/runner.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { recoveryConfigurationOf } from '@myco/server/cloudflare-resources.js';
import { RECOVERY_CREDENTIAL_NAMES } from '@myco-server-worker/core/recovery-staging.js';

/** The production attempt bounds with no waits between attempts, so a test exercises the bound without sleeping. */
const IMMEDIATE_RETRY: RecoveryRetryPolicy = {
  objectReads: { ...RECOVERY_RETRY.objectReads, backoffMs: [0] },
  holdOpens: { ...RECOVERY_RETRY.holdOpens, backoffMs: [0] },
};

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
  const statements: Array<{ sql: string; timeoutMs?: number }> = [];
  const runner: CommandRunner = { async run(command, args, options) {
    calls.push([...args]);
    expect(command).toBe('npx');
    expect(args.slice(0, 2)).toEqual(['--no-install', 'wrangler']);
    expect(options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(record.accountId);
    expect(options?.cwd?.startsWith(mycoHome)).toBe(true);
    if (args.includes('auth')) return { code: 0, stdout: JSON.stringify({ type: 'oauth', token: 'fixture-operator-token' }), stderr: '' };
    expect(fs.readFileSync(args[args.indexOf('-c') + 1]!, 'utf8')).toContain(record.databaseId);
    if (args.includes('execute')) {
      const statement = args[args.indexOf('--command') + 1]!;
      // Every statement carries its own window. A recovery hold is opened and released by these commands, so one that
      // answers nothing would hold an operator, and its child would keep a mutation alive that nothing waits on.
      expect(options?.timeoutMs).toBeGreaterThan(0);
      statements.push({ sql: statement, timeoutMs: options?.timeoutMs });
      // The drift lands between the snapshot's two schema reads; the hold's own statements are not those reads.
      if (drift && statement.includes('sqlite_master') && ++metadataReads === 2) source.sqlite.exec('CREATE TABLE changed_schema(id TEXT)');
      const rows = source.sqlite.query(statement).all();
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
  return { source, root, mycoHome, destination, record, runner, calls, statements, body, bytes, digest, backupKey, backupBody,
    /** The key R2 holds the registered blob's bytes under. */
    blobSource: `proj_1/${digest}~${generation}`,
    fetchObject,
    drift: () => { drift = true; }, downloadFails: (value: boolean) => { downloadFails = value; },
    backup: (use: { fetch?: CloudflareFetch; runner?: CommandRunner; timeouts?: OperatorObjectTimeouts; report?: (line: string) => void } = {}) =>
      backupCloudflareDeployment({ accountId: record.accountId, mycoHome, destination, runner: use.runner ?? runner,
        fetch: use.fetch ?? fetchObject, retry: IMMEDIATE_RETRY, timeouts: use.timeouts, report: use.report }),
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
    // The backup records the record's resolved recovery configuration and the version it runs, and every credential name.
    expect(result.snapshot!.configuration).toEqual({ ...recoveryConfigurationOf(f.record), versionId: f.record.versionId, deployedAt: f.record.deployedAt });
    expect(result.snapshot!.configuration.recoveryBucketName).toBe('myco-server-recovery');
    expect(result.snapshot!.credentialsRequired).toEqual([...RECOVERY_CREDENTIAL_NAMES]);
    // The operator's provider token and the record's unrecognised private field are secret sentinels no manifest carries.
    const manifestText = fs.readFileSync(path.join(f.destination, 'recovery.json'), 'utf8');
    for (const sentinel of ['fixture-private-value', 'fixture-operator-token']) expect(manifestText).not.toContain(sentinel);
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

/**
 * A backup whose deployment record is replaced after its capture: `replace` rewrites the record once the first read
 * returns, and `restore`, when set, puts the captured record back before the next read. The rendered export config and
 * the recorded configuration are read back from what the backup actually used.
 */
async function backupWhileRecordChanges(restore: boolean) {
  const f = fixture();
  const file = path.join(f.mycoHome, 'server', 'cloudflare', 'record.json');
  const captured = fs.readFileSync(file, 'utf8');
  const read = cloudflare.readDeploymentRecord;
  let reads = 0;
  const spy = spyOn(cloudflare, 'readDeploymentRecord').mockImplementation((home) => {
    reads += 1;
    if (reads === 2 && restore) fs.writeFileSync(file, captured);
    const value = read(home);
    if (reads === 1) fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(captured), fleet: 7 }));
    return value;
  });
  let renderedFleet: string | null = null;
  const runner: CommandRunner = { run: async (command, args, options) => {
    if (args.includes('export')) {
      const vars = (Bun.TOML.parse(fs.readFileSync(args[args.indexOf('-c') + 1]!, 'utf8')) as { vars: Record<string, string> }).vars;
      renderedFleet = vars.MYCO_FLEET ?? null;
    }
    return f.runner.run(command, args, options);
  } };
  const fetch: CloudflareFetch = async (input) => new Response(String(input).endsWith(f.backupKey) ? f.backupBody : f.bytes);
  const outcome = await backupCloudflareDeployment({ accountId: f.record.accountId, mycoHome: f.mycoHome, destination: f.destination, runner, fetch })
    .then((result) => ({ result }), (error: unknown) => ({ error: String(error) }));
  spy.mockRestore();
  return { f, reads, renderedFleet, outcome };
}

it('refuses a backup whose deployment record changed after the capture that named its export', async () => {
  const { f, reads, renderedFleet, outcome } = await backupWhileRecordChanges(false);
  try {
    expect(reads).toBe(2);
    expect(renderedFleet).toBeNull();
    expect('error' in outcome ? outcome.error : 'completed').toContain('schema or configuration changed');
    expect(fs.existsSync(path.join(f.destination, 'myco.sqlite'))).toBe(false);
  } finally { f.cleanup(); }
});

it('records the configuration of the same record capture that rendered and named the export', async () => {
  const { f, reads, renderedFleet, outcome } = await backupWhileRecordChanges(true);
  try {
    expect(reads).toBe(2);
    if (!('result' in outcome)) throw new Error(outcome.error);
    expect(outcome.result.status).toBe('complete');
    // The temporary replacement record named fleet 7; neither the rendered export config nor the artifact carries it.
    expect(renderedFleet).toBeNull();
    expect(outcome.result.snapshot!.configuration).toEqual({ ...recoveryConfigurationOf(f.record), versionId: f.record.versionId, deployedAt: f.record.deployedAt });
    expect('fleet' in outcome.result.snapshot!.configuration).toBe(false);
  } finally { f.cleanup(); }
});

it('bounds every hold statement it sends, so no hold waits on a provider command nothing can stop', async () => {
  const f = fixture();
  try {
    expect((await f.backup()).status).toBe('complete');
    const holdStatements = f.statements.filter((sent) => sent.sql.includes('recovery_holds'));
    // Acquire, the read back, the source's own open hold, the release, and its read back.
    expect(holdStatements.length).toBeGreaterThanOrEqual(5);
    expect(holdStatements.every((sent) => typeof sent.timeoutMs === 'number' && sent.timeoutMs > 0)).toBe(true);
  } finally { f.cleanup(); }
});

/** What Bun's fetch throws when its signal's timeout fires: the failure the 2026-09-28 backup ended on. */
const timedOut = () => new DOMException('The operation timed out.', 'TimeoutError');
/** The files a resume would accept or sweep: every regular file under the artifact's blob directory. */
const storedFiles = (destination: string): string[] => {
  const root = path.join(destination, 'blobs');
  return fs.existsSync(root) ? (fs.readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[]).filter((name) => fs.statSync(path.join(root, name)).isFile()).sort() : [];
};

it('retries an object read that times out, and completes a verified artifact', async () => {
  const f = fixture();
  try {
    let reads = 0;
    const reports: string[] = [];
    const fetch: CloudflareFetch = async (input, init) => {
      if (String(input).endsWith(f.blobSource) && ++reads <= 2) throw timedOut();
      return f.fetchObject(input, init);
    };
    const result = await f.backup({ fetch, report: (line) => reports.push(line) });
    expect(result.status).toBe('complete');
    expect(reads).toBe(3);
    expect(reports.filter((line) => line.includes('The operation timed out.'))).toEqual([
      expect.stringContaining(`(attempt 2 of ${RECOVERY_RETRY.objectReads.attempts})`),
      expect.stringContaining(`(attempt 3 of ${RECOVERY_RETRY.objectReads.attempts})`),
    ]);
    expect((await verifyRecoveryBundle(f.destination)).status).toBe('complete');
    expect(new Uint8Array(fs.readFileSync(path.join(f.destination, 'blobs', 'proj_1', f.digest)))).toEqual(f.bytes);
  } finally { f.cleanup(); }
});

it('fails at once on a missing object, without retrying it', async () => {
  const f = fixture();
  try {
    let reads = 0;
    const fetch: CloudflareFetch = async (input, init) => {
      if (!String(input).endsWith(f.blobSource)) return f.fetchObject(input, init);
      reads += 1;
      return new Response(null, { status: 404 });
    };
    const failure = await f.backup({ fetch }).then(() => null, (error: Error) => error.message);
    expect(failure).toContain('HTTP 404');
    expect(failure).not.toContain('attempts');
    expect(reads).toBe(1);
  } finally { f.cleanup(); }
});

it('fails at once on a credential refused after its refresh, without retrying it', async () => {
  const f = fixture();
  try {
    let reads = 0;
    const fetch: CloudflareFetch = async (input, init) => {
      if (!String(input).endsWith(f.blobSource)) return f.fetchObject(input, init);
      reads += 1;
      return new Response(null, { status: 403 });
    };
    await expect(f.backup({ fetch })).rejects.toThrow('HTTP 403');
    // The one refresh the object store makes, and nothing after it.
    expect(reads).toBe(2);
  } finally { f.cleanup(); }
});

it('gives up on an object whose every read times out, naming how many attempts it made', async () => {
  const f = fixture();
  try {
    let reads = 0;
    const fetch: CloudflareFetch = async (input, init) => {
      if (String(input).endsWith(f.blobSource)) { reads += 1; throw timedOut(); }
      return f.fetchObject(input, init);
    };
    const { attempts } = RECOVERY_RETRY.objectReads;
    await expect(f.backup({ fetch })).rejects.toThrow(`was not stored after ${attempts} attempts: The operation timed out.`);
    expect(reads).toBe(attempts);
    expect(JSON.parse(fs.readFileSync(path.join(f.destination, 'recovery.json'), 'utf8')).status).toBe('content');
  } finally { f.cleanup(); }
});

it('retries a server error and a reset connection, and leaves no partial file behind any failed attempt', async () => {
  const f = fixture();
  try {
    // Every read of the blob sends its first bytes and then loses the connection.
    const reset = () => Object.assign(new Error('The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' });
    let reads = 0;
    const partial: CloudflareFetch = async (input, init) => {
      if (!String(input).endsWith(f.blobSource)) return f.fetchObject(input, init);
      reads += 1;
      if (reads === 1) return new Response('unavailable', { status: 503 });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(f.bytes.slice(0, 2)); },
        pull(controller) { controller.error(reset()); },
      }));
    };
    const { attempts } = RECOVERY_RETRY.objectReads;
    await expect(f.backup({ fetch: partial })).rejects.toThrow(`was not stored after ${attempts} attempts`);
    expect(reads).toBe(attempts);
    // No attempt left bytes under the object's name or a partial file beside it.
    expect(storedFiles(f.destination).filter((name) => name.startsWith('proj_1'))).toEqual([]);
    // A later run resumes the same snapshot and copies the object whole.
    const result = await f.backup();
    expect(result.status).toBe('complete');
    expect(new Uint8Array(fs.readFileSync(path.join(f.destination, 'blobs', 'proj_1', f.digest)))).toEqual(f.bytes);
    expect((await verifyRecoveryBundle(f.destination)).status).toBe('complete');
  } finally { f.cleanup(); }
});

describe('a recovery hold write that does not answer', () => {
  const holds = (f: ReturnType<typeof fixture>) => f.source.sqlite.query('SELECT token, holder, released_at IS NOT NULL AS released FROM recovery_holds').all();
  const isAcquire = (args: readonly string[]) => args.includes('execute') && args[args.indexOf('--command') + 1]!.trimStart().startsWith('INSERT INTO recovery_holds');

  it('asks for the same token again when the write never reached the source, and proceeds under one hold', async () => {
    const f = fixture();
    try {
      let acquires = 0;
      const runner: CommandRunner = { run: async (command, args, options) => {
        if (isAcquire(args) && ++acquires === 1) return { code: 1, stdout: '', stderr: 'fetch failed' };
        return f.runner.run(command, args, options);
      } };
      const reports: string[] = [];
      const result = await f.backup({ runner, report: (line) => reports.push(line) });
      expect(result.status).toBe('complete');
      expect(acquires).toBe(2);
      expect(holds(f)).toEqual([{ token: expect.any(String), holder: 'operator', released: 1 }]);
      expect(reports.some((line) => line.includes('The recovery hold write did not answer') && line.includes('fetch failed'))).toBe(true);
    } finally { f.cleanup(); }
  });

  it('opens one hold when the lost write lands after the source answered it absent', async () => {
    const f = fixture();
    try {
      let acquires = 0;
      let late: string | null = null;
      const runner: CommandRunner = { run: async (command, args, options) => {
        if (isAcquire(args) && ++acquires === 1) {
          late = args[args.indexOf('--command') + 1]!;
          return { code: 1, stdout: '', stderr: 'fetch failed' };
        }
        const answer = await f.runner.run(command, args, options);
        // The read back answered absent; the write the provider accepted lands now.
        if (late !== null && args.includes('execute')) { f.source.sqlite.run(late); late = null; }
        return answer;
      } };
      expect((await f.backup({ runner })).status).toBe('complete');
      expect(acquires).toBe(2);
      expect(holds(f)).toEqual([{ token: expect.any(String), holder: 'operator', released: 1 }]);
    } finally { f.cleanup(); }
  });

  it('refuses after its bound when the source never opens the token, naming the attempts', async () => {
    const f = fixture();
    try {
      let acquires = 0;
      const runner: CommandRunner = { run: async (command, args, options) => {
        if (isAcquire(args)) { acquires += 1; return { code: 1, stdout: '', stderr: 'fetch failed' }; }
        return f.runner.run(command, args, options);
      } };
      const { attempts } = RECOVERY_RETRY.holdOpens;
      await expect(f.backup({ runner })).rejects.toThrow(`recovery hold was not opened on the source (absent) after ${attempts} attempts; nothing was captured`);
      expect(acquires).toBe(attempts);
      expect(holds(f)).toEqual([]);
      expect(fs.existsSync(path.join(f.destination, 'myco.sqlite'))).toBe(false);
    } finally { f.cleanup(); }
  });
});
