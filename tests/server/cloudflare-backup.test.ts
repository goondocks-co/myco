import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupCloudflareDeployment, cloudflareRecoveryHoldOf } from '@myco/server/cloudflare-backup.js';
import { D1_EXPORT_DOWNLOAD_ATTEMPTS, D1_QUERY_ATTEMPTS } from '@myco/server/cloudflare-d1-export.js';
import * as cloudflare from '@myco/server/cloudflare.js';
import { writeDeploymentRecord, type CloudflareFetch, type OperatorObjectTimeouts } from '@myco/server/cloudflare.js';
import { abandonRecoveryHold, RECOVERY_RETRY, verifyRecoveryBundle, type RecoveryRetryPolicy } from '@myco/server/recovery-bundle.js';
import { CommandTimedOut, type CommandRunner } from '@myco/server/runner.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { recoveryHoldSql } from '@myco-server-worker/core/object-release.js';
import { SCHEMA_QUERY } from '@myco/server/recovery-schema.js';
import { recoveryConfigurationOf } from '@myco/server/cloudflare-resources.js';
import { RECOVERY_CREDENTIAL_NAMES } from '@myco-server-worker/core/recovery-staging.js';
import * as blobs from '@myco-server-worker/platform/bun/blobs.js';

/** The production attempt bounds with no waits between attempts, so a test exercises the bound without sleeping. */
const IMMEDIATE_RETRY: RecoveryRetryPolicy = {
  objectReads: { ...RECOVERY_RETRY.objectReads, backoffMs: [0] },
  holdReads: { ...RECOVERY_RETRY.holdReads, backoffMs: [0] },
  holdRounds: { ...RECOVERY_RETRY.holdRounds, backoffMs: [0] },
  snapshots: { ...RECOVERY_RETRY.snapshots, backoffMs: [0] },
};

const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: unknown): string => {
  if (value === null) return 'NULL';
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  if (typeof value === 'string') return "'" + value.replaceAll("'", "''") + "'";
  return String(value);
};

