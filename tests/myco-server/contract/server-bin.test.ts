/**
 * The self-hosted process entry.
 *
 * Two things are asserted here that nothing else covers:
 *
 * `migrateOnly` is the only production path that applies migrations for this
 * target. Every other caller of the migration renderer is a test, and the
 * request handler refuses a volume that is behind rather than migrating it, so
 * this function is what makes a self-hosted deployment servable at all.
 *
 * The startup refusals turn a per-request failure into one startup failure. A
 * deployment declaring a proxy source without a trusted header, or with fewer
 * than one trusted hop, establishes no source identity at all
 * (`platform/bun/source.ts:59`), and the core answers 503 to every request
 * while the container reports healthy.
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitFailureLine, LIVE_RUNS_QUERY, main, migrateOnly } from '@myco-server-worker/platform/bun/server-main.js';
import { LIVE_RUN_STATUSES } from '@myco-server-worker/core/runs.js';
import { bunPlatform } from '@myco-server-worker/platform/bun/env.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';

const roots: string[] = [];
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'myco-bun-main-'));
  roots.push(root);
  return root;
};
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const TOUCHED = [
  'MYCO_BIND',
  'MYCO_DATABASE', 'MYCO_BLOB_DIR', 'MYCO_PORT', 'MYCO_TRANSPORT',
  'MYCO_SOURCE_FROM', 'MYCO_TRUSTED_HEADER', 'MYCO_TRUSTED_HOPS',
  'SECRET_WRAP_KEY', 'SECRET_WRAP_KEY_FILE',
  'MYCO_HARNESS', 'MYCO_HARNESS_TOKEN', 'MYCO_HARNESS_TOKEN_FILE',
] as const;
afterEach(() => { for (const key of TOUCHED) delete process.env[key]; });

describe('migrateOnly', () => {
  it('brings a fresh volume to a servable schema', () => {
    const path = join(scratch(), 'myco.sqlite');
    migrateOnly(path);

    const sqlite = new Database(path);
    const tables = sqlite.query(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    ).all() as { name: string }[];
    sqlite.close();

    expect(tables.length).toBeGreaterThan(0);
    expect(tables.map((t) => t.name)).toContain('projects');
  });

  it('is idempotent — the entrypoint runs it on every container start', () => {
    const path = join(scratch(), 'myco.sqlite');
    const first = migrateOnly(path);
    expect(first).toBeGreaterThan(0);

    // A second pass applies nothing, leaving the CREATE TABLE statements alone.
    expect(migrateOnly(path)).toBe(0);
    expect(migrateOnly(path)).toBe(0);
  });

  it('applies only the steps a partially-migrated volume is behind', () => {
    const path = join(scratch(), 'myco.sqlite');
    const total = migrateOnly(path);

    // Wind the stamp back one step; only that step should re-apply.
    const sqlite = new Database(path);
    sqlite.query(`UPDATE schema_meta SET value = ? WHERE key = 'version'`).run(String(total - 1));
    sqlite.close();

    expect(migrateOnly(path)).toBe(1);
  });
});

/** Brings a volume to `version` as `migrateOnly` would, one transaction per step, so a test can seed rows a step then migrates. */
function migrateTo(path: string, version: number): Database {
  const sqlite = new Database(path, { create: true });
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const step of SCHEMA_STEPS.filter((s) => s.version <= version)) sqlite.transaction(() => { for (const sql of step.statements) sqlite.exec(sql); })();
  return sqlite;
}

