import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationFileName, readSchemaVersion, renderMigrationFile, renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { applySchemaSteps } from './helpers/migrate.js';
import { SCHEMA_STEPS, type SchemaStep } from '@myco-server-worker/db/schema.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/auth/tokens.js';
import { sqliteD1 } from './helpers/d1.js';

const MIGRATIONS = fileURLToPath(new URL('../../packages/myco-server/migrations/', import.meta.url));

/** sha256 of every migration file a deployed database's `d1_migrations` ledger already records. An applied file is frozen: the applier never re-runs it, so a schema change is a new step, never an edit of one of these. Shipping step n+1 adds one line here at delivery. */
const SHIPPED_MIGRATION_DIGESTS: Record<string, string> = {
  '0001_v1.sql': '999b696d37063feb2126cdd716f57e8a15c9a177c4204eae3101ff4926fdaa02',
  '0002_v2.sql': '9a8cee5f16d76d37f2997148525de27e9716b1997263a67f7f4fecc3499a3ea4',
  '0003_v3.sql': 'ff2773c613c61ecedcc9bbb236c739c43b1811ae89e1b89c7547a7ed9f7e741b',
  '0004_v4.sql': '62393274aa0dde97a25fdab7f412a4a534244874150dac6f4a9b9f1aa4a0a348',
  '0005_v5.sql': 'b8cbcbe9a647d492d99f767b9779335f9bd724bab1024ef7c11d0686528770fd',
  '0006_v6.sql': 'c8b0d10e18841d4c5e16b08a0fdeb58d6fd122c5e369e6d708a21aeba50a9c19',
  '0007_v7.sql': '23211b666c32d96c55538aa2ea45a8dcdd49fa90d84086d6f1f9b05bb0f37493',
  '0008_v8.sql': 'b48de3ea7d93f99e29b8b5fa73d8543c18f91d71db52cf441e1d3bc90edb22c5',
  '0009_v9.sql': 'a9151650dbab2135b24a195517cc88e32b66f29b18bd211fd8c7ba2781ecbf19',
  '0010_v10.sql': '725651462a2fab075ca3891dd049cc27c5235ff481fe12769763c25b5c8534b5',
  '0011_v11.sql': '7ad31c92d2fb4a73b334bb60293225fa39545938c9ce022e2f8988dc04c99e5b',
  '0012_v12.sql': '7b708740fa80bdee06eb2145711ee89312054d4ca4f28da3828fb7ec8900add9',
  '0013_v13.sql': 'a152088648a3058772a7696d3bb5b9358ec3fb41d68554aab40ef7cb8d802c71',
  '0014_v14.sql': 'a4baab3fa7476a0b7da47968396ec9f0a4f739c8250194b7dd8b8a4756e00513',
  '0015_v15.sql': '56b8085ba9179e0aa93b63b383fb240935eabd1948a39a02fd5df12768d74908',
  '0016_v16.sql': '56d0f29d79664655e0ceb671dc4d5e66930dfbd2af0565c1f076ee81d8ef3a0f',
  '0017_v17.sql': '5f615c450cbfc1e0f413e13f95332d79a76a5e399558c5f7eac079f1c8d7cf47',
  '0018_v18.sql': '67440408a984d7b805395a5ae152694975d2e5ed5b6a6bd5b0b94b0980fb6b52',
  '0019_v19.sql': '7e1dbd6996831979c8141d239e29087489531ec801b7e91fc93fde79d153e8d2',
  '0020_v20.sql': 'ca39a216f15ca7e06f57cd4657a20397521fd24c196e06ef7a7d6d947d30133c',
  '0021_v21.sql': '0f5a1b7ee7d9173270c97b954d9a978685ecc294269b6195e31dcd9bdb526c21',
  '0022_v22.sql': 'eea54343253ecc08dea82df9976bfa0aa7c9af7a7ac0239c9cff72263862313b',
  '0023_v23.sql': 'f9bde4ce357f86fc912fb4c2f6be3f08c88eed5df1de080cc130a6cf65abe9d3',
  '0024_v24.sql': 'f6cc2bd6c8c8acda977565b7b01a666842a78deedf452859bc1935b0b35be9fa',
  '0025_v25.sql': '130505475de378ec88140ca998a60a197a891a1772927b3a5ade1dc449a77e78',
  '0026_v26.sql': 'aa6245f705061b2a4ecb006e464dbd0356e8f99fa0a91ea56a7f8aeb2423ba10',  '0027_v27.sql': '34fff0ea1db7f5a27507cbe52ca214c5f0990889971760cac4fc0c9ba1be7ca0',
  '0028_v28.sql': 'd6d08116335be071d2c210311931954109907594650588863bf05a4309877336',  '0029_v29.sql': 'c0ae2712efb51f36fe46ae65e8fc4b6e0429a7cd858822b3304d2278e31683d5',  '0030_v30.sql': '2f4e045992f7b1ab1ba214d90650abb1ef88a6593ffa97252f34cc826fb8142e',  '0031_v31.sql': '341942d604a2826d39f01338c25f2077190357e6b2ecdad87ce49c3c951d0d19',  '0032_v32.sql': 'd7a11dd14977af3b2087e5241cb7e619e2bcf08900e23b76ef14016c36cc3e66',  '0033_v33.sql': '761f86e4c25ebe6e121c08b5fe91c085dfce5b3712adede4a85f74490f0f10e3',  '0034_v34.sql': '81799fcf00e093a022b2c1bc078e786dc81385f576a706f655d46fbe14db849e',
  '0035_v35.sql': '45ceeaff4e2b2552b9243a7d170480648004a6c8b072a4358cf8fa13d49e82c0',
  '0036_v36.sql': 'eba2941c680606b353b387589e35de6936d70b90f3a8e1b87b99f0855c3990a8',
};
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The schema of a database as `sqlite_master` rows, ordered; the version row is compared separately. */
const shape = (sqlite: Database) =>
  sqlite.query(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
const version = (sqlite: Database) => (sqlite.query(`SELECT value FROM schema_meta WHERE key='version'`).get() as any).value;
const fresh = () => { const s = new Database(':memory:'); s.exec('PRAGMA foreign_keys = ON'); return s; };

/** Tables and typed columns a step's statements create or add, by scanning the DDL text. */
function declaredColumns(steps: readonly SchemaStep[]): Map<string, Map<string, string>> {
  const sqlite = fresh();
  for (const step of steps) sqlite.exec(renderMigrationFile(step));
  const out = new Map<string, Map<string, string>>();
  for (const { name } of sqlite.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]) {
    const cols = new Map<string, string>();
    for (const c of sqlite.query(`PRAGMA table_info(${name})`).all() as { name: string; type: string }[]) cols.set(c.name, c.type);
    out.set(name, cols);
  }
  return out;
}