function simulatedNetwork() {
  let at = 0;
  const pauses: number[] = [];
  return {
    retry: { now: () => at, sleep: async (ms: number) => { pauses.push(ms); at += ms; }, random: () => 0.5 },
    advance: (ms: number) => { at += ms; }, get at() { return at; }, pauses,
  };
}

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
  /** Every export that found a file already at its output path, which a clean attempt never leaves. */
  const leftovers: string[] = [];
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
    throw new Error(`unexpected provider command ${args.join(' ')}`);
  } };
  /** The export SQL of `tables`, as the provider writes it. */
  const exportSql = (tables: readonly string[]): string => {
    const sql = ['PRAGMA defer_foreign_keys=TRUE;'];
    for (const table of tables) {
      if (table === 'sqlite_sequence') sql.push('DELETE FROM sqlite_sequence;');
      else sql.push(source.sqlite.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)!.sql + ';');
      for (const row of source.sqlite.query<Record<string, unknown>, []>(`SELECT * FROM ${quote(table)}`).all()) {
        sql.push(`INSERT INTO ${quote(table)} (${Object.keys(row).map(quote).join(',')}) VALUES (${Object.values(row).map(literal).join(',')});`);
      }
    }
    return sql.join('\n');
  };
  const exportEndpoint = `https://api.cloudflare.com/client/v4/accounts/${record.accountId}/d1/database/${record.databaseId}/export`;
  const queryEndpoint = `https://api.cloudflare.com/client/v4/accounts/${record.accountId}/d1/database/${record.databaseId}/query`;
  /** Every read sent over the API, in order; `queryFails` answers one in place of the database where it returns a response. */
  const queries: string[] = [];
  let queryFails: (sql: string, n: number) => Response | null = () => null;
  const signedPrefix = 'https://signed.fixture/d1/';
  /** Every export the provider started, by the bookmark it answered; a poll completes it unless `stays` says otherwise. */
  const exports: Array<{ bookmark: string; tables: string[]; polls: number }> = [];
  const exportCalls: Array<{ bookmark: string | null }> = [];
  let stays: (job: { bookmark: string; polls: number }) => boolean = () => false;
  let download: (bookmark: string, attempt: number) => Response | null = () => null;
  let downloads = 0;
  const answer = (result: Record<string, unknown>) => Response.json({ success: true, errors: [], messages: [], result: { success: true, messages: [], ...result } });
  const fetchObject: CloudflareFetch = async (input, init) => {
    if (String(input) === queryEndpoint) {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-operator-token');
      const { sql } = JSON.parse(String(init?.body)) as { sql: string };
      queries.push(sql);
      const failed = queryFails(sql, queries.length);
      if (failed !== null) return failed;
      // The drift lands between the snapshot's two schema reads.
      if (drift && sql.includes('sqlite_master') && ++metadataReads === 2) source.sqlite.exec('CREATE TABLE changed_schema(id TEXT)');
      return Response.json({ success: true, errors: [], messages: [], result: [{ success: true, results: source.sqlite.query(sql).all(), meta: {} }] });
    }
    if (String(input) === exportEndpoint) {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-operator-token');
      const body = JSON.parse(String(init?.body)) as { output_format: string; dump_options: { tables: string[] }; current_bookmark?: string };
      expect(body.output_format).toBe('polling');
      // A fake that answers without end would hide an unbounded poll behind a hung suite.
      if (exportCalls.length >= 5_000) throw new Error('the export was polled without end');
      exportCalls.push({ bookmark: body.current_bookmark ?? null });
      if (body.current_bookmark === undefined) {
        const job = { bookmark: `bm-${exports.length + 1}`, tables: body.dump_options.tables, polls: 0 };
        exports.push(job);
        return answer({ type: 'export', status: 'active', at_bookmark: job.bookmark });
      }
      const job = exports.find((j) => j.bookmark === body.current_bookmark);
      if (job === undefined) return Response.json({ success: false, errors: [{ code: 7500, message: 'unknown bookmark' }] }, { status: 400 });
      job.polls += 1;
      if (stays(job)) return answer({ type: 'export', status: 'active', at_bookmark: job.bookmark });
      return answer({ type: 'export', status: 'complete', at_bookmark: job.bookmark, result: { filename: 'd1.sql', signed_url: `${signedPrefix}${job.bookmark}` } });
    }
    if (String(input).startsWith(signedPrefix)) {
      // The signed download is a capability of its own, fetched without the operator's credential.
      expect(new Headers(init?.headers).get('Authorization')).toBeNull();
      const bookmark = String(input).slice(signedPrefix.length);
      downloads += 1;
      if (fs.existsSync(path.join(destination, '.snapshot', 'd1.sql'))) leftovers.push(bookmark);
      const job = exports.find((j) => j.bookmark === bookmark)!;
      const sql = exportSql(job.tables);
      return download(bookmark, downloads) ?? new Response(sql, { headers: { 'content-length': String(new TextEncoder().encode(sql).byteLength) } });
    }
    const prefix = `https://api.cloudflare.com/client/v4/accounts/${record.accountId}/r2/buckets/${record.bucketName}/objects/`;
    expect(String(input).startsWith(prefix)).toBe(true);
    const key = String(input).slice(prefix.length);
    expect([`proj_1/${digest}~${generation}`, backupKey]).toContain(key);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-operator-token');
    return downloadFails ? new Response('object unavailable', { status: 503 }) : new Response(key === backupKey ? backupBody : bytes);
  };
  return { source, root, mycoHome, destination, record, runner, calls, leftovers, statements, body, bytes, digest, backupKey, backupBody,
    /** Every export the provider was asked to start, and every request made of the export API. */
    exports: () => exports, exportCalls: () => exportCalls, downloads: () => downloads,
    /** Every read sent over the D1 API; answer one with `fail` in place of the database. */
    queries: () => queries, queryFailsWith: (fail: (sql: string, n: number) => Response | null) => { queryFails = fail; },
    /** Keep an export running for as long as `rule` says; lose a download where `lost` answers a response. */
    exportStays: (rule: (job: { bookmark: string; polls: number }) => boolean) => { stays = rule; },
    downloadFailsWith: (lost: (bookmark: string, attempt: number) => Response | null) => { download = lost; },
    /** The key R2 holds the registered blob's bytes under. */
    blobSource: `proj_1/${digest}~${generation}`,
    fetchObject,
    drift: () => { drift = true; }, downloadFails: (value: boolean) => { downloadFails = value; },
    backup: (use: { fetch?: CloudflareFetch; runner?: CommandRunner; timeouts?: OperatorObjectTimeouts; networkRetry?: Parameters<typeof backupCloudflareDeployment>[0]['networkRetry']; report?: (line: string) => void; retry?: RecoveryRetryPolicy; d1Export?: Parameters<typeof backupCloudflareDeployment>[0]['d1Export']; destination?: string } = {}) =>
      backupCloudflareDeployment({ accountId: record.accountId, mycoHome, destination: use.destination ?? destination, runner: use.runner ?? runner,
        fetch: use.fetch ?? fetchObject, retry: use.retry ?? IMMEDIATE_RETRY, timeouts: use.timeouts, networkRetry: use.networkRetry ?? simulatedNetwork().retry, report: use.report, d1Export: use.d1Export ?? { pollMs: 0, sleep: async () => {} } }),
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
    // The producer's hold and both schema reads go over the operator login to the query endpoint, not a subprocess.
    expect(f.queries().filter((sql) => sql.includes('sqlite_master')).length).toBeGreaterThanOrEqual(2);
    expect(f.queries().some((sql) => sql.includes('recovery_holds'))).toBe(true);
    expect(f.statements.filter((s) => s.sql.includes('sqlite_master'))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('fixture-private-value');
    // The backup records the record's resolved recovery configuration and the version it runs, and every credential name.
    expect(result.snapshot!.configuration).toEqual({ ...recoveryConfigurationOf(f.record), versionId: f.record.versionId, deployedAt: f.record.deployedAt });
    expect(result.snapshot!.configuration.recoveryBucketName).toBe('myco-server-recovery');
    expect(result.snapshot!.credentialsRequired).toEqual([...RECOVERY_CREDENTIAL_NAMES]);
    // The operator's provider token and the record's unrecognised private field are secret sentinels no manifest carries.
    const manifestText = fs.readFileSync(path.join(f.destination, 'recovery.json'), 'utf8');
    for (const sentinel of ['fixture-private-value', 'fixture-operator-token']) expect(manifestText).not.toContain(sentinel);
    expect(f.exports()).toHaveLength(1);
    expect(f.exports()[0]!.tables).toContain('sqlite_sequence');
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

it('refuses to export while this Deployment\'s own producer holds the database, and starts no export beside it (#1484)', async () => {
  const f = fixture();
  try {
    f.source.sqlite.run("INSERT INTO recovery_holds(token, acquired_at, holder) VALUES ('00000000-0000-4000-8000-00000000abcd', 1790000000000, 'producer')");
    const failure = await f.backup().then(() => null, (error: Error) => error.message);
    expect(failure).toContain('an automatic backup of this Deployment has been running since 2026-09-21');
    expect(f.exportCalls()).toEqual([]);
    // The hold it opened protected nothing: it is released as abandoned, not left open to defer the producer (#1493 G1).
    expect(failure).toContain('recovery hold was released, since it protected nothing yet');
    expect(f.source.sqlite.query("SELECT released_at IS NOT NULL AS released, release_reason FROM recovery_holds WHERE holder = 'operator'").all())
      .toEqual([{ released: 1, release_reason: 'abandoned' }]);
    expect(fs.existsSync(path.join(f.destination, '.recovery-hold.json'))).toBe(false);
    // Once the producer's attempt ends, the backup runs.
    f.source.sqlite.run("UPDATE recovery_holds SET released_at = 1790000001000, release_reason = 'complete' WHERE holder = 'producer'");
    expect((await f.backup()).status).toBe('complete');
  } finally { f.cleanup(); }
});

it('names the command that gives its hold up where the release of a refused capture\'s hold goes unanswered (#1493 G1)', async () => {
  const f = fixture();
  try {
    f.source.sqlite.run("INSERT INTO recovery_holds(token, acquired_at, holder) VALUES ('00000000-0000-4000-8000-00000000abce', 1790000000000, 'producer')");
    // Every statement that would release the operator's hold fails; everything else answers.
    const runner: CommandRunner = { run: async (command, args, options) => {
      const statement = args.includes('--command') ? args[args.indexOf('--command') + 1]! : '';
      if (/UPDATE recovery_holds/.test(statement) && /abandoned/.test(statement)) return { code: 1, stdout: '', stderr: '✘ [ERROR] fetch failed\n' };
      return f.runner.run(command, args, options);
    } };
    const failure = await f.backup({ runner }).then(() => null, (error: Error) => error.message);
    const token = (f.source.sqlite.query("SELECT token FROM recovery_holds WHERE holder = 'operator'").get() as { token: string }).token;
    expect(failure).toContain(`is still open, and defers the source's own backups while it is: give it up with \`myco server recovery-hold --token ${token} --abandon --target cloudflare\``);
  } finally { f.cleanup(); }
});

it('opens its own hold before it reads for the producer\'s, so a producer that opens one in between is found (#1484)', async () => {
  const f = fixture();
  try {
    // A producer opens its hold at the instant this backup opens its own: just before the operator's statement lands.
    const racing: CommandRunner = {
      run: async (command, args, options) => {
        const sql = args.includes('--command') ? args[args.indexOf('--command') + 1]! : '';
        if (sql.trimStart().startsWith('INSERT INTO recovery_holds') && sql.includes("'operator'")) {
          f.source.sqlite.run("INSERT OR IGNORE INTO recovery_holds(token, acquired_at, holder) VALUES ('00000000-0000-4000-8000-0000000race1', 1790000000000, 'producer')");
        }
        return f.runner.run(command, args, options);
      },
    };
    const failure = await f.backup({ runner: racing }).then(() => null, (error: Error) => error.message);
    expect(failure).toContain('an automatic backup of this Deployment has been running since');
    expect(f.exportCalls()).toEqual([]);
  } finally { f.cleanup(); }
});

it('refuses schema drift and leaves the artifact incomplete', async () => {
  const f = fixture();
  try {
    f.drift();
    await expect(f.backup()).rejects.toThrow('schema or configuration changed');
    expect(fs.existsSync(path.join(f.destination, 'myco.sqlite'))).toBe(false);
    expect(f.calls.some((call) => call.includes('get'))).toBe(false);
    // A snapshot that saw its source change is not a transient failure, so it is not captured again.
    expect(f.exports()).toHaveLength(1);
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
  // Every config rendered for a provider command, by the fleet it names: the hold's statements run under the one
  // rendered from the record captured at the start.
  let renderedFleet: string | null = null;
  const runner: CommandRunner = { run: async (command, args, options) => {
    if (args.includes('execute') && args.includes('-c')) {
      const vars = (Bun.TOML.parse(fs.readFileSync(args[args.indexOf('-c') + 1]!, 'utf8')) as { vars: Record<string, string> }).vars;
      renderedFleet = vars.MYCO_FLEET ?? renderedFleet;
    }
    return f.runner.run(command, args, options);
  } };
  const fetch: CloudflareFetch = f.fetchObject;
  const outcome = await backupCloudflareDeployment({ accountId: f.record.accountId, mycoHome: f.mycoHome, destination: f.destination, runner, fetch, d1Export: { pollMs: 0 } })
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

/** What `wrangler d1 execute --json` prints when the Cloudflare API refuses a request with `note`. */
const apiRefusal = (note: string) => ({ code: 1, stderr: '', stdout: JSON.stringify({ error: {
  text: 'A request to the Cloudflare API (/accounts/fixture-account/d1/database/fixture-database/query) failed.', notes: [{ text: note }],
} }) });
/** The account refusal D1 answers for an account and credential that other requests succeed with. */
const accountRefused = apiRefusal('The given account is not valid or is not authorized to access this service [code: 7403]');
const authenticationError = apiRefusal('Authentication error [code: 10000]');
/** What Wrangler prints when a request loses its connection or its name lookup. */
const connectionLost = { code: 1, stdout: '', stderr: '✘ [ERROR] fetch failed\n' };
/** What `wrangler d1 export` prints when its SQL download loses its connection. */
/** What Bun's fetch throws when its signal's timeout fires. */
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
    expect(reports.filter((line) => line.includes('attempt'))).toEqual([]);
    expect((await verifyRecoveryBundle(f.destination)).status).toBe('complete');
    expect(new Uint8Array(fs.readFileSync(path.join(f.destination, 'blobs', 'proj_1', f.digest)))).toEqual(f.bytes);
  } finally { f.cleanup(); }
});

it('logs in again after a login that timed out, and completes the backup on a later attempt', async () => {
  const f = fixture();
  try {
    let logins = 0;
    const runner: CommandRunner = { run: async (command, args, options) => {
      if (args.includes('auth') && ++logins === 1) throw new CommandTimedOut(command, args, options?.timeoutMs ?? 0, 'ended');
      return f.runner.run(command, args, options);
    } };
    const reports: string[] = [];
    const result = await f.backup({ runner, report: (line) => reports.push(line) });
    expect(result.status).toBe('complete');
    expect(logins).toBe(2);
    // The export is the first to need the operator's login, and its snapshot is captured again with a fresh one.
    expect(reports.filter((line) => line.includes('answered nothing in'))).toEqual([
      expect.stringContaining(`(attempt 2 of ${RECOVERY_RETRY.snapshots.attempts})`),
    ]);
    expect((await verifyRecoveryBundle(f.destination)).status).toBe('complete');
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

it('gives up on an object whose response never begins, naming its total network budget', async () => {
  const f = fixture();
  try {
    let reads = 0;
    const fetch: CloudflareFetch = async (input, init) => {
      if (String(input).endsWith(f.blobSource)) { reads += 1; throw timedOut(); }
      return f.fetchObject(input, init);
    };
    await expect(f.backup({ fetch })).rejects.toThrow('network unreachable after 15 minutes');
    expect(reads).toBeGreaterThan(RECOVERY_RETRY.objectReads.attempts);
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

/**
 * A server that answers each read of the blob with the body `answer` gives it, sent `content-encoding: gzip` whatever
 * the request asks for, and a fetch that sends the blob's reads to it. Bun decodes the body as it would R2's.
 */
function gzipServer(f: ReturnType<typeof fixture>, answer: (read: number) => Uint8Array) {
  let reads = 0;
  const server = Bun.serve({ port: 0, fetch() {
    const body = answer(++reads);
    // The body arrives and then the response ends, however much of the gzip stream it held.
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(body); controller.close(); } }),
      { headers: { 'content-encoding': 'gzip', 'content-type': 'application/octet-stream' } });
  } });
  const fetch: CloudflareFetch = async (input, init) => String(input).endsWith(f.blobSource)
    ? globalThis.fetch(`http://127.0.0.1:${server.port}/`, init) : f.fetchObject(input, init);
  return { fetch, reads: () => reads, stop: () => server.stop(true) };
}

it('retries a read whose gzip body was cut short, as Bun reports it, and completes a verified artifact', async () => {
  const f = fixture();
  const whole = gzipSync(f.bytes);
  const source = gzipServer(f, (read) => read === 1 ? whole.subarray(0, Math.floor(whole.length / 2)) : whole);
  try {
    const reports: string[] = [];
    const result = await f.backup({ fetch: source.fetch, report: (line) => reports.push(line) });
    expect(result.status).toBe('complete');
    expect(source.reads()).toBe(2);
    expect(reports.filter((line) => line.includes('ZlibError'))).toEqual([
      expect.stringContaining(`(attempt 2 of ${RECOVERY_RETRY.objectReads.attempts})`),
    ]);
    expect(new Uint8Array(fs.readFileSync(path.join(f.destination, 'blobs', 'proj_1', f.digest)))).toEqual(f.bytes);
    expect((await verifyRecoveryBundle(f.destination)).status).toBe('complete');
  } finally { source.stop(); f.cleanup(); }
});

it('fails at once on a gzip body that decodes whole but does not match its digest', async () => {
  const f = fixture();
  const wrong = f.bytes.map((byte) => byte ^ 0xff);
  const source = gzipServer(f, () => gzipSync(wrong));
  try {
    const failure = await f.backup({ fetch: source.fetch }).then(() => null, (error: Error) => error.message);
    expect(failure).toMatch(/was not stored: stored bytes do not match the declared sha256 digest$/);
    expect(source.reads()).toBe(1);
    expect(storedFiles(f.destination).filter((name) => name.startsWith('proj_1'))).toEqual([]);
  } finally { source.stop(); f.cleanup(); }
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

  /** A runner whose next `count` D1 statements fail as wrangler reports `failure` (a lost connection), and then answer. */
  const blip = (f: ReturnType<typeof fixture>, count: number, failure: { code: number; stdout: string; stderr: string } = connectionLost) => {
    const failed: string[] = [];
    const at: number[] = [];
    const runner: CommandRunner = { run: async (command, args, options) => {
      if (args.includes('execute') && failed.length < count) {
        at.push(performance.now());
        failed.push(args[args.indexOf('--command') + 1]!.trimStart().split(/\s+/)[0]!);
        return failure;
      }
      return f.runner.run(command, args, options);
    } };
    return { runner, failed, at };
  };

  it('rides out a blip that loses the write and every read back, and opens one hold', async () => {
    const f = fixture();
    try {
      const { runner, failed } = blip(f, 4);
      const reports: string[] = [];
      const result = await f.backup({ runner, report: (line) => reports.push(line) });
      expect(result.status).toBe('complete');
      // The write, then the three reads of its first round; the second round writes the same token and is answered.
      expect(failed).toEqual(['INSERT', 'SELECT', 'SELECT', 'SELECT']);
      expect(holds(f)).toEqual([{ token: expect.any(String), holder: 'operator', released: 1 }]);
      expect(reports.some((line) => line.includes(`by the same token`) && line.includes(`(attempt 2 of ${RECOVERY_RETRY.holdRounds.attempts})`))).toBe(true);
    } finally { f.cleanup(); }
  });

  it('rides out a blip that loses every read of a resume, and resumes under the hold it already took', async () => {
    const f = fixture();
    try {
      f.downloadFails(true);
      await expect(f.backup()).rejects.toThrow('HTTP 503');
      f.downloadFails(false);
      const token = JSON.parse(fs.readFileSync(path.join(f.destination, '.recovery-hold.json'), 'utf8')).token;
      const { runner, failed } = blip(f, 3);
      expect((await f.backup({ runner })).status).toBe('complete');
      expect(failed).toEqual(['SELECT', 'SELECT', 'SELECT']);
      expect(holds(f)).toEqual([{ token, holder: 'operator', released: 1 }]);
    } finally { f.cleanup(); }
  });

  it('rides out a transient account refusal on the write and every read back, and opens one hold', async () => {
    const f = fixture();
    try {
      const { runner, failed } = blip(f, 4, accountRefused);
      const reports: string[] = [];
      expect((await f.backup({ runner, report: (line) => reports.push(line) })).status).toBe('complete');
      expect(failed).toEqual(['INSERT', 'SELECT', 'SELECT', 'SELECT']);
      expect(holds(f)).toEqual([{ token: expect.any(String), holder: 'operator', released: 1 }]);
      expect(reports.some((line) => line.includes('did not answer about this backup\'s recovery hold (read 1 of') && line.includes('[code: 7403]'))).toBe(true);
    } finally { f.cleanup(); }
  });

  it('resumes through a transient account refusal on every read of a round', async () => {
    const f = fixture();
    try {
      f.downloadFails(true);
      await expect(f.backup()).rejects.toThrow('HTTP 503');
      f.downloadFails(false);
      const token = JSON.parse(fs.readFileSync(path.join(f.destination, '.recovery-hold.json'), 'utf8')).token;
      const { runner, failed } = blip(f, 3, accountRefused);
      expect((await f.backup({ runner })).status).toBe('complete');
      expect(failed).toEqual(['SELECT', 'SELECT', 'SELECT']);
      expect(holds(f)).toEqual([{ token, holder: 'operator', released: 1 }]);
    } finally { f.cleanup(); }
  });

  it('refuses a resume whose account refusal persists, saying the credential or account may be wrong', async () => {
    const f = fixture();
    try {
      f.downloadFails(true);
      await expect(f.backup()).rejects.toThrow('HTTP 503');
      f.downloadFails(false);
      const { runner, failed } = blip(f, Number.POSITIVE_INFINITY, accountRefused);
      const { attempts } = RECOVERY_RETRY.holdRounds;
      const failure = await f.backup({ runner }).then(() => null, (error: Error) => error.message);
      expect(failure).toContain(`recovery hold after ${attempts} attempts`);
      expect(failure).toContain('the source refused this account (code 7403), so the credential or the account may be wrong');
      expect(failed).toHaveLength(attempts * RECOVERY_RETRY.holdReads.attempts);
    } finally { f.cleanup(); }
  });

  it('waits between the reads that settle a hold, rather than spending them in one instant', async () => {
    const f = fixture();
    try {
      f.downloadFails(true);
      await expect(f.backup()).rejects.toThrow('HTTP 503');
      f.downloadFails(false);
      const { runner, at } = blip(f, 3);
      const retry = { ...IMMEDIATE_RETRY, holdReads: { attempts: 3, backoffMs: [60, 90] } };
      expect((await f.backup({ runner, retry })).status).toBe('complete');
      expect(at).toHaveLength(3);
      expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(55);
      expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(85);
    } finally { f.cleanup(); }
  });

  it('names another backup\'s open hold at once instead of waiting on a token that cannot open', async () => {
    const f = fixture();
    try {
      const other = crypto.randomUUID();
      f.source.sqlite.run("INSERT INTO recovery_holds(token, acquired_at, holder) VALUES (?, 1790000000000, 'operator')", [other]);
      let acquires = 0;
      const runner: CommandRunner = { run: async (command, args, options) => {
        if (isAcquire(args)) acquires += 1;
        return f.runner.run(command, args, options);
      } };
      await expect(f.backup({ runner })).rejects.toThrow(`another backup's recovery hold ${other} has been open on the source since 2026-09-21T`);
      await expect(f.backup({ runner })).rejects.toThrow(`myco server recovery-hold --token ${other} --abandon --target cloudflare`);
      expect(acquires).toBe(2);
      expect(holds(f)).toEqual([{ token: other, holder: 'operator', released: 0 }]);
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
      const { attempts } = RECOVERY_RETRY.holdRounds;
      await expect(f.backup({ runner })).rejects.toThrow(`recovery hold was not opened on the source (absent) after ${attempts} attempts; nothing was captured`);
      expect(acquires).toBe(attempts);
      expect(holds(f)).toEqual([]);
      expect(fs.existsSync(path.join(f.destination, 'myco.sqlite'))).toBe(false);
    } finally { f.cleanup(); }
  });
});

describe('a transient Cloudflare failure during the snapshot', () => {
  /** What the D1 API answers when it refuses a read with `code`. */
  const refusedRead = (code: number, message: string, status = 403) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
  /** The account refusal D1 answers for an account and credential that other requests succeed with. */
  const accountRefusedRead = () => refusedRead(7403, 'The given account is not valid or is not authorized to access this service');
  const authenticationErrorRead = () => refusedRead(10000, 'Authentication error');
  const unavailableRead = () => refusedRead(10001, 'Internal error', 503);
  /** An export download that loses its connection after sending part of the file. */
  const downloadLost = (): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "recovery_fixture" ("id","body","bytes") VALUES (999,\'partial\',NULL);\nINSERT INTO "sess'));
      controller.error(new TypeError('fetch failed'));
    },
  }), { headers: { 'content-length': '1000000' } });
  const captured = (f: ReturnType<typeof fixture>) => {
    const recovered = new Database(path.join(f.destination, 'myco.sqlite'), { readonly: true });
    try { return recovered.query('SELECT id, body FROM recovery_fixture').all(); } finally { recovered.close(); }
  };

  it('takes a downloaded export again when the reads after it fail past their own bound, and never exports a second time', async () => {
    const f = fixture();
    try {
      let schemaReads = 0;
      f.downloadFailsWith((_bookmark, attempt) => attempt === 1 ? downloadLost() : null);
      // The first attempt's read after its export is refused on every one of its tries.
      f.queryFailsWith((sql) => sql === SCHEMA_QUERY && ++schemaReads >= 2 && schemaReads <= 1 + D1_QUERY_ATTEMPTS ? accountRefusedRead() : null);
      const reports: string[] = [];
      const result = await f.backup({ report: (line) => reports.push(line) });
      expect(result.status).toBe('complete');
      // One export: its lost download fetched again inside the attempt, and its result taken again by the next attempt.
      expect({ exports: f.exports().map((job) => job.bookmark), downloads: f.downloads(), schemaReads }).toEqual({ exports: ['bm-1'], downloads: 2, schemaReads: 3 + D1_QUERY_ATTEMPTS });
      expect(reports.filter((line) => line.startsWith('Capturing the database snapshot failed'))).toEqual([
        expect.stringMatching(new RegExp(`\\[code: 7403\\].*starting it again in 0 s \\(attempt 2 of ${RECOVERY_RETRY.snapshots.attempts}\\)`)),
      ]);
      expect(reports.filter((line) => line.startsWith('Taking the D1 export this machine downloaded'))).toHaveLength(1);
      // Nothing of the partial download reached the artifact, and nothing of the export is kept once the snapshot is.
      expect(f.leftovers).toEqual([]);
      expect(captured(f)).toEqual([{ id: 3, body: f.body }]);
      expect(fs.readdirSync(path.join(f.mycoHome, 'server', 'cloudflare')).filter((name) => name.startsWith('d1-export-'))).toEqual([]);
      expect((await verifyRecoveryBundle(f.destination)).status).toBe('complete');
    } finally { f.cleanup(); }
  });

  it('takes a kept export only under the hold it was taken under, and gives it up with that hold', async () => {
    for (const next of ['another directory', 'abandon'] as const) {
      const f = fixture();
      try {
        let schemaReads = 0;
        // Every read after the export is refused past each capture's bound: the backup fails holding the export it downloaded.
        f.queryFailsWith((sql) => sql === SCHEMA_QUERY && ++schemaReads >= 2 ? accountRefusedRead() : null);
        await expect(f.backup()).rejects.toThrow();
        const kept = () => fs.readdirSync(path.join(f.mycoHome, 'server', 'cloudflare')).filter((name) => name.startsWith('d1-export-')).length;
        expect({ next, kept: kept(), exports: f.exports().length }).toEqual({ next, kept: 2, exports: 1 });
        f.queryFailsWith(() => null);
        if (next === 'abandon') {
          // Giving the hold up gives up what was kept under it.
          const owner = cloudflareRecoveryHoldOf({ accountId: f.record.accountId, mycoHome: f.mycoHome, runner: f.runner, fetch: f.fetchObject });
          expect((await abandonRecoveryHold(f.destination, owner)).state).toBe('released');
          expect(kept()).toBe(0);
          continue;
        }
        // That hold given up elsewhere, where nothing here heard of it: a backup into another directory captures under a
        // hold of its own, and the kept export is not its snapshot.
        const open = f.source.sqlite.query("SELECT token FROM recovery_holds WHERE holder = 'operator' AND released_at IS NULL").get() as { token: string };
        f.source.sqlite.exec(recoveryHoldSql.releaseOperator(open.token, Date.now(), 'abandoned'));
        const reports: string[] = [];
        const result = await f.backup({ destination: path.join(f.root, 'second'), report: (line) => reports.push(line) });
        expect({ status: result.status, exports: f.exports().length }).toEqual({ status: 'complete', exports: 2 });
        expect(reports.filter((line) => line.includes('taken under another recovery hold'))).toHaveLength(1);
        expect(kept()).toBe(0);
      } finally { f.cleanup(); }
    }
  });

  it('reads the schema again inside the read\'s own bound after one refusal, without failing the attempt', async () => {
    const f = fixture();
    try {
      let schemaReads = 0;
      f.queryFailsWith((sql) => sql === SCHEMA_QUERY && ++schemaReads === 2 ? accountRefusedRead() : null);
      const reports: string[] = [];
      expect((await f.backup({ report: (line) => reports.push(line) })).status).toBe('complete');
      expect({ exports: f.exports().length, schemaReads, captures: reports.filter((line) => line.startsWith('Capturing the database snapshot failed')).length })
        .toEqual({ exports: 1, schemaReads: 3, captures: 0 });
    } finally { f.cleanup(); }
  });

  it('waits the bound\'s backoff before each capture after the first', async () => {
    const f = fixture();
    try {
      const at: number[] = [];
      // Every try of the first schema read of the first two captures fails; the third capture's goes through.
      f.queryFailsWith((sql) => {
        if (sql !== SCHEMA_QUERY) return null;
        at.push(performance.now());
        return at.length <= 2 * D1_QUERY_ATTEMPTS ? unavailableRead() : null;
      });
      const retry = { ...IMMEDIATE_RETRY, snapshots: { attempts: 3, backoffMs: [60, 90] } };
      expect((await f.backup({ retry })).status).toBe('complete');
      // The first read of each capture, after the last of the one before it.
      const [first, second] = [D1_QUERY_ATTEMPTS, 2 * D1_QUERY_ATTEMPTS];
      expect(at[first]! - at[first - 1]!).toBeGreaterThanOrEqual(55);
      expect(at[second]! - at[second - 1]!).toBeGreaterThanOrEqual(85);
    } finally { f.cleanup(); }
  });

  it('caps new whole exports at two across snapshot retries and preserves the hold for a later run', async () => {
    const f = fixture();
    try {
      const fetch: CloudflareFetch = async (url, init) => {
        const answer = await f.fetchObject(url, init);
        if (url.startsWith('https://signed.fixture/d1/')) return new Response(null, { status: 404 });
        const bookmark = url.endsWith('/export') ? JSON.parse(String(init.body)).current_bookmark : undefined;
        if (bookmark && f.exports().find((job) => job.bookmark === bookmark)!.polls > 1) {
          return Response.json({ success: true, result: { success: true, status: 'error', error: 'provider reset' } });
        }
        return answer;
      };
      await expect(f.backup({ fetch })).rejects.toThrow('new D1 export limit (2) reached');
      expect(f.exports()).toHaveLength(2);
      expect(f.source.sqlite.query('SELECT released_at FROM recovery_holds WHERE holder=\'operator\'').all()).toEqual([{ released_at: null }]);
      expect(JSON.parse(fs.readFileSync(path.join(f.destination, 'recovery.json'), 'utf8')).status).toBe('snapshot');
      expect((await f.backup()).status).toBe('complete');
      expect(f.exports()).toHaveLength(3);
    } finally { f.cleanup(); }
  });

  it('keeps the production snapshot bound: four captures, waiting 15 s, 60 s and 120 s between them', () => {
    expect(RECOVERY_RETRY.snapshots).toEqual({ attempts: 4, backoffMs: [15_000, 60_000, 120_000] });
  });

  it('compares the schema reads of one attempt only, never one attempt\'s with another\'s', async () => {
    const f = fixture();
    try {
      let schemaReads = 0;
      f.queryFailsWith((sql) => {
        if (sql !== SCHEMA_QUERY) return null;
        schemaReads += 1;
        // Every try of the first attempt's read after its export fails, and a deploy changes the schema before the next attempt.
        if (schemaReads === 2) f.source.sqlite.exec('CREATE TABLE changed_schema(id TEXT)');
        return schemaReads >= 2 && schemaReads <= 1 + D1_QUERY_ATTEMPTS ? unavailableRead() : null;
      });
      const result = await f.backup();
      expect(result.status).toBe('complete');
      // The downloaded export carries the schema from before the deploy, so it is discarded and one taken again.
      expect(f.exports()).toHaveLength(2);
      const recovered = new Database(path.join(f.destination, 'myco.sqlite'), { readonly: true });
      try {
        expect(recovered.query("SELECT name FROM sqlite_master WHERE name = 'changed_schema'").all()).toEqual([{ name: 'changed_schema' }]);
      } finally { recovered.close(); }
    } finally { f.cleanup(); }
  });

  it('gives up after its bound when every export download fails, naming the attempts, and a later run never uses the partial file', async () => {
    const f = fixture();
    try {
      f.downloadFailsWith(() => downloadLost());
      const { attempts } = RECOVERY_RETRY.snapshots;
      const failure = await f.backup().then(() => null, (error: Error) => error.message);
      expect(failure).toStartWith(`the database snapshot was not captured after ${attempts} attempts: `);
      expect(failure).toContain('stopped before it arrived');
      expect(failure).not.toContain('refused this account');
      // Every attempt fetches the one export's result, each as many times as the download allows; none starts a second.
      expect({ exports: f.exports().length, downloads: f.downloads() }).toEqual({ exports: 1, downloads: attempts * D1_EXPORT_DOWNLOAD_ATTEMPTS });
      expect(JSON.parse(fs.readFileSync(path.join(f.destination, 'recovery.json'), 'utf8')).status).toBe('snapshot');
      expect(fs.existsSync(path.join(f.destination, 'myco.sqlite'))).toBe(false);
      // The last attempt's partial download is gone with its work directory's next emptying; the next run resumes the export.
      f.downloadFailsWith(() => null);
      expect((await f.backup()).status).toBe('complete');
      expect(f.exports()).toHaveLength(1);
      expect(f.leftovers).toEqual([]);
      expect(captured(f)).toEqual([{ id: 3, body: f.body }]);
      expect((await verifyRecoveryBundle(f.destination)).status).toBe('complete');
    } finally { f.cleanup(); }
  });

  it('stops an export that never completes at its bound, names why, and never starts a second one in a retry (#1455)', async () => {
    const f = fixture();
    try {
      f.exportStays(() => true);
      let clock = 0;
      const d1Export = { pollMs: 0, boundMs: 30 * 60_000, now: () => clock, sleep: async () => { clock += 60_000; } };
      const failure = await f.backup({ d1Export }).then(() => null, (error: Error) => error.message);
      expect(failure).toStartWith('the D1 export started ');
      expect(failure).toContain('did not finish within 30 min');
      expect(failure).toContain('no second export was started');
      // An export that may still be live is not a transient failure: the #1452 retry does not start another.
      expect(f.exports()).toHaveLength(1);
      // The next backup asks after the same export, and still starts none while it runs.
      await expect(f.backup({ d1Export })).rejects.toThrow('did not finish within 30 min');
      expect(f.exports()).toHaveLength(1);
      expect(f.exportCalls().at(-1)).toEqual({ bookmark: 'bm-1' });
    } finally { f.cleanup(); }
  });

  it('settles the export a backup left running before it reads the schema, which that export pauses (#1455 F5)', async () => {
    const f = fixture();
    try {
      f.exportStays(() => true);
      let clock = 0;
      const d1Export = { pollMs: 0, boundMs: 30 * 60_000, now: () => clock, sleep: async () => { clock += 60_000; } };
      await expect(f.backup({ d1Export })).rejects.toThrow('did not finish within 30 min');
      f.exportStays(() => false);
      // What the export API had been asked by the time the next backup first reads the schema.
      const askedAtSchemaRead: Array<Array<string | null>> = [];
      f.queryFailsWith((sql) => {
        if (sql === SCHEMA_QUERY) askedAtSchemaRead.push(f.exportCalls().map((call) => call.bookmark));
        return null;
      });
      const before = f.exportCalls().length;
      // A bound the first export completes inside, so its result is this snapshot.
      expect((await f.backup({ d1Export: { ...d1Export, boundMs: 60 * 60_000 } })).status).toBe('complete');
      expect(askedAtSchemaRead[0]!.slice(before)).toEqual(['bm-1']);
      expect(f.exports()).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  it('completes after a single account refusal on its schema read', async () => {
    const f = fixture();
    try {
      let schemaReads = 0;
      f.queryFailsWith((sql) => sql === SCHEMA_QUERY && ++schemaReads === 1 ? accountRefusedRead() : null);
      expect((await f.backup()).status).toBe('complete');
      expect(schemaReads).toBe(3);
      expect(f.exports()).toHaveLength(1);
      expect((await verifyRecoveryBundle(f.destination)).status).toBe('complete');
    } finally { f.cleanup(); }
  });

  it('fails an account refusal that persists after its bound, saying the credential or account may be wrong', async () => {
    const f = fixture();
    try {
      let schemaReads = 0;
      f.queryFailsWith((sql) => sql === SCHEMA_QUERY ? (schemaReads += 1, accountRefusedRead()) : null);
      const { attempts } = RECOVERY_RETRY.snapshots;
      const failure = await f.backup().then(() => null, (error: Error) => error.message);
      expect(failure).toStartWith(`the database snapshot was not captured after ${attempts} attempts: `);
      expect(failure).toEndWith('; the source refused this account (code 7403), so the credential or the account may be wrong');
      expect(schemaReads).toBe(attempts * D1_QUERY_ATTEMPTS);
      expect(f.exports()).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  it('fails at once on an authentication error, without capturing again', async () => {
    const f = fixture();
    try {
      let schemaReads = 0;
      f.queryFailsWith((sql) => sql === SCHEMA_QUERY ? (schemaReads += 1, authenticationErrorRead()) : null);
      const failure = await f.backup().then(() => null, (error: Error) => error.message);
      expect(failure).toStartWith('the database snapshot was not captured: ');
      expect(failure).toEndWith('; the source refused this account (code 10000), so the credential or the account may be wrong');
      // The refused login is refreshed once, and the read is not sent again after that.
      expect(schemaReads).toBe(2);
    } finally { f.cleanup(); }
  });
});

it('ends the source read when the destination fails to store its bytes', async () => {
  const f = fixture();
  const original = blobs.diskBlobStore;
  // The destination volume fills after taking the first bytes of the object, while the store still holds its body.
  const full = spyOn(blobs, 'diskBlobStore').mockImplementation((root) => {
    const store = original(root);
    return { ...store, put: async (key, body, options) => {
      if (!key.startsWith('proj_1/') || body === null) return store.put(key, body, options);
      await body.getReader().read();
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    } };
  });
  try {
    let signal: AbortSignal | undefined;
    const fetch: CloudflareFetch = async (input, init) => {
      if (!String(input).endsWith(f.blobSource)) return f.fetchObject(input, init);
      signal = init.signal ?? undefined;
      // A body that sends its first bytes and then waits on the connection for the rest.
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(f.bytes.slice(0, 2)); } }));
    };
    await expect(f.backup({ fetch })).rejects.toThrow('was not stored: no space left on device');
    expect(signal?.aborted).toBe(true);
  } finally { full.mockRestore(); f.cleanup(); }
});

describe('hosted backup connection outage budget', () => {
  function outage(f: ReturnType<typeof fixture>, clock: ReturnType<typeof simulatedNetwork>, answer: () => Response, duration = 10 * 60_000) {
    let connections = 0;
    let responses = 0;
    const fetch: CloudflareFetch = async (url, init) => {
      if (!url.endsWith(f.blobSource)) return f.fetchObject(url, init);
      if (clock.at < duration) {
        connections++;
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('DNS lookup failed'), { code: 'EAI_AGAIN' }) });
      }
      responses++;
      return answer();
    };
    return { fetch, connections: () => connections, responses: () => responses };
  }

  it('completes and verifies a backup when a connection outage clears after ten simulated minutes', async () => {
    const f = fixture();
    try {
      const clock = simulatedNetwork();
      const api = outage(f, clock, () => new Response(f.bytes));
      expect((await f.backup({ fetch: api.fetch, networkRetry: clock.retry })).status).toBe('complete');
      expect(clock.at).toBeGreaterThanOrEqual(10 * 60_000);
      expect(clock.at).toBeLessThan(15 * 60_000);
      expect(api.connections()).toBeGreaterThan(RECOVERY_RETRY.objectReads.attempts);
      expect((await verifyRecoveryBundle(f.destination)).status).toBe('complete');
      expect(clock.pauses.every((ms) => ms > 0 && ms <= cloudflare.OPERATOR_NETWORK_BACKOFF_MAX_MS)).toBe(true);
    } finally { f.cleanup(); }
  });

  it('fails a persistent connection outage after fifteen minutes without restarting the budget', async () => {
    const f = fixture();
    try {
      const clock = simulatedNetwork();
      const api = outage(f, clock, () => new Response(f.bytes), Infinity);
      await expect(f.backup({ fetch: api.fetch, networkRetry: clock.retry })).rejects.toThrow('network unreachable after 15 minutes');
      expect(clock.at).toBe(cloudflare.OPERATOR_NETWORK_RETRY_BUDGET_MS);
      expect(api.responses()).toBe(0);
      expect(api.connections()).toBeGreaterThan(RECOVERY_RETRY.objectReads.attempts);
    } finally { f.cleanup(); }
  });

  it('retains the six-attempt HTTP 500 bound after a connection outage clears', async () => {
    const f = fixture();
    try {
      const clock = simulatedNetwork();
      const api = outage(f, clock, () => new Response('unavailable', { status: 500 }));
      await expect(f.backup({ fetch: api.fetch, networkRetry: clock.retry })).rejects.toThrow('after 6 attempts');
      expect(api.responses()).toBe(RECOVERY_RETRY.objectReads.attempts);
      expect(api.connections()).toBeGreaterThan(RECOVERY_RETRY.objectReads.attempts);
      expect(clock.at).toBeLessThan(cloudflare.OPERATOR_NETWORK_RETRY_BUDGET_MS);
    } finally { f.cleanup(); }
  });

  it('fails a checksum mismatch immediately after a connection outage clears', async () => {
    const f = fixture();
    try {
      const clock = simulatedNetwork();
      const api = outage(f, clock, () => new Response(new Uint8Array([9, 9, 9, 9, 9])));
      await expect(f.backup({ fetch: api.fetch, networkRetry: clock.retry })).rejects.toThrow('sha256');
      expect(api.responses()).toBe(1);
      expect(api.connections()).toBeGreaterThan(RECOVERY_RETRY.objectReads.attempts);
      expect(storedFiles(f.destination).filter((name) => name.startsWith('proj_1'))).toEqual([]);
    } finally { f.cleanup(); }
  });

  it('reports a continuing outage at most once per simulated minute', async () => {
    const f = fixture();
    try {
      const clock = simulatedNetwork();
      const api = outage(f, clock, () => new Response(f.bytes));
      const reports: { at: number; line: string }[] = [];
      await f.backup({ fetch: api.fetch, networkRetry: clock.retry, report: (line) => {
        if (line.startsWith('network unreachable;')) reports.push({ at: clock.at, line });
      } });
      expect(reports.length).toBeGreaterThan(0);
      for (let i = 0; i < reports.length; i++) {
        expect(reports[i]!.line).toBe(`network unreachable; still retrying (${Math.floor(reports[i]!.at / 60_000)}m)`);
        expect(reports[i]!.at - (reports[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(60_000);
      }
    } finally { f.cleanup(); }
  });
});


it('keeps one object deadline when a fourteen-minute outage clears and the response body then resets', async () => {
  const f = fixture();
  try {
    const clock = simulatedNetwork();
    let answered = false;
    let responses = 0;
    const fetch: CloudflareFetch = async (url, init) => {
      if (!url.endsWith(f.blobSource)) return f.fetchObject(url, init);
      if (clock.at >= 14 * 60_000 && !answered) {
        answered = true;
        responses++;
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(f.bytes.slice(0, 2));
          controller.error(Object.assign(new Error('response body reset'), { code: 'ECONNRESET' }));
        } }));
      }
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('DNS outage returned'), { code: 'EAI_AGAIN' }) });
    };
    const failure = await f.backup({ fetch, networkRetry: clock.retry }).then(() => '', (error: unknown) => String(error));
    expect(responses).toBe(1);
    expect(failure).toContain('network unreachable after 15 minutes');
    expect(failure).toContain(f.blobSource);
    expect(failure).toContain('DNS outage returned');
    expect(clock.at).toBe(cloudflare.OPERATOR_NETWORK_RETRY_BUDGET_MS);
    expect(storedFiles(f.destination).filter((name) => name.startsWith('proj_1'))).toEqual([]);
  } finally { f.cleanup(); }
});