/** Credentials at the retired 1 GiB ceiling, a successor lineage, and every table that references a credential holding a row that does. */
function seedCredentials(sqlite: Database): void {
  sqlite.exec(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'one', 0)`);
  sqlite.exec(`INSERT INTO members (id, label, created_at, revoked_at) VALUES ('mem_1', 'one', 0, NULL)`);
  sqlite.exec(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, issued_at, expires_at, revoked_at, lineage_root, lineage_started_at, predecessor_id, first_used_at, bytes_written, revoked_by)
    VALUES ('mt_root', 'mem_1', 'h_root', 'machine_1', 1, 2, 3, 'mt_root', 1, NULL, NULL, 1073712707, 'mem_1'),
           ('mt_next', 'mem_1', 'h_next', 'machine_1', 3, 9999999999999, NULL, 'mt_root', 1, 'mt_root', 4, 1073741824, NULL)`);
  sqlite.exec(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'one', 'built-in', 1, 0)`);
  sqlite.exec(`INSERT INTO agent_runs (project_id, id, agent_id, status, started_at, dispatched_by, leased_by) VALUES ('proj_1', 'run_1', 'agent_1', 'completed', 1, 'mt_root', 'mt_next')`);
  sqlite.exec(`INSERT INTO worker_contacts (credential_id, machine_id, last_seen_at, updated_at) VALUES ('mt_next', 'machine_1', 1, 1)`);
}

const credentialRows = (sqlite: Database) => sqlite.query('SELECT * FROM member_credentials ORDER BY id').all();
const referencingRows = (sqlite: Database) => ({
  runs: sqlite.query('SELECT id, dispatched_by, leased_by FROM agent_runs ORDER BY id').all(),
  contacts: sqlite.query('SELECT credential_id FROM worker_contacts ORDER BY credential_id').all(),
});

describe('migrateOnly across step 48 (#1416)', () => {
  it('migrates a v47 volume whose credentials are referenced: every row, counter and reference kept, the byte CHECK gone, foreign keys still enforced', () => {
    const path = join(scratch(), 'myco.sqlite');
    const v47 = migrateTo(path, 47);
    seedCredentials(v47);
    expect(() => v47.exec(`UPDATE member_credentials SET bytes_written = 1073741825 WHERE id = 'mt_next'`)).toThrow(/member_tokens_quota/);
    const rows = credentialRows(v47);
    const refs = referencingRows(v47);
    v47.close();

    expect(migrateOnly(path)).toBe(1);

    const sqlite = new Database(path);
    sqlite.exec('PRAGMA foreign_keys = ON');
    expect(sqlite.query(`SELECT value FROM schema_meta WHERE key = 'version'`).get()).toEqual({ value: '48' });
    expect(credentialRows(sqlite)).toEqual(rows);
    expect(referencingRows(sqlite)).toEqual(refs);
    expect(sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect((sqlite.query(`SELECT sql FROM sqlite_master WHERE name = 'member_credentials'`).get() as { sql: string }).sql).not.toMatch(/CHECK/);
    expect((sqlite.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'member_credentials' ORDER BY name`).all() as { name: string }[]).map((r) => r.name))
      .toEqual(['idx_member_credentials_hash', 'idx_member_credentials_lineage', 'idx_member_credentials_live_successor', 'idx_member_credentials_member', 'idx_member_credentials_started', 'sqlite_autoindex_member_credentials_1']);
    expect(sqlite.query(`SELECT name FROM sqlite_master WHERE name LIKE '_v48_%'`).all()).toEqual([]);
    sqlite.exec(`UPDATE member_credentials SET bytes_written = 5000000000 WHERE id = 'mt_next'`);
    expect(sqlite.query(`SELECT bytes_written FROM member_credentials WHERE id = 'mt_next'`).get()).toEqual({ bytes_written: 5_000_000_000 });
    expect(() => sqlite.exec(`INSERT INTO agent_runs (project_id, id, agent_id, status, started_at, dispatched_by) VALUES ('proj_1', 'run_2', 'agent_1', 'completed', 1, 'mt_absent')`)).toThrow(/FOREIGN KEY/);
    sqlite.close();
  });

  it('rolls a step that fails part-way back whole: the volume stays at 47 with every row, and applies cleanly once the fault is gone', () => {
    const path = join(scratch(), 'myco.sqlite');
    const v47 = migrateTo(path, 47);
    seedCredentials(v47);
    const rows = credentialRows(v47);
    // A view under the guard's name fails the step after it has dropped and re-created the credential table.
    v47.exec(`CREATE VIEW _v48_guard_rows_kept AS SELECT 1 AS ok`);
    v47.close();

    expect(() => migrateOnly(path)).toThrow();
    const after = new Database(path);
    expect(after.query(`SELECT value FROM schema_meta WHERE key = 'version'`).get()).toEqual({ value: '47' });
    expect(credentialRows(after)).toEqual(rows);
    expect((after.query(`SELECT sql FROM sqlite_master WHERE name = 'member_credentials'`).get() as { sql: string }).sql).toMatch(/member_tokens_quota/);
    expect(after.query(`SELECT name FROM sqlite_master WHERE name = '_v48_guard_credential_rows'`).all()).toEqual([]);
    after.exec(`DROP VIEW _v48_guard_rows_kept`);
    after.close();

    expect(migrateOnly(path)).toBe(1);
    const healed = new Database(path);
    expect(credentialRows(healed)).toEqual(rows);
    healed.close();
  });

  it('walks the whole chain natively from a v1 volume holding a credential to the build\'s version', () => {
    const path = join(scratch(), 'myco.sqlite');
    const v1 = migrateTo(path, 1);
    v1.exec(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'one', 0)`);
    v1.exec(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at, revoked_at, bytes_written) VALUES ('mt_1', 'proj_1', 'machine_1', 'h', 9999999999999, NULL, 1073741824)`);
    v1.close();

    expect(migrateOnly(path)).toBe(SCHEMA_STEPS.length - 1);
    const sqlite = new Database(path);
    expect(sqlite.query(`SELECT value FROM schema_meta WHERE key = 'version'`).get()).toEqual({ value: String(SERVER_SCHEMA_VERSION) });
    expect(sqlite.query(`SELECT id, machine_id, bytes_written FROM member_credentials`).all()).toEqual([{ id: 'mt_1', machine_id: 'machine_1', bytes_written: 1073741824 }]);
    expect(sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
    sqlite.close();
  });
});