/** Every index a prefix of the steps leaves standing, by the table it is on. An index a step drops must have been created by an earlier one, so a name absent here is a drop of nothing. */
function declaredIndexes(steps: readonly SchemaStep[]): Map<string, string> {
  const sqlite = fresh();
  for (const step of steps) sqlite.exec(renderMigrationFile(step));
  const rows = sqlite.query(`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`).all() as { name: string; tbl_name: string }[];
  return new Map(rows.map((r) => [r.name, r.tbl_name]));
}

/** Applies one step the way `wrangler d1 migrations apply` does: statement by statement, stopping at the first failure. `Database.exec` on a whole file runs past a failing statement, so a file-at-once apply cannot stand in for the production applier. */
const step = (sqlite: Database, s: SchemaStep): void => { for (const statement of s.statements) sqlite.exec(statement); };

describe('versioned schema steps', () => {
  it('adds title request tracking without enqueueing or modifying historical sessions', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 35));
      sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, ended_at, title, summary)
        VALUES ('proj_1', 'old', 'm1', 't1', 1, 2, 2, 'Existing title', 'Existing summary')`);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM sessions').get();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([36]);
      expect(sqlite.query('SELECT * FROM sessions').get()).toEqual({ ...before, titling_requested_at: null });
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('adds parser context to v34 while preserving transcript bytes, cursor and identity', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 34));
      sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, parsed_offset, first_received_at, last_received_at, token_id)
        VALUES ('proj_1', 'tx_1', 's1', 'm1', 'codex', 1000, 500, 1, 2, 't1')`);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM transcripts').get();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([35, 36]);
      expect(sqlite.query('SELECT * FROM transcripts').get()).toEqual({ ...before, parser_context: null });
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('invalidates only the matching project, namespace and record on release-state mutations', () => {
    const sqlite = fresh();
    try {
      for (const migration of SCHEMA_STEPS) step(sqlite, migration);
      const types = { sessions: 'session', spores: 'spore', plans: 'plan', skill_records: 'skill' };
      for (const project of ['one', 'two']) {
        sqlite.query('INSERT INTO projects(project_id,name,created_at) VALUES (?, ?, 1)').run(project, project);
        for (const type of Object.values(types)) for (const id of ['old', 'new']) {
          sqlite.query('INSERT INTO embedding_versions(project_id,type,record_id,revision) VALUES (?, ?, ?, ?)').run(project, type, id, 'initial');
        }
      }
      const revisions = () => new Map((sqlite.query('SELECT project_id,type,record_id,revision FROM embedding_versions').all() as
        { project_id: string; type: string; record_id: string; revision: string }[]).map(r => [`${r.project_id}/${r.type}/${r.record_id}`, r.revision]));
      const changed = (before: Map<string, string>) => [...revisions()].filter(([key, revision]) => before.get(key) !== revision).map(([key]) => key).sort();
      for (const [namespace, type] of Object.entries(types)) {
        let before = revisions();
        sqlite.query(`INSERT INTO knowledge_release_state(project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at)
          VALUES ('one', 'release', 'identity', ?, 'old', 'draft', 'high', 1, 1)`).run(namespace);
        expect(changed(before)).toEqual([`one/${type}/old`]);
        before = revisions();
        sqlite.exec("UPDATE knowledge_release_state SET project_id = 'two', namespace = 'spores', record_id = 'new'");
        expect(changed(before)).toEqual([`one/${type}/old`, 'two/spore/new']);
        before = revisions();
        sqlite.exec('DELETE FROM knowledge_release_state');
        expect(changed(before)).toEqual(['two/spore/new']);
      }
    } finally { sqlite.close(); }
  });

  it('indexes existing captured text and queues historical spilled bodies when v19 is applied', () => {
    const sqlite = fresh();
    try {
      for (const migration of SCHEMA_STEPS.filter((s) => s.version < 19)) step(sqlite, migration);
      sqlite.exec(`INSERT INTO projects(project_id,name,created_at) VALUES ('existing','Existing',1);
        INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,title) VALUES ('existing','s','m','t',1,1,'historical session');
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50000)
        INSERT INTO prompt_batches(project_id,session_id,prompt_id,event_id,origin,text,content_hash,created_at,updated_at,token_id,received_at)
          SELECT 'existing','s','p'||i,'e'||i,'user','historical prompt '||i,'h'||i,1,1,'t',1 FROM n;
        UPDATE prompt_batches SET text=NULL,blob_key='legacy-body' WHERE prompt_id='p1';`);
      step(sqlite, SCHEMA_STEPS.find((s) => s.version === 19)!);
      expect(version(sqlite)).toBe('19');
      expect(sqlite.query(`SELECT COUNT(*) AS n FROM prompt_batches_fts WHERE prompt_batches_fts MATCH 'historical'`).get()).toEqual({ n: 49999 });
      expect(sqlite.query(`SELECT project_id,blob_key,complete FROM search_blob_queue`).all()).toEqual([{ project_id: 'existing', blob_key: 'legacy-body', complete: 0 }]);
      expect(sqlite.query(`SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH 'historical'`).all()).toHaveLength(1);
    } finally { sqlite.close(); }
  });
  it('stamps its version as the last statement of every step, in ascending order from 1', () => {
    SCHEMA_STEPS.forEach((step, i) => {
      expect(step.version).toBe(i + 1);
      expect(step.statements[step.statements.length - 1]).toMatch(new RegExp(`^INSERT OR REPLACE INTO schema_meta \\(key, value\\) (VALUES \\('version', '${step.version}'\\)|SELECT 'version', '${step.version}' WHERE )`));
    });
    expect(SCHEMA_STEPS[SCHEMA_STEPS.length - 1].version).toBe(SERVER_SCHEMA_VERSION);
  });

  it('renders one numbered file per step with a generated-file banner, matching the committed migrations directory byte for byte', () => {
    const files = renderMigrationFiles();
    expect(files.map((f) => f.name)).toEqual(SCHEMA_STEPS.map(migrationFileName));
    expect(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()).toEqual(files.map((f) => f.name));
    for (const f of files) {
      expect(f.sql.startsWith('-- Generated by npm run migrations:emit from src/db/schema.ts')).toBe(true);
      expect(readFileSync(join(MIGRATIONS, f.name), 'utf8')).toBe(f.sql);
    }
  });

  it('keeps every shipped migration file byte-identical to its recorded digest, so an applied step cannot be edited in place and pass as a rendered file', () => {
    const shipped = Object.keys(SHIPPED_MIGRATION_DIGESTS);
    expect(shipped).toEqual(renderMigrationFiles().map((f) => f.name));
    for (const [name, digest] of Object.entries(SHIPPED_MIGRATION_DIGESTS)) {
      expect({ name, digest: sha256(readFileSync(join(MIGRATIONS, name))) }).toEqual({ name, digest });
    }
  });

  it('converges: applied to a fresh database once or twice, or on top of a v1 or a v2 database, the schema is identical and the version is the build\'s', async () => {
    const once = fresh();
    await applySchemaSteps(sqliteD1(once));
    const twice = fresh();
    await applySchemaSteps(sqliteD1(twice));
    expect(await applySchemaSteps(sqliteD1(twice))).toEqual([]);
    const fromV1 = fresh();
    fromV1.exec(renderMigrationFile(SCHEMA_STEPS[0]));
    fromV1.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'one', 0)`).run();
    fromV1.query(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at, revoked_at, bytes_written) VALUES ('mt_1', 'proj_1', 'm', 'h', 1, NULL, 0)`).run();
    expect(await readSchemaVersion(sqliteD1(fromV1))).toBe(1);
    expect(await applySchemaSteps(sqliteD1(fromV1))).toEqual(SCHEMA_STEPS.slice(1).map((s) => s.version));
    const fromV2 = fresh();
    await applySchemaSteps(sqliteD1(fromV2), SCHEMA_STEPS.slice(0, 2));
    fromV2.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'one', 0)`).run();
    fromV2.query(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at, revoked_at, bytes_written) VALUES ('mt_v2', 'proj_1', 'm', 'h', ${MEMBER_TOKEN_TTL_MS + 5_000}, NULL, 7)`).run();
    expect(await readSchemaVersion(sqliteD1(fromV2))).toBe(2);
    expect(await applySchemaSteps(sqliteD1(fromV2))).toEqual(SCHEMA_STEPS.slice(2).map((s) => s.version));
    for (const db of [once, twice, fromV1, fromV2]) {
      expect(shape(db)).toEqual(shape(once));
      expect(version(db)).toBe(String(SERVER_SCHEMA_VERSION));
    }
    expect(fromV1.query(`SELECT project_id, name FROM projects`).all()).toEqual([{ project_id: 'proj_1', name: 'one' }]);
    expect(fromV1.query(`SELECT project_id FROM member_tokens`).all()).toEqual([{ project_id: 'proj_1' }]);
    expect(await readSchemaVersion(sqliteD1(fresh()))).toBe(0);
  });

  it('backfills every pre-v3 token as the root of its own lineage, started one TTL before it expires, and leaves predecessor and first use unset', async () => {
    const sqlite = fresh();
    await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.slice(0, 2));
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'one', 0)`).run();
    sqlite.query(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at, revoked_at, bytes_written) VALUES ('mt_a', 'proj_1', 'm', 'ha', ${MEMBER_TOKEN_TTL_MS + 1_000}, NULL, 0), ('mt_b', 'proj_1', 'm', 'hb', ${MEMBER_TOKEN_TTL_MS + 2_000}, 5, 9)`).run();
    await applySchemaSteps(sqliteD1(sqlite));
    expect(sqlite.query(`SELECT id, predecessor_id, lineage_root, lineage_started_at, first_used_at, bytes_written FROM member_tokens ORDER BY id`).all()).toEqual([
      { id: 'mt_a', predecessor_id: null, lineage_root: 'mt_a', lineage_started_at: 1_000, first_used_at: null, bytes_written: 0 },
      { id: 'mt_b', predecessor_id: null, lineage_root: 'mt_b', lineage_started_at: 2_000, first_used_at: null, bytes_written: 9 },
    ]);
  });

  it('is expand-only from step 2 on: every step after 2 keeps every earlier table and column with the same type, and a table dropped by step 2 is one it creates itself or one whose rows it copied first', () => {
    for (let n = 2; n < SCHEMA_STEPS.length; n++) {
      const before = declaredColumns(SCHEMA_STEPS.slice(0, n));
      const after = declaredColumns(SCHEMA_STEPS.slice(0, n + 1));
      for (const [table, cols] of before) {
        expect(after.has(table)).toBe(true);
        for (const [col, type] of cols) expect({ table, col, type: after.get(table)!.get(col) }).toEqual({ table, col, type });
      }
      // A step may DROP only a table it created in that same step — the guard-table
      // idiom, where a CHECK-bearing scratch table aborts the step on a precondition
      // and is cleaned up — or an index whose access path the same step replaces.
      // An index carries no data, so retiring one loses nothing a later step cannot
      // rebuild; retiring the LAST ordered path over a table does cost a read its
      // plan, so the step that drops one states the path that takes its place.
      // Anything else dropped after step 2 is contraction.
      const createdHere = new Set(
        SCHEMA_STEPS[n].statements
          .map((s) => /^CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i.exec(s)?.[1])
          .filter((t): t is string => t !== undefined),
      );
      const indexesBefore = (): Map<string, string> => declaredIndexes(SCHEMA_STEPS.slice(0, n));
      for (const s of SCHEMA_STEPS[n].statements) {
        const dropped = /^DROP TABLE (?:IF EXISTS )?(\w+)/i.exec(s)?.[1];
        if (dropped !== undefined) {
          expect({ step: n + 1, dropped, selfCreated: createdHere.has(dropped) })
            .toEqual({ step: n + 1, dropped, selfCreated: true });
          continue;
        }
        const droppedIndex = /^DROP INDEX (?:IF EXISTS )?(\w+)/i.exec(s)?.[1];
        if (droppedIndex !== undefined) {
          const table = indexesBefore().get(droppedIndex) ?? null;
          const replaced = table !== null && SCHEMA_STEPS[n].statements.some((x) =>
            new RegExp(`^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?\\w+ ON ${table}\\b`, 'i').test(x));
          expect({ step: n + 1, droppedIndex, table, replaced }).toEqual({ step: n + 1, droppedIndex, table, replaced: true });
          continue;
        }
        expect(s).not.toMatch(/\b(DROP|RENAME)\b/i);
      }
    }
    const stepTwo = SCHEMA_STEPS[1].statements;
    stepTwo.forEach((s, i) => {
      const dropped = /^DROP TABLE (?:IF EXISTS )?(\w+)/i.exec(s);
      if (!dropped) return;
      const scratch = stepTwo.some((x) => new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${dropped[1]}\\b`).test(x));
      const copied = stepTwo.slice(0, i).some((prev) => new RegExp(`INSERT INTO \\w+ .* FROM ${dropped[1]}\\b`, 'is').test(prev));
      expect({ statement: s, safe: scratch || copied }).toEqual({ statement: s, safe: true });
    });
  });

  it('aborts step 2 on an out-of-grammar project id, leaving the database at v1, and completes once the row is fixed', () => {
    const good = fresh();
    good.exec(renderMigrationFile(SCHEMA_STEPS[0]));
    good.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj-1.ok', 'one', 0)`).run();
    step(good, SCHEMA_STEPS[1]);
    expect(version(good)).toBe('2');

    const bad = fresh();
    bad.exec(renderMigrationFile(SCHEMA_STEPS[0]));
    bad.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('bad/id', 'one', 0)`).run();
    expect(() => step(bad, SCHEMA_STEPS[1])).toThrow(/CHECK constraint failed/);
    expect(version(bad)).toBe('1');

    bad.query(`UPDATE projects SET project_id = 'good.id' WHERE project_id = 'bad/id'`).run();
    step(bad, SCHEMA_STEPS[1]);
    expect(version(bad)).toBe('2');
    expect(bad.query(`SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger'`).get()).toEqual({ c: 2 });
  });

  it('aborts step 2 on a v1 session whose machine identity cannot be backfilled, and completes once the row is repaired', () => {
    // Identity binding reads `sessions.machine_id`. A session left without one refuses every later write to itself,
    // and no member request can repair it, so the step stops rather than carry the row forward.
    const sqlite = fresh();
    sqlite.exec(renderMigrationFile(SCHEMA_STEPS[0]));
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'one', 0)`).run();
    sqlite.query(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at) VALUES ('mt_named', 'proj_1', 'machine_1', 'h1', 9)`).run();
    sqlite.query(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at) VALUES ('mt_anon', 'proj_1', NULL, 'h2', 9)`).run();
    sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', 'sess_ok', NULL, 'mt_named', 0, 0)`).run();
    sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', 'sess_orphan', NULL, 'mt_anon', 0, 0)`).run();

    // The guard runs ahead of every ADD COLUMN, so the aborted step leaves nothing behind and re-applies whole.
    expect(() => step(sqlite, SCHEMA_STEPS[1])).toThrow(/CHECK constraint failed/);
    expect(version(sqlite)).toBe('1');
    expect(sqlite.query(`SELECT COUNT(*) c FROM pragma_table_info('events') WHERE name = 'producer_adapter'`).get()).toEqual({ c: 0 });

    sqlite.query(`UPDATE sessions SET machine_id = 'machine_recovered' WHERE session_id = 'sess_orphan'`).run();
    step(sqlite, SCHEMA_STEPS[1]);
    expect(version(sqlite)).toBe('2');
    // The backfill carried the session whose token names a machine; the repair stands on the one it could not reach.
    expect(sqlite.query(`SELECT session_id, machine_id FROM sessions ORDER BY session_id`).all())
      .toEqual([{ session_id: 'sess_ok', machine_id: 'machine_1' }, { session_id: 'sess_orphan', machine_id: 'machine_recovered' }]);
  });

  it('applies the project-id grammar as a CHECK on every table created or rebuilt by step 2 that has a project_id column', () => {
    const sqlite = fresh();
    for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
    // The probe inserts one synthetic row per table to observe the CHECK. Parent
    // rows for its foreign keys do not exist, and an FK refusal would mask the
    // admission this asserts, so the probe measures the CHECK alone.
    sqlite.exec('PRAGMA foreign_keys = OFF');
    const tables = (sqlite.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((t) => t.name);
    const checked: string[] = [];
    for (const t of tables) {
      const cols = sqlite.query(`PRAGMA table_info(${t})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null }[];
      if (!cols.some((c) => c.name === 'project_id')) continue;
      if (t === 'member_tokens' || t === 'sessions' || t === 'events') continue;
      sqlite.exec('SAVEPOINT grammar_probe');
      const insert = (projectId: string) => {
        const names = cols.map((c) => c.name);
        const values = cols.map((c) => (c.name === 'project_id' ? `'${projectId}'` : c.type === 'INTEGER' ? '0' : `'x'`));
        sqlite.query(`INSERT INTO ${t} (${names.join(', ')}) VALUES (${values.join(', ')})`).run();
      };
      expect(() => insert('bad/id')).toThrow(/CHECK constraint failed/);
      expect(() => insert('a'.repeat(65))).toThrow(/CHECK constraint failed/);
      // `.` and `..` sit inside the character class but are path segments wherever a project id reaches one.
      expect(() => insert('.')).toThrow(/CHECK constraint failed/);
      expect(() => insert('..')).toThrow(/CHECK constraint failed/);
      expect(() => insert('ok.id-1_A')).not.toThrow();
      sqlite.exec('ROLLBACK TO grammar_probe; RELEASE grammar_probe');
      checked.push(t);
    }
    expect(checked.sort()).toEqual([
      'agent_reports', 'agent_run_events', 'agent_run_write_intents', 'agent_runs', 'agent_state', 'agent_turns',
      'attachments', 'blob_reservations', 'blobs', 'canopy_maps', 'cortex_instructions', 'digest_extract_revisions', 'digest_extracts', 'embedding_cursors', 'embedding_hubness_work', 'embedding_receipts', 'embedding_versions', 'enrollment_authorities', 'external_grants',
      'knowledge_git_provenance', 'knowledge_release_state', 'plans', 'project_capabilities', 'project_remotes', 'project_repositories', 'projects',
      'prompt_batches', 'resolution_events', 'responses', 'search_blob_chunks', 'search_blob_queue', 'session_injections', 'session_tombstones', 'skill_candidates', 'skill_lineage', 'skill_records',
      'skill_usage', 'spore_injections', 'spores', 'tags', 'tool_calls', 'transcript_segments', 'transcripts',
    ]);
  });
});
