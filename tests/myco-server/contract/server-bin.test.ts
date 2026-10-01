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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitFailureLine, main, migrateOnly } from '@myco-server-worker/platform/bun/server-main.js';
import { dispatchEmbeddingWork, EMBEDDING_TASK } from '@myco-server-worker/core/embedding/jobs.js';
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

/**
 * The columns a step after 48 adds to `member_credentials`, each with the value every row it finds takes and the
 * clause the ALTER appends to the table's DDL. Step 48's own properties are read with them taken out, once every
 * row is seen to carry the value.
 */
const ADDED_AFTER_48: Record<string, { value: unknown; ddl: string }> = {
  rotates: { value: 1, ddl: ', rotates INTEGER NOT NULL DEFAULT 1' },
};

/**
 * Everything SQLite records about `member_credentials` but its CHECK: every column (`table_xinfo`), every foreign key,
 * every index with its columns (`index_xinfo`) and its DDL, and the table's own DDL with the CHECK clause taken out.
 * Whitespace is folded so a layout change reads as no change.
 */
function credentialShape(sqlite: Database, dropCheck: boolean) {
  const fold = (sql: string) => sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
  const table = fold((sqlite.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'member_credentials'`).get() as { sql: string }).sql);
  const indexes = (sqlite.query(`SELECT name, "unique", origin, partial FROM pragma_index_list('member_credentials') ORDER BY name`).all() as { name: string }[])
    .map((index) => ({
      ...index,
      columns: sqlite.query(`SELECT seqno, cid, name, "desc", coll, "key" FROM pragma_index_xinfo(?) ORDER BY seqno`).all(index.name),
      sql: ((sqlite.query(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(index.name) as { sql: string | null }).sql ?? '').replace(/\s+/g, ' '),
    }));
  const withoutLater = Object.values(ADDED_AFTER_48).reduce((ddl, added) => ddl.replace(added.ddl, ''), table);
  return {
    table: dropCheck ? withoutLater.replace(/, CONSTRAINT member_tokens_quota CHECK \(bytes_written <= 1073741824\)\)$/, ')') : withoutLater,
    columns: (sqlite.query(`SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo('member_credentials') ORDER BY cid`).all() as { name: string }[])
      .filter((column) => !(column.name in ADDED_AFTER_48)),
    foreignKeys: sqlite.query(`SELECT id, seq, "table", "from", "to", on_update, on_delete, "match" FROM pragma_foreign_key_list('member_credentials') ORDER BY id, seq`).all(),
    indexes,
  };
}

/** Every credential row, with the columns a later step added taken out once each row is seen to hold that step's value. */
const credentialRows = (sqlite: Database) => (sqlite.query('SELECT * FROM member_credentials ORDER BY id').all() as Record<string, unknown>[]).map((row) => {
  const kept = { ...row };
  for (const [name, added] of Object.entries(ADDED_AFTER_48)) {
    if (!(name in kept)) continue;
    expect({ id: kept.id, [name]: kept[name] }).toEqual({ id: kept.id, [name]: added.value });
    delete kept[name];
  }
  return kept;
});
const referencingRows = (sqlite: Database) => ({
  runs: sqlite.query('SELECT id, dispatched_by, leased_by FROM agent_runs ORDER BY id').all(),
  contacts: sqlite.query('SELECT credential_id FROM worker_contacts ORDER BY credential_id').all(),
});

/** How many steps a volume at step 47 is behind this build. */
const STEPS_AFTER_47 = SERVER_SCHEMA_VERSION - 47;

describe('migrateOnly across step 48 (#1416)', () => {
  it('migrates a v47 volume whose credentials are referenced: every row, counter and reference kept, the byte CHECK gone, foreign keys still enforced', () => {
    const path = join(scratch(), 'myco.sqlite');
    const v47 = migrateTo(path, 47);
    seedCredentials(v47);
    expect(() => v47.exec(`UPDATE member_credentials SET bytes_written = 1073741825 WHERE id = 'mt_next'`)).toThrow(/member_tokens_quota/);
    const rows = credentialRows(v47);
    const refs = referencingRows(v47);
    v47.close();

    expect(migrateOnly(path)).toBe(STEPS_AFTER_47);

    const sqlite = new Database(path);
    sqlite.exec('PRAGMA foreign_keys = ON');
    expect(sqlite.query(`SELECT value FROM schema_meta WHERE key = 'version'`).get()).toEqual({ value: String(SERVER_SCHEMA_VERSION) });
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

  it('changes nothing about member_credentials but the CHECK: columns, foreign keys, indexes and their columns are as step 47 left them', () => {
    const path = join(scratch(), 'myco.sqlite');
    const v47 = migrateTo(path, 47);
    seedCredentials(v47);
    const before = credentialShape(v47, true);
    expect(before.table).not.toMatch(/CHECK/);
    expect(before.foreignKeys).toEqual([expect.objectContaining({ table: 'members', from: 'member_id', to: 'id' })]);
    v47.close();

    expect(migrateOnly(path)).toBe(STEPS_AFTER_47);
    const after = new Database(path);
    expect(credentialShape(after, false)).toEqual(before);
    after.close();
  });

  it('recovers by re-running from any state a run torn outside a transaction leaves: every row comes back, the copy is never dropped first', () => {
    const step48 = SCHEMA_STEPS.find((s) => s.version === 48)!.statements;
    const lastIndex = step48.findIndex((sql) => sql.startsWith('INSERT INTO member_credentials'));
    // Every prefix that stops before the rows are back: after the copy, after the drop, after the empty table and its indexes.
    for (let torn = 3; torn <= lastIndex; torn += 1) {
      const path = join(scratch(), 'myco.sqlite');
      const v47 = migrateTo(path, 47);
      seedCredentials(v47);
      const rows = credentialRows(v47);
      v47.exec('PRAGMA foreign_keys = OFF');
      for (const sql of step48.slice(0, torn)) v47.exec(sql);
      v47.close();

      expect({ torn, applied: migrateOnly(path) }).toEqual({ torn, applied: STEPS_AFTER_47 });
      const healed = new Database(path);
      expect({ torn, rows: credentialRows(healed) }).toEqual({ torn, rows });
      expect({ torn, holding: healed.query(`SELECT name FROM sqlite_master WHERE name LIKE '_v48_%'`).all() }).toEqual({ torn, holding: [] });
      healed.close();
    }
  });

  it('re-applied by hand over a volume already at 48, changes nothing', () => {
    // The volume is taken to 48 itself: the step rebuilds the table in its own shape, so a column a later step adds is
    // not one a re-run of 48 keeps, and the runner never re-runs a step below the version a volume is stamped at.
    const path = join(scratch(), 'myco.sqlite');
    const v47 = migrateTo(path, 47);
    seedCredentials(v47);
    v47.close();
    const step48 = SCHEMA_STEPS.find((s) => s.version === 48)!.statements;
    const sqlite = new Database(path);
    sqlite.exec('PRAGMA foreign_keys = ON');
    sqlite.transaction(() => { for (const sql of step48) sqlite.exec(sql); })();
    const rows = credentialRows(sqlite);
    const shape = credentialShape(sqlite, false);
    sqlite.transaction(() => { for (const sql of step48) sqlite.exec(sql); })();
    expect(credentialRows(sqlite)).toEqual(rows);
    expect(credentialShape(sqlite, false)).toEqual(shape);
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
    expect(after.query(`SELECT name FROM sqlite_master WHERE name = '_v48_credential_rows'`).all()).toEqual([]);
    after.exec(`DROP VIEW _v48_guard_rows_kept`);
    after.close();

    expect(migrateOnly(path)).toBe(STEPS_AFTER_47);
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
 * The plain image's server, started with no harness environment at all, runs `embedding-reconcile` in this process:
 * a dispatch launches its own embedding runtime, which closes the run over the in-process embedding channel.
 */
describe('the embedding runtime', () => {
  const volume = () => {
    const root = scratch();
    return { MYCO_DATABASE: join(root, 'myco.sqlite'), MYCO_BLOB_DIR: join(root, 'blobs') };
  };

  it('launches embedding-reconcile in-process with no extra environment, and reports the runtime present', async () => {
    const env = volume();
    Object.assign(process.env, env, { MYCO_PORT: '0' });
    migrateOnly(env.MYCO_DATABASE);
    const seed = new Database(env.MYCO_DATABASE);
    seed.run("INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'p', 1)");
    seed.run("INSERT INTO spores (project_id, id, agent_id, content, observation_type, created_at) VALUES ('proj_1', 'memory', 'user', 'A durable architecture decision', 'decision', 1)");
    seed.close();

    const started = await main();
    try {
      expect(started?.env.harnessTasks).toEqual([EMBEDDING_TASK]);
      expect(started!.env.platform?.capabilities().find((c) => c.capability === 'harness-runtime'))
        .toEqual({ capability: 'harness-runtime', label: 'Embedding runtime', present: true, operatorNames: [] });
      started!.env.origin = `http://127.0.0.1:${started!.port}`;
      started!.env.embeddingProvider = async () => ({ modelKey: 'fixture-model', embed: async () => [1, 0] });
      expect(await dispatchEmbeddingWork(started!.env, Date.now())).toBe(1);
      const deadline = Date.now() + 5_000;
      let row: { status: string; task: string } | null = null;
      while (Date.now() < deadline) {
        row = await started!.env.db.prepare('SELECT status, task FROM agent_runs ORDER BY started_at DESC LIMIT 1').first<{ status: string; task: string }>();
        if (row?.status === 'completed' || row?.status === 'failed') break;
        await Bun.sleep(20);
      }
      expect(row).toEqual({ status: 'completed', task: EMBEDDING_TASK });
    } finally {
      await started?.stop();
    }
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

describe('a process that dies before it serves', () => {
  it('says it failed to start', () => {
    expect(exitFailureLine('MYCO_DATABASE is not set')).toBe('myco-server failed to start: MYCO_DATABASE is not set\n');
  });
});