describe('startup refusals', () => {
  const volume = () => {
    const root = scratch();
    return { MYCO_DATABASE: join(root, 'myco.sqlite'), MYCO_BLOB_DIR: join(root, 'blobs') };
  };

  it('refuses an unknown transport rather than defaulting to one', async () => {
    Object.assign(process.env, volume(), { MYCO_TRANSPORT: 'public' });
    await expect(main()).rejects.toThrow(/MYCO_TRANSPORT/);
  });

  it('refuses a proxy source with no trusted header', async () => {
    Object.assign(process.env, volume(), { MYCO_SOURCE_FROM: 'proxy' });
    await expect(main()).rejects.toThrow(/MYCO_TRUSTED_HEADER/);
  });

  it('refuses a proxy source with zero trusted hops, which establishes no identity', async () => {
    Object.assign(process.env, volume(), {
      MYCO_SOURCE_FROM: 'proxy',
      MYCO_TRUSTED_HEADER: 'x-forwarded-for',
      MYCO_TRUSTED_HOPS: '0',
    });
    await expect(main()).rejects.toThrow(/MYCO_TRUSTED_HOPS/);
  });

  it('refuses a missing database path', async () => {
    process.env.MYCO_BLOB_DIR = join(scratch(), 'blobs');
    await expect(main()).rejects.toThrow(/MYCO_DATABASE/);
  });

  it('refuses a non-numeric port instead of silently falling back', async () => {
    Object.assign(process.env, volume(), { MYCO_PORT: 'eight-thousand' });
    await expect(main()).rejects.toThrow(/MYCO_PORT/);
  });
});

describe('secrets arrive as files', () => {
  it('reads a value from the file its *_FILE variable names', async () => {
    const root = scratch();
    const secretPath = join(root, 'wrap_key');
    writeFileSync(secretPath, '  dGVzdC1rZXk=  \n');
    process.env.SECRET_WRAP_KEY_FILE = secretPath;
    process.env.MYCO_DATABASE = join(root, 'myco.sqlite');
    process.env.MYCO_BLOB_DIR = join(root, 'blobs');
    process.env.MYCO_PORT = '0';
    migrateOnly(process.env.MYCO_DATABASE);

    // A clean start proves the file is read and trimmed, not passed through
    // with its surrounding whitespace.
    const started = await main();
    expect(started?.port).toBeGreaterThan(0);
    await started?.stop();
  });

  it('refuses when *_FILE names a file it cannot read', async () => {
    const root = scratch();
    process.env.SECRET_WRAP_KEY_FILE = join(root, 'absent');
    process.env.MYCO_DATABASE = join(root, 'myco.sqlite');
    process.env.MYCO_BLOB_DIR = join(root, 'blobs');
    await expect(main()).rejects.toThrow(/SECRET_WRAP_KEY_FILE/);
  });
});

/**
 * The one seam that makes a self-hosted deployment able to run anything.
 *
 * `MYCO_HARNESS` names the supervisor this deployment launches runtimes
 * through. The endpoint spawns processes with a caller-chosen environment, so
 * it is authenticated, and a deployment that names a supervisor without a token
 * would answer every dispatch with a refusal it only discovered at launch time.
 */