it('gives each backup object its own connection retry budget', async () => {
  const f = fixture();
  try {
    const clock = simulatedNetwork();
    const started = new Map<string, number>();
    const fetch: CloudflareFetch = async (url, init) => {
      const key = [f.blobSource, f.backupKey].find((candidate) => url.endsWith(candidate));
      if (key === undefined) return f.fetchObject(url, init);
      if (!started.has(key)) started.set(key, clock.at);
      if (clock.at - started.get(key)! < 10 * 60_000) throw Object.assign(new Error('DNS unavailable'), { code: 'EAI_AGAIN' });
      return f.fetchObject(url, init);
    };
    expect((await f.backup({ fetch, networkRetry: clock.retry })).status).toBe('complete');
    expect(started.size).toBe(2);
    expect(clock.at).toBeGreaterThanOrEqual(20 * 60_000);
    expect((await verifyRecoveryBundle(f.destination)).status).toBe('complete');
  } finally { f.cleanup(); }
});

it('retains HTTP attempt bounds after a healthy long body outlasts an earlier connection budget', async () => {
  const f = fixture();
  try {
    const clock = simulatedNetwork();
    let answered = false;
    let httpFailures = 0;
    const fetch: CloudflareFetch = async (url, init) => {
      if (!url.endsWith(f.blobSource)) return f.fetchObject(url, init);
      if (answered) { httpFailures++; return new Response(null, { status: 500 }); }
      if (clock.at < 14 * 60_000) throw Object.assign(new Error('DNS unavailable'), { code: 'EAI_AGAIN' });
      answered = true;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(f.bytes.slice(0, 2));
        clock.advance(20 * 60_000);
        controller.error(Object.assign(new Error('body reset'), { code: 'ECONNRESET' }));
      } }));
    };
    await expect(f.backup({ fetch, networkRetry: clock.retry })).rejects.toThrow('after 6 attempts: Cloudflare object read failed');
    expect(httpFailures).toBe(RECOVERY_RETRY.objectReads.attempts - 1);
  } finally { f.cleanup(); }
});