describe('the harness runtime', () => {
  const volume = () => {
    const root = scratch();
    return { MYCO_DATABASE: join(root, 'myco.sqlite'), MYCO_BLOB_DIR: join(root, 'blobs') };
  };
  const tokenFile = (contents: string): string => {
    const path = join(scratch(), 'harness_token');
    writeFileSync(path, contents);
    return path;
  };

  it('refuses an address that is not an http or https URL', async () => {
    for (const address of ['harness:8080', 'ws://harness:8080', '/run/harness.sock']) {
      Object.assign(process.env, volume(), { MYCO_HARNESS: address, MYCO_HARNESS_TOKEN: 'tok' });
      await expect(main()).rejects.toThrow(/MYCO_HARNESS must be an http/);
    }
  });

  it('refuses a deployment that names a supervisor and no token', async () => {
    Object.assign(process.env, volume(), { MYCO_HARNESS: 'http://127.0.0.1:8080' });
    await expect(main()).rejects.toThrow(/MYCO_HARNESS_TOKEN/);
  });

  it('refuses a token file it cannot read, and one that holds nothing', async () => {
    Object.assign(process.env, volume(), {
      MYCO_HARNESS: 'http://127.0.0.1:8080',
      MYCO_HARNESS_TOKEN_FILE: join(scratch(), 'absent'),
    });
    await expect(main()).rejects.toThrow(/MYCO_HARNESS_TOKEN_FILE/);

    Object.assign(process.env, volume(), {
      MYCO_HARNESS: 'http://127.0.0.1:8080',
      MYCO_HARNESS_TOKEN_FILE: tokenFile('   \n'),
    });
    await expect(main()).rejects.toThrow(/MYCO_HARNESS_TOKEN_FILE names an empty file/);
  });

  it('starts with a supervisor address and the token file both services mount, and tells the runtime the port it bound', async () => {
    const launches: { envVars: Record<string, string> }[] = [];
    const supervisor = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      development: false,
      fetch: async (request) => {
        launches.push(await request.json() as { envVars: Record<string, string> });
        return Response.json({}, { status: 202 });
      },
    });

    const env = volume();
    Object.assign(process.env, env, {
      // The kernel chooses the port, so the requested one is not the one a
      // runtime has to call back to.
      MYCO_PORT: '0',
      MYCO_HARNESS: `http://127.0.0.1:${supervisor.port}`,
      MYCO_HARNESS_TOKEN_FILE: tokenFile('  supervisor-token  \n'),
    });
    migrateOnly(env.MYCO_DATABASE);

    const started = await main();
    try {
      expect(started?.port).toBeGreaterThan(0);
      expect(started?.harnessLaunch).toBeDefined();
      await started!.harnessLaunch!({ runId: 'run_1', timeoutSeconds: 120, envVars: { MYCO_SERVER_URL: 'https://elsewhere.example' } });
      expect(launches[0]!.envVars.MYCO_SERVER_URL).toBe(`http://127.0.0.1:${started!.port}`);
    } finally {
      await started?.stop();
      supervisor.stop(true);
    }
  });

  it('binds no launch when it names no supervisor', async () => {
    const env = volume();
    Object.assign(process.env, env, { MYCO_PORT: '0' });
    migrateOnly(env.MYCO_DATABASE);
    const started = await main();
    try {
      expect(started?.harnessLaunch).toBeUndefined();
    } finally {
      await started?.stop();
    }
  });

  it('reports the capability present once a launch is bound, naming what an operator sets', () => {
    const absent = bunPlatform({ sqlite: undefined as never, blobDir: '/tmp/x' }).capabilities();
    expect(absent.find((c) => c.capability === 'harness-runtime'))
      .toEqual({ capability: 'harness-runtime', label: 'Harness runtime', present: false, operatorNames: ['MYCO_HARNESS', 'MYCO_HARNESS_TOKEN_FILE'] });

    const bound = bunPlatform({ sqlite: undefined as never, blobDir: '/tmp/x', harnessLaunch: async () => {} }).capabilities();
    expect(bound.find((c) => c.capability === 'harness-runtime')?.present).toBe(true);
  });
});

describe('bind mode', () => {
  it('refuses an unknown bind mode rather than defaulting to one', async () => {
    const root = scratch();
    Object.assign(process.env, {
      MYCO_DATABASE: join(root, 'myco.sqlite'),
      MYCO_BLOB_DIR: join(root, 'blobs'),
      MYCO_BIND: 'everywhere',
    });
    await expect(main()).rejects.toThrow(/MYCO_BIND/);
  });
});

/**
 * What a deploy asks the running container before it recreates it.
 *
 * The self-hosted update reads this through `docker compose exec`, and a run it
 * cannot see is a run the recreate ships over.
 */
describe('the live-runs read', () => {
  /** A migrated volume holding one run per status named. */
  const volumeWith = (runs: { id: string; status: string; task: string | null; startedAt: number | null; context: string | null; queuedAt?: number | null; dispatchedBy?: string | null }[]): string => {
    const path = join(scratch(), 'myco.sqlite');
    migrateOnly(path);
    const sqlite = new Database(path);
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'p', 1)`).run();
    sqlite.query(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, 1)`).run();
    sqlite.query(`INSERT INTO members (id, label, created_at, revoked_at) VALUES ('mem_harness', 'harness', 1, NULL)`).run();
    sqlite.query(`INSERT INTO member_credentials (id, member_id, token_hash, issued_at, expires_at, lineage_root, lineage_started_at) VALUES ('cred_live', 'mem_harness', 'h', 1, 9999999999999, 'cred_live', 1)`).run();
    for (const run of runs) {
      sqlite.query(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, queued_at, run_context, dispatched_by)
        VALUES ('proj_1', ?, 'agent_1', ?, ?, ?, ?, ?, ?)`)
        .run(run.id, run.task, run.status, run.startedAt, run.queuedAt ?? null, run.context, run.dispatchedBy ?? null);
    }
    sqlite.close();
    return path;
  };

  /** Drives the flag and answers what the process printed. */
  const read = async (databasePath: string): Promise<string> => {
    const argv = process.argv;
    const write = process.stdout.write.bind(process.stdout);
    let printed = '';
    process.argv = [...argv, '--live-runs'];
    process.stdout.write = ((chunk: string) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
    try {
      process.env.MYCO_DATABASE = databasePath;
      await main();
    } finally {
      process.argv = argv;
      process.stdout.write = write;
    }
    return printed;
  };

  it('prints one JSON array of the runs in flight, with the columns the wait reads', async () => {
    const path = volumeWith([
      { id: 'run_r', status: 'running', task: 'extract-curate', startedAt: 1_700_000_000_000, context: JSON.stringify({ timeoutSeconds: 1800 }) },
      { id: 'run_p', status: 'pending', task: 'titling', startedAt: null, context: null },
      { id: 'run_done', status: 'completed', task: 'titling', startedAt: 1, context: null },
      // A launch answered too late: the run is back in the queue with the start
      // its launch stamped, and its child is still working under the credential
      // the row names.
      { id: 'run_q_live', status: 'queued', task: 'titling', startedAt: 1_700_000_000_500, queuedAt: 1_700_000_000_400, context: null, dispatchedBy: 'cred_live' },
      // A run behind a limit: nothing is running for it, and a recreate takes nothing away.
      { id: 'run_q_waiting', status: 'queued', task: 'titling', startedAt: null, queuedAt: 1_700_000_000_600, context: null },
    ]);

    const rows = JSON.parse(await read(path)) as Record<string, unknown>[];
    // A dispatched run counts as in flight before its runtime starts, and so
    // does a queued row whose runtime is live; a terminal one does not, and
    // neither does a row waiting behind a limit.
    expect(rows.map((r) => r.id).sort()).toEqual(['run_p', 'run_q_live', 'run_r']);
    expect(rows.find((r) => r.id === 'run_r')).toEqual({
      id: 'run_r', task: 'extract-curate', status: 'running', started_at: 1_700_000_000_000, run_context: JSON.stringify({ timeoutSeconds: 1800 }),
    });
    // A queued row is bounded from the launch that went out for it, like any other.
    expect(rows.find((r) => r.id === 'run_q_live')).toMatchObject({ started_at: 1_700_000_000_500 });
    expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'run_context', 'started_at', 'status', 'task']);
  });

  it('prints an empty array for a Deployment running nothing', async () => {
    expect(JSON.parse(await read(volumeWith([])))).toEqual([]);
  });

  it('selects the states the dispatcher itself treats as in flight, from the dispatcher\'s own definition', () => {
    expect(LIVE_RUNS_QUERY).toContain(LIVE_RUN_STATUSES);
    expect(LIVE_RUN_STATUSES).toBe("status IN ('pending', 'running')");
  });

  it('refuses a volume it cannot read rather than answering an empty Deployment, and leaves no volume behind', async () => {
    const absent = join(scratch(), 'absent.sqlite');
    await expect(read(absent)).rejects.toThrow();
    // A mistyped path that created an empty volume would answer every later
    // read with an empty Deployment.
    expect(existsSync(absent)).toBe(false);
  });

  it('says it could not read the volume, rather than that it failed to start', () => {
    expect(exitFailureLine(['bun', 'server.js', '--live-runs'], 'unable to open database'))
      .toBe('myco-server could not read the volume: unable to open database\n');
    expect(exitFailureLine(['bun', 'server.js'], 'MYCO_DATABASE is not set'))
      .toBe('myco-server failed to start: MYCO_DATABASE is not set\n');
    expect(exitFailureLine(['bun', 'server.js', '--migrate-only'], 'no such table'))
      .toBe('myco-server failed to start: no such table\n');
  });
});
