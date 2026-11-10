import { RETIREMENT_SCHEMA_STEPS } from '@myco-server-worker/db/schema-v117.js';
import { DROP_CONTENT_SCHEMA_STEPS, DROPPED_CONTENT_TABLES, DROP_RANGES_TABLE } from '@myco-server-worker/db/schema-v265.js';
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationFileName, readSchemaVersion, renderMigrationFile, renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { applySchemaSteps } from './helpers/migrate.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import type { Retirement, SchemaStep } from '@myco-server-worker/db/schema-step.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/auth/tokens.js';
import { sqliteD1 } from './helpers/d1.js';
import { publishFixture, sqliteEnv } from './helpers/fixtures.js';
import { markPromptProcessed } from './helpers/extraction.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';

const MIGRATIONS = fileURLToPath(new URL('../../packages/myco-server/migrations/', import.meta.url));

/** The schema of a database as `sqlite_master` rows, ordered; the version row is compared separately. */
const shape = (sqlite: Database) =>
  sqlite.query(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
const version = (sqlite: Database) => (sqlite.query(`SELECT value FROM schema_meta WHERE key='version'`).get() as any).value;
const schemaVersionsFrom = (first: number) => SCHEMA_STEPS.filter((step) => step.version >= first).map((step) => step.version);
const PRE_RETIREMENT_STEPS = SCHEMA_STEPS.filter(step => step.version < 117);
const preRetirementVersionsFrom = (first: number) => PRE_RETIREMENT_STEPS.filter(step => step.version >= first).map(step => step.version);
const fresh = () => { const s = new Database(':memory:'); s.exec('PRAGMA foreign_keys = ON'); return s; };
const DROPPED_CONTENT = new Set<string>(DROPPED_CONTENT_TABLES);
const namesDroppedContent = (sql: string) => new RegExp(`\\b(${DROPPED_CONTENT_TABLES.join('|')})\\b`).test(sql);
/** The shadow tables SQLite keeps for an FTS5 table and drops with it. */
const FTS_SHADOW_SUFFIXES = ['_data', '_idx', '_docsize', '_config', '_content'];

/** What stands after a step: each table with its columns and their types, each index by its table, each trigger with its SQL. */
interface Standing {
  columns: Map<string, Map<string, string>>;
  indexes: Map<string, string>;
  triggers: Map<string, string>;
}

/** What stands after each of `steps`, applied in order to a fresh store. */
function standingAfterEach(steps: readonly SchemaStep[]): Standing[] {
  const sqlite = fresh();
  try {
    return steps.map((step) => {
      sqlite.exec(renderMigrationFile(step));
      const columns = new Map<string, Map<string, string>>();
      for (const { name } of sqlite.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]) {
        columns.set(name, new Map((sqlite.query(`PRAGMA table_info(${name})`).all() as { name: string; type: string }[]).map((c) => [c.name, c.type])));
      }
      const indexes = new Map((sqlite.query("SELECT name,tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as { name: string; tbl_name: string }[]).map((row) => [row.name, row.tbl_name]));
      const triggers = new Map((sqlite.query("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all() as { name: string; sql: string }[]).map((row) => [row.name, row.sql]));
      return { columns, indexes, triggers };
    });
  } finally {
    sqlite.close();
  }
}

let shipped: Standing[] | undefined;
/** What stands after shipped step `version`. */
const standingAt = (version: number): Standing => (shipped ??= standingAfterEach(SCHEMA_STEPS))[version - 1]!;

/** What a trigger does: when it fires, on which event of which table, and which tables its body writes. */
function triggerShape(sql: string): { timing: string; event: string; table: string; writes: string[] } | null {
  const head = /^CREATE TRIGGER (?:IF NOT EXISTS )?\w+\s+(BEFORE|AFTER|INSTEAD OF)\s+(INSERT|UPDATE|DELETE)\b[\s\S]*?\bON\s+(\w+)/i.exec(sql.trim());
  const begin = sql.search(/\bBEGIN\b/i);
  if (head === null || begin < 0) return null;
  const writes = [...sql.slice(begin).matchAll(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|(?<!DO\s+)UPDATE|DELETE\s+FROM)\s+(\w+)/gi)]
    .map((m) => m[1].toLowerCase());
  return { timing: head[1].toUpperCase(), event: head[2].toUpperCase(), table: head[3], writes: [...new Set(writes)].sort() };
}

/**
 * Whether a view or trigger a step drops at `index` is created again later in
 * the same step: for a trigger, on the same table and event, writing the same tables.
 */
function recreatedAfterDrop(statements: readonly string[], index: number, kind: 'VIEW' | 'TRIGGER', name: string, prior: string | null): boolean {
  const create = new RegExp(`^\\s*CREATE ${kind} (?:IF NOT EXISTS )?${name}\\b`, 'i');
  const later = statements.slice(index + 1).filter((x) => create.test(x));
  if (later.length === 0) return false;
  if (kind === 'VIEW') return true;
  const before = prior === null ? null : triggerShape(prior);
  if (before === null || before.writes.length === 0) return false;
  return later.every((x) => JSON.stringify(triggerShape(x)) === JSON.stringify(before));
}

/** Applies one step the way `wrangler d1 migrations apply` does: statement by statement, stopping at the first failure. `Database.exec` on a whole file runs past a failing statement, so a file-at-once apply cannot stand in for the production applier. */
const step = (sqlite: Database, s: SchemaStep): void => { for (const statement of s.statements) sqlite.exec(statement); };

/**
 * Every way the steps after the second lose a table, column, index, view or trigger that the step doing it does not
 * declare, and every declaration a step does not carry out, one sentence each. `standing[i]` is what stands after
 * `steps[i]`.
 */
function contractionProblems(steps: readonly SchemaStep[], standing: readonly Standing[]): string[] {
  const undeclared: string[] = [];
  for (let n = 2; n < steps.length; n++) {
    const current = steps[n]!;
    const declares = (kind: Retirement['kind'], name: string) => current.retires?.some((r) => r.kind === kind && r.name === name) ?? false;
    const refuse = (kind: Retirement['kind'], name: string, what: string) => undeclared.push(`step ${current.version} ${what} ${name} without `
      + `declaring it: add { kind: '${kind}', name: '${name}', reason } to the step's \`retires\`, or put it back in the same step`);
    // A table named with a leading underscore holds only a migration's working state, and an FTS5 table's shadow
    // tables go with it.
    const retiredTable = (table: string) => table.startsWith('_') || declares('table', table)
      || (current.retires ?? []).some((r) => r.kind === 'table' && FTS_SHADOW_SUFFIXES.some((suffix) => table === r.name + suffix));
    const dropped = new Set<string>();
    const before = standing[n - 1]!.columns;
    const after = standing[n]!.columns;
    for (const [table, cols] of before) {
      if (!after.has(table)) {
        if (!retiredTable(table)) refuse('table', table, 'loses table');
        continue;
      }
      for (const [col, type] of cols) {
        if (!after.get(table)!.has(col)) {
          dropped.add(`column ${table}.${col}`);
          if (!declares('column', `${table}.${col}`)) refuse('column', `${table}.${col}`, 'loses column');
        } else if (after.get(table)!.get(col) !== type) undeclared.push(`step ${current.version} changes column ${table}.${col} from ${type} to ${after.get(table)!.get(col)}`);
      }
    }
    const createdHere = new Set(current.statements
      .map((s) => /^CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i.exec(s)?.[1])
      .filter((t): t is string => t !== undefined));
    for (const [index, s] of current.statements.entries()) {
      const table = /^DROP TABLE (?:IF EXISTS )?(\w+)/i.exec(s)?.[1];
      if (table !== undefined) {
        dropped.add(`table ${table}`);
        if (!createdHere.has(table) && !retiredTable(table)) refuse('table', table, 'drops table');
        continue;
      }
      // An index whose table gains another index in the same step is a replaced access path.
      const droppedIndex = /^DROP INDEX (?:IF EXISTS )?(\w+)/i.exec(s)?.[1];
      if (droppedIndex !== undefined) {
        dropped.add(`index ${droppedIndex}`);
        const on = standing[n - 1]!.indexes.get(droppedIndex) ?? null;
        const replaced = on !== null && current.statements.some((x) => new RegExp(`^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?\\w+ ON ${on}\\b`, 'i').test(x));
        if (!replaced && !declares('index', droppedIndex)) refuse('index', droppedIndex, 'drops index');
        continue;
      }
      // A view holds no rows: dropping one loses nothing as long as the same step puts it back.
      const droppedView = /^DROP VIEW (?:IF EXISTS )?(\w+)/i.exec(s)?.[1];
      if (droppedView !== undefined) {
        if (!recreatedAfterDrop(current.statements, index, 'VIEW', droppedView, null)) undeclared.push(`step ${current.version} drops view ${droppedView} without creating it again`);
        continue;
      }
      const droppedTrigger = /^DROP TRIGGER (?:IF EXISTS )?(\w+)/i.exec(s)?.[1];
      if (droppedTrigger !== undefined) {
        dropped.add(`trigger ${droppedTrigger}`);
        const prior = standing[n - 1]!.triggers.get(droppedTrigger) ?? null;
        if (!recreatedAfterDrop(current.statements, index, 'TRIGGER', droppedTrigger, prior) && !declares('trigger', droppedTrigger)) refuse('trigger', droppedTrigger, 'drops trigger');
        continue;
      }
      // A dropped column is judged above, by the columns the step leaves.
      if (/^ALTER TABLE \w+ DROP COLUMN \w+$/i.test(s)) continue;
      // A rebuild renames the table to a copy the same step retires.
      const renamed = /^ALTER TABLE (\w+) RENAME TO (\w+)$/i.exec(s);
      if (renamed !== null) {
        if (!declares('table', renamed[2]!)) refuse('table', renamed[2]!, `renames table ${renamed[1]} to`);
        continue;
      }
      if (/\b(DROP|RENAME)\b/i.test(s)) undeclared.push(`step ${current.version} contracts the schema with an unrecognized statement: ${s.slice(0, 120)}`);
    }
    for (const r of current.retires ?? []) {
      if (!dropped.has(`${r.kind} ${r.name}`)) undeclared.push(`step ${current.version} declares ${r.kind} ${r.name} retired but does not drop it`);
    }
  }
  return undeclared;
}

describe('versioned schema steps', () => {
  it('adds restore progress without claiming or rewriting existing history', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 36));
      sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'old', 1)`);
      sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('agent_old', 'old', 'built-in', 1, 1)`);
      sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, status, started_at)
        VALUES ('proj_1', 'run_old', 'agent_old', 'completed', 1)`);
      sqlite.run(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at)
        VALUES ('proj_1', 'run_old', 'agent_old', 'note', 'Existing history', 1)`);
      const before = sqlite.query('SELECT * FROM agent_reports').all();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(37));
      expect(sqlite.query('SELECT * FROM agent_reports').all()).toEqual(before.map((row) => ({ ...(row as Record<string, unknown>), audit: null })));
      expect(sqlite.query('SELECT * FROM backup_restore_progress').all()).toEqual([]);
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('names each claimed machine in v59 after its newest credential\'s label, a live one ahead of a revoked one, and leaves a machine with none unnamed', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 58));
      sqlite.run(`INSERT INTO members (id, label, created_at, revoked_at) VALUES ('mem_1', 'mem_1', 1, NULL)`);
      sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('m_live', 'mem_1', 1), ('m_revoked', 'mem_1', 1), ('m_none', 'mem_1', 1)`);
      const credential = (id: string, machine: string, label: string | null, issuedAt: number, revokedAt: number | null) =>
        sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, runtime_label, issued_at, expires_at, revoked_at, lineage_root, lineage_started_at)
          VALUES (?, 'mem_1', ?, ?, ?, ?, 9, ?, ?, 1)`, [id, id.padEnd(64, '0'), machine, label, issuedAt, revokedAt, id]);
      // The newer credential is revoked, so the older live one names the machine.
      credential('mt_a', 'm_live', 'studio', 1, null);
      credential('mt_b', 'm_live', 'studio-later', 5, 6);
      credential('mt_c', 'm_live', null, 7, null);
      // Every credential revoked: the newest labelled one names it.
      credential('mt_d', 'm_revoked', 'old-box', 1, 2);
      credential('mt_e', 'm_revoked', 'newer-box', 3, 4);
      credential('mt_f', 'm_none', null, 1, null);
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(59));
      expect(sqlite.query('SELECT machine_id, label FROM machine_claims ORDER BY machine_id').all())
        .toEqual([{ machine_id: 'm_live', label: 'studio' }, { machine_id: 'm_none', label: null }, { machine_id: 'm_revoked', label: 'newer-box' }]);
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('adds `rotates` to v52: every existing credential keeps rotating, and a new row rotates unless its insert says otherwise', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 51));
      sqlite.run(`INSERT INTO members (id, label, created_at, revoked_at) VALUES ('mem_1', 'mem_1', 1, NULL)`);
      sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, issued_at, expires_at, lineage_root, lineage_started_at)
        VALUES ('mt_old', 'mem_1', ?, 'machine_1', 1, 2, 'mt_old', 1)`, ['a'.repeat(64)]);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM member_credentials').get();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(52));
      expect(sqlite.query('SELECT * FROM member_credentials').get()).toEqual({ ...before, rotates: 1 });
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
      sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, issued_at, expires_at, lineage_root, lineage_started_at)
        VALUES ('mt_new', 'mem_1', ?, 'machine_1', 1, 2, 'mt_new', 1)`, ['b'.repeat(64)]);
      sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, issued_at, expires_at, lineage_root, lineage_started_at, rotates)
        VALUES ('mt_fixed', 'mem_1', ?, 'machine_1', 1, 2, 'mt_fixed', 1, 0)`, ['c'.repeat(64)]);
      expect(sqlite.query('SELECT id, rotates FROM member_credentials ORDER BY id').all()).toEqual([{ id: 'mt_fixed', rotates: 0 }, { id: 'mt_new', rotates: 1 }, { id: 'mt_old', rotates: 1 }]);
    } finally { sqlite.close(); }
  });

  it('adds a recorded backup digest to v40 without inventing one for an existing backup, and admits only a hex SHA-256', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 40));
      sqlite.run(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned)
        VALUES ('bk_old', 'backups/lineage__1__bk_old.jsonl', 1, 40, '{}', 13, 'mem_1', 1)`);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM backups').get();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(41));
      expect(sqlite.query('SELECT * FROM backups').get()).toEqual({ ...before, sha256: null, verification_state: null, verification_checked_at: null, verification_detail: null });
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
      const insert = (sha256: string) => sqlite.run(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned, sha256)
        VALUES (?, 'backups/lineage__2__bk_new.jsonl', 2, 40, '{}', 41, 'mem_1', 0, ?)`, [`bk_${sha256.length}`, sha256]);
      for (const invalid of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) expect(() => insert(invalid)).toThrow('CHECK constraint failed');
      insert('a'.repeat(64));
    } finally { sqlite.close(); }
  });

  it('adds the object lifecycle to v41: an existing blob keeps its legacy object name, and every new table and guard admits only its grammar', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 41));
      sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES ('proj_1', ?, 3, 'text/plain', 't1', 1)`, ['a'.repeat(64)]);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM blobs').get();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(42));
      expect(sqlite.query('SELECT * FROM blobs').get()).toEqual({ ...before, generation: null });
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
      const generation = (value: string) => sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation)
        VALUES ('proj_1', ?, 3, 'text/plain', 't1', 1, ?)`, [`${value.length}`.padStart(64, 'b'), value]);
      for (const invalid of ['A1b2c3d4-0000-4000-8000-000000000000', 'short', `${'0'.repeat(35)}/`]) expect(() => generation(invalid)).toThrow('CHECK constraint failed');
      generation(crypto.randomUUID());
      expect(() => sqlite.run(`INSERT INTO object_releases (physical, kind, created_at) VALUES ('p/k', 'other', 1)`)).toThrow('CHECK constraint failed');
      sqlite.run(`INSERT INTO recovery_holds (token, acquired_at) VALUES ('h1', 1)`);
      expect(() => sqlite.run(`INSERT INTO recovery_holds (token, acquired_at) VALUES ('h2', 2)`)).toThrow('UNIQUE constraint failed');
      sqlite.run(`UPDATE recovery_holds SET released_at = 3 WHERE token = 'h1'`);
      sqlite.run(`INSERT INTO recovery_holds (token, acquired_at) VALUES ('h2', 4)`);
      for (const value of [null, 'k']) expect(() => sqlite.run('INSERT INTO restore_reference_guard (missing) VALUES (?)', [value])).toThrow('constraint failed');
      // The fence: a row without a generation cannot be registered any more, the legacy row stands, and a generation row
      // leaves only once its exact stored object is journaled. A legacy row is not fenced.
      expect(() => sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES ('proj_1', ?, 3, 'text/plain', 't1', 1)`, ['c'.repeat(64)]))
        .toThrow('blob rows register a generation');
      const fenced = sqlite.query<{ key: string; generation: string }, []>('SELECT key, generation FROM blobs WHERE generation IS NOT NULL').get()!;
      expect(() => sqlite.run('DELETE FROM blobs WHERE key = ?', [fenced.key])).toThrow('blob rows leave through the release journal');
      sqlite.run(`INSERT INTO object_releases (physical, kind, created_at) VALUES (?, 'blob', 1)`, [`proj_1/${fenced.key}~${fenced.generation}`]);
      sqlite.run('DELETE FROM blobs WHERE key = ?', [fenced.key]);
      sqlite.run('DELETE FROM blobs WHERE key = ?', ['a'.repeat(64)]);
      expect(sqlite.query('SELECT COUNT(*) AS n FROM blobs').get()).toEqual({ n: 0 });
    } finally { sqlite.close(); }
  });

  it('fills a session\'s missing agent from the one agent its transcripts name, and touches nothing else', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 39));
      const session = (id: string, agent: string | null) => sqlite.run(
        `INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, ended_at, title, titled_by, agent)
         VALUES ('proj_1', ?, 'm1', 't1', 1, 2, 2, 'Kept title', 'mem_1', ?)`, [id, agent]);
      const transcript = (session: string, id: string, agent: string | null) => sqlite.run(
        `INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, parsed_offset, first_received_at, last_received_at, token_id)
         VALUES ('proj_1', ?, ?, 'm1', ?, 10, 10, 1, 2, 't1')`, [id, session, agent]);
      session('one-agent', null); transcript('one-agent', 'tx1', 'codex');
      session('two-transcripts-one-agent', null); transcript('two-transcripts-one-agent', 'tx2', 'claude-code'); transcript('two-transcripts-one-agent', 'tx3', 'claude-code');
      session('two-agents', null); transcript('two-agents', 'tx4', 'codex'); transcript('two-agents', 'tx5', 'claude-code');
      session('unnamed-transcript', null); transcript('unnamed-transcript', 'tx6', null);
      session('no-transcript', null);
      session('already-named', 'cursor'); transcript('already-named', 'tx7', 'codex');
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM sessions ORDER BY session_id').all();
      expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual(preRetirementVersionsFrom(40));
      const after = sqlite.query<Record<string, unknown>, []>('SELECT * FROM sessions ORDER BY session_id').all();
      const agents = Object.fromEntries(after.map((row) => [row.session_id, row.agent]));
      expect(agents).toEqual({ 'one-agent': 'codex', 'two-transcripts-one-agent': 'claude-code', 'two-agents': null, 'unnamed-transcript': null, 'no-transcript': null, 'already-named': 'cursor' });
      // The v45 presentation columns arrive NULL on every existing session: a backfill would be history the parse has not read.
      expect(after.map((row) => ({ ...row, agent: null }))).toEqual(before.map((row) => ({ ...row, agent: null, occurred_started_at: null, occurred_ended_at: null, titling_attempts: 0, working_since: null, last_turn_end_at: null, last_live_received_at: null, title_material_at: null, launch_parent_session_id: null })));
      expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual([]);
      expect(sqlite.query('SELECT * FROM sessions ORDER BY session_id').all()).toEqual(after);
    } finally { sqlite.close(); }
  });

  it('adds who ended a session to v38 while preserving every ended and titled session as it stands', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 38));
      sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, ended_at, title, summary, titled_at, titled_by)
        VALUES ('proj_1', 'old', 'm1', 't1', 1, 2, 2, 'Existing title', 'Existing summary', 2, 'mem_1')`);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM sessions').get();
      expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual(preRetirementVersionsFrom(39));
      expect(sqlite.query('SELECT * FROM sessions').get()).toEqual({ ...before, ended_by: null, occurred_started_at: null, occurred_ended_at: null, titling_attempts: 0, working_since: null, last_turn_end_at: null, last_live_received_at: null, title_material_at: null, launch_parent_session_id: null });
      expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('adds title request tracking without enqueueing or modifying historical sessions', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 35));
      sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, ended_at, title, summary)
        VALUES ('proj_1', 'old', 'm1', 't1', 1, 2, 2, 'Existing title', 'Existing summary')`);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM sessions').get();
      expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual(preRetirementVersionsFrom(36));
      expect(sqlite.query('SELECT * FROM sessions').get()).toEqual({ ...before, titling_requested_at: null, ended_by: null, occurred_started_at: null, occurred_ended_at: null, titling_attempts: 0, working_since: null, last_turn_end_at: null, last_live_received_at: null, title_material_at: null, launch_parent_session_id: null });
      expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('adds the awaited size to v54 without putting any existing transcript into a wait', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 53));
      sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, parsed_offset, first_received_at, last_received_at, token_id, parse_error, parse_failed_at)
        VALUES ('proj_1', 'tx_1', 's1', 'm1', 'cursor', 1000, 500, 1, 2, 't1', 'awaiting_bytes', 2)`);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM transcripts').get();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(54));
      expect(sqlite.query('SELECT * FROM transcripts').get()).toEqual({ ...before, parse_awaited_size: null, parse_segment_lines: null, parsed_through_at: null, prompt_generation: null, prompt_identity_scheme: 'offset-v1', record_identity_scheme: 'legacy-session-v1' });
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('adds parser context to v34 while preserving transcript bytes, cursor and identity', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 34));
      sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, parsed_offset, first_received_at, last_received_at, token_id)
        VALUES ('proj_1', 'tx_1', 's1', 'm1', 'codex', 1000, 500, 1, 2, 't1')`);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM transcripts').get();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(35));
      expect(sqlite.query('SELECT * FROM transcripts').get()).toEqual({ ...before, parser_context: null, parse_awaited_size: null, parse_segment_lines: null, parsed_through_at: null, prompt_generation: null, prompt_identity_scheme: 'offset-v1', record_identity_scheme: 'legacy-session-v1' });
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('invalidates only the matching project, namespace and record on release-state mutations', () => {
    const sqlite = fresh();
    try {
      for (const migration of SCHEMA_STEPS) step(sqlite, migration);
      const types = { sessions: 'session', spores: 'spore', plans: 'plan' };
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

  it('retires populated v85 skill, digest, instruction and derived data through the native and D1 migration paths', async () => {
    const retired = [
      'skill_candidates', 'skill_records', 'skill_lineage', 'skill_usage',
      'digest_extracts', 'digest_extract_revisions', 'cortex_instructions',
    ];
    for (const mode of ['native', 'd1'] as const) {
      const sqlite = fresh();
      try {
        for (const migration of SCHEMA_STEPS.filter(({ version }) => version <= 85)) step(sqlite, migration);
        sqlite.exec(`INSERT INTO projects(project_id,name,created_at) VALUES('p','Project',1);
          INSERT INTO agents(id,name,source,enabled,created_at) VALUES('a','Agent','built-in',1,1);
          INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at) VALUES('p','s','t',1,1);
          INSERT INTO skill_candidates(project_id,id,agent_id,topic,rationale,created_at,updated_at) VALUES('p','c','a','topic','reason',1,1);
          INSERT INTO skill_records(project_id,id,agent_id,name,display_name,description,candidate_id,path,created_at,updated_at)
            VALUES('p','r','a','name','Name','description','c','skills/name',1,1);
          INSERT INTO skill_lineage(project_id,id,skill_id,generation,action,rationale,content_snapshot,created_at)
            VALUES('p','l','r',1,'create','reason','content',1);
          INSERT INTO skill_usage(project_id,id,skill_id,session_id,detected_at) VALUES('p','u','r','s',1);
          INSERT INTO digest_extracts(project_id,id,agent_id,tier,content,generated_at) VALUES('p','d','a',1,'digest',1);
          INSERT INTO digest_extract_revisions(project_id,agent_id,tier,content,created_at) VALUES('p','a',1,'digest',1);
          INSERT INTO cortex_instructions(project_id,id,agent_id,content,input_hash,generated_at) VALUES('p','i','a','instructions','hash',1);
          INSERT INTO embedding_versions(project_id,type,record_id,revision)
            VALUES('p','skill','r','v1'),('p','digest','d','v1'),('p','digest_extracts','d','v1');
          INSERT INTO embedding_source_failures(project_id,type,record_id,model_key,revision,reason,recorded_at)
            VALUES('p','skill','r','model','v1','source',1),('p','digest','d','model','v1','source',1),
                  ('p','digest_extracts','d','model','v1','source',1);
          INSERT INTO knowledge_release_state(project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at)
            VALUES('p','rs','p:skill_records:r','skill_records','r','draft','high',1,1),
                  ('p','rskill','p:skill:r','skill','r','draft','high',1,1),
                  ('p','rdigest','p:digest:d','digest','d','draft','high',1,1),
                  ('p','rd','p:digest_extracts:d','digest_extracts','d','draft','high',1,1),
                  ('p','rk','p:sessions:s','sessions','s','draft','high',1,1);`);
        const before = sqlite.query('SELECT * FROM sessions').all();
        const retainedRelease = sqlite.query("SELECT * FROM knowledge_release_state WHERE namespace='sessions'").all();
        for (const table of retired) expect((sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(1);
        if (mode === 'native') for (const migration of PRE_RETIREMENT_STEPS.filter(({ version }) => version >= 86)) sqlite.exec(renderMigrationFile(migration));
        else expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual(preRetirementVersionsFrom(86));
        expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual([]);
        sqlite.exec(renderMigrationFile(SCHEMA_STEPS[85]!));
        expect(version(sqlite)).toBe('86');
        expect(sqlite.prepare('SELECT * FROM sessions').all()).toEqual(before.map((row) => ({ ...row as Record<string, unknown>, launch_parent_session_id: null })));
        const retiredObjects = sqlite.query(`SELECT name FROM sqlite_master
          WHERE name LIKE 'skill_%' OR name LIKE 'digest_extract%' OR tbl_name = 'cortex_instructions'`).all() as { name: string }[];
        expect(retiredObjects).toEqual([]);
        expect(sqlite.query("SELECT type FROM embedding_versions WHERE type IN ('skill','digest','digest_extracts')").all()).toEqual([]);
        expect(sqlite.query("SELECT type FROM embedding_source_failures WHERE type IN ('skill','digest','digest_extracts')").all()).toEqual([]);
        expect(sqlite.query("SELECT namespace FROM knowledge_release_state WHERE namespace IN ('skill','skill_records','digest','digest_extracts')").all()).toEqual([]);
        expect(sqlite.query("SELECT * FROM knowledge_release_state WHERE namespace='sessions'").all()).toEqual(retainedRelease);
        const view = (sqlite.query(`SELECT sql FROM sqlite_master WHERE type='view' AND name='embedding_sources'`).get() as { sql: string }).sql;
        expect(view).not.toContain('skill_records');
        expect(sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally { sqlite.close(); }
    }
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

  it('keeps every earlier table, column, index, view and trigger unless the step that drops it declares why', () => {
    expect(contractionProblems(SCHEMA_STEPS, SCHEMA_STEPS.map((step) => standingAt(step.version)))).toEqual([]);
    const stepTwo = SCHEMA_STEPS[1].statements;
    stepTwo.forEach((s, i) => {
      const dropped = /^DROP TABLE (?:IF EXISTS )?(\w+)/i.exec(s);
      if (!dropped) return;
      const scratch = stepTwo.some((x) => new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${dropped[1]}\\b`).test(x));
      const copied = stepTwo.slice(0, i).some((prev) => new RegExp(`INSERT INTO \\w+ .* FROM ${dropped[1]}\\b`, 'is').test(prev));
      expect({ statement: s, safe: scratch || copied }).toEqual({ statement: s, safe: true });
    });
  });

  it('refuses a step that rebuilds a live table through a rename to a copy it does not declare retired, naming the table', () => {
    const version = SERVER_SCHEMA_VERSION + 1;
    const columns = [...standingAt(SERVER_SCHEMA_VERSION).columns.get('backup_publications')!].map(([name, type]) => `${name} ${type}`).join(', ');
    const rebuild: SchemaStep = { version, statements: ['ALTER TABLE backup_publications RENAME TO _scratch_copy',
      `CREATE TABLE backup_publications (${columns})`, 'DROP TABLE _scratch_copy'] };
    const steps = [...SCHEMA_STEPS, rebuild];
    expect(contractionProblems(steps, standingAfterEach(steps)).filter((problem) => problem.startsWith(`step ${version} `))).toEqual([
      `step ${version} renames table backup_publications to _scratch_copy without declaring it: add { kind: 'table', name: '_scratch_copy', reason } to the step's \`retires\`, or put it back in the same step`,
    ]);
  });

  it('accepts a dropped trigger only when the step creates it again after the drop, on the same table and event and writing the same tables', () => {
    const step = SCHEMA_STEPS.find((x) => x.version === 49)!.statements;
    const prior = standingAt(48).triggers;
    const drops = step.flatMap((sql, i) => { const name = /^DROP TRIGGER IF EXISTS (\w+)/.exec(sql)?.[1]; return name === undefined ? [] : [{ i, name }]; });
    expect(drops.length).toBe(5);
    for (const { i, name } of drops) {
      const create = i + 1;
      const judge = (statements: string[], at = i) => recreatedAfterDrop(statements, at, 'TRIGGER', name, prior.get(name) ?? null);
      expect({ name, shipped: judge([...step]) }).toEqual({ name, shipped: true });
      // The create placed ahead of the drop leaves no trigger standing.
      const reordered = [...step]; [reordered[i], reordered[create]] = [reordered[create], reordered[i]];
      expect({ name, reordered: judge(reordered, create) }).toEqual({ name, reordered: false });
      // A body that writes nothing, and one on another event or table, is not the trigger it replaces.
      for (const [label, edit] of [
        ['no-op body', (sql: string) => sql.replace(/BEGIN[\s\S]*END$/, 'BEGIN SELECT 1; END')],
        ['another event', (sql: string) => sql.replace(/AFTER UPDATE( OF [\w\s,]+?)? ON/, 'AFTER DELETE ON')],
        ['another table', (sql: string) => sql.replace(/ ON (\w+)\n/, ' ON projects\n')],
      ] as const) {
        const edited = [...step]; edited[create] = edit(step[create]);
        expect(edited[create]).not.toBe(step[create]);
        expect({ name, label, accepted: judge(edited) }).toEqual({ name, label, accepted: false });
      }
    }
    expect(recreatedAfterDrop(['DROP TRIGGER IF EXISTS fresh','CREATE TRIGGER IF NOT EXISTS fresh AFTER UPDATE ON spores BEGIN UPDATE spores SET revision=revision+1; END'],0,'TRIGGER','fresh',null)).toBe(false);
    expect(recreatedAfterDrop(['DROP VIEW IF EXISTS v', 'CREATE VIEW IF NOT EXISTS v AS SELECT 1'], 0, 'VIEW', 'v', null)).toBe(true);
    expect(recreatedAfterDrop(['CREATE VIEW IF NOT EXISTS v AS SELECT 1', 'DROP VIEW IF EXISTS v'], 1, 'VIEW', 'v', null)).toBe(false);
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

  it('applies the project-id grammar as a CHECK on every table created or rebuilt by step 2 that has a project_id column', async () => {
    const source = sqliteEnv();
    const promptId = crypto.randomUUID();
    const writerRows = new Map<string, Record<string, unknown>>();
    writerRows.set('object_settlement_intents', { physical: 'fixture', kind: 'upload', key: 'key', generation: 'generation', expires_at: 0 });
    writerRows.set('session_title_work', { session_id: 'grammar-session', mode: 'claim' });
    writerRows.set('release_check_due', { next_at: 0, revision: 'r' });
    writerRows.set('release_work_due', { session_id: 'grammar-session', point: 'session_end', head_sha: 'a', cleanliness: '0', captured_at: 0 });
    writerRows.set('release_propagation_due', { session_id: 'grammar-session', queued_at: 0 });
    writerRows.set('release_state_unresolved', { row_id: 'r', reason: 'duplicate', namespace: 'sessions', record_id: 'r', state: 'unknown', row_json: '{}', reported_at: 0 });
    writerRows.set('session_statistics', { session_id: 'grammar-session', open_session: 0, occurred_day: 0, prompts: 0, tool_calls: 0 });
    writerRows.set('session_attachment_counts', { session_id: 'grammar-session', n: 0 });
    writerRows.set('project_session_days', { day: 0, n: 0 });
    writerRows.set('context_placements', { session_id: 'grammar-session', kind: 'receipt', record_id: 'r', created_at: 0, state: 'selected' });
    writerRows.set('context_placement_days', { day: 0, state: 'selected', n: 0 });
    writerRows.set('task_runtime', { task: 'title-summary', origin: 'manual' });
    writerRows.set('task_due', { run_id: 'grammar-run', task: 'title-summary', origin: 'manual', claimable: 1 });
    writerRows.set('run_live', { run_id: 'grammar-run', task: 'title-summary', status: 'pending', origin: 'manual', claimable: 1 });
    writerRows.set('spore_curation_work', { cluster_key: 'grammar-fixture', members: '[]' });
    writerRows.set('session_served_items', { session_id: 'grammar-session', kind: 'spore', item_id: 'grammar-spore' });
    writerRows.set('search_documents', { kind: 'spore', source_key: 'grammar-spore', record_at: 0, facets: 'grammar' });
    writerRows.set('search_blobs', { blob_key: 'grammar-blob', live_refs: 1, state: 'pending' });
    try {
      expect(await ingestEvent(source.db, { projectId: 'proj_1', machineId: 'machine', tokenId: 'capture', now: 1, bodyBytes: 0, writeOrigin: 'server' }, {
        eventId: crypto.randomUUID(), sessionId: 'grammar-session', kind: 'prompt', createdAt: 1, channel: 'cli',
        producer: { adapter: 'claude-code', version: 'test' }, payload: { promptId, text: 'Grammar fixture', origin: 'user' },
      })).toMatchObject({ persisted: true, projected: true });
      writerRows.set('publish_queue', source.sqlite.query('SELECT * FROM publish_queue LIMIT 1').get() as Record<string, unknown>);
      writerRows.set('machine_capture_heads', source.sqlite.query('SELECT * FROM machine_capture_heads LIMIT 1').get() as Record<string, unknown>);
      writerRows.set('kpi_fact', source.sqlite.query('SELECT * FROM kpi_fact LIMIT 1').get() as Record<string, unknown>);
      await publishFixture(source);
      expect(await markPromptProcessed(source.db, { projectId: 'proj_1' }, promptId)).toBe(true);
      writerRows.set('learning_sessions', source.sqlite.query('SELECT * FROM learning_sessions').get() as Record<string, unknown>);
      writerRows.set('document_publication_facts', source.sqlite.query('SELECT * FROM document_publication_facts LIMIT 1').get() as Record<string, unknown>);
      writerRows.set('extraction_acks', source.sqlite.query('SELECT * FROM extraction_acks').get() as Record<string, unknown>);
    } finally { source.sqlite.close(); }
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
        const specimen = writerRows.get(t);
        if (specimen !== undefined) {
          const row: Record<string, unknown> = { ...specimen, project_id: projectId };
          const fields = cols.map(column => column.name).filter(name => Object.hasOwn(row,name));
          sqlite.query(`INSERT INTO ${t} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`).run(...fields.map(field => row[field]) as never[]);
          return;
        }
        const names = cols.map((c) => c.name);
        // A blob row registers a generation: a UUID.
        // A step row names a kind and an outcome from its own vocabulary.
        const values = cols.map((c) => (c.name === 'project_id' ? `'${projectId}'` : t === 'blobs' && c.name === 'generation' ? `'${crypto.randomUUID()}'`
          : ['document_publication_contributions','document_publication_totals'].includes(t) && c.name === 'kind' ? "'source'"
          : t === 'publication_dependencies' && c.name === 'prerequisite_kind' ? "'read'" : t === 'publication_dependencies' && c.name === 'outcome' ? "'waiting'"
          : t === 'transcripts' && c.name === 'parser_context' ? `'{}'`
          : t === 'embedding_work_state' && c.name === 'kind' ? `'embedding'`
          : t === 'raw_resources' && c.name === 'provenance' ? `'missing'`
          : t === 'raw_resources' && c.name === 'kind' ? `'blob'` : t === 'raw_resources' && c.name === 'classification' ? `'raw'`
          : t === 'processed_resources' && c.name === 'kind' ? `'plan'` : t === 'processed_resources' && c.name === 'classification' ? `'processed'`
          : t === 'agent_runs' && (c.name === 'leased_runner_id' || c.name === 'leased_runner_credential_id') ? 'NULL'
          : t === 'agent_runs' && c.name === 'origin' ? "'manual'"
          : t === 'agent_run_attempts' && c.name === 'settled_seq' ? 'NULL'
          : t === 'agent_run_attempts' && (c.name === 'estimate_usd' || c.name === 'cost_usd') ? '0'
          : t === 'agent_run_attempts' && c.name === 'owner_kind' ? `'member'` : t === 'agent_run_attempts' && c.name === 'runner_id' ? 'NULL'
          : t === 'agent_run_steps' && c.name === 'kind' ? `'read'` : t === 'agent_run_steps' && c.name === 'outcome' ? `'ok'` : t === 'registered_content_proofs' && c.name === 'durable' ? '1'
          : (t === 'session_deletion_jobs' || t === 'transcript_reread_jobs') && c.name === 'state' ? "'running'"
          : t === 'transcript_reread_jobs' && c.name === 'agent' ? 'NULL'
          : t === 'content_scan_checkpoints' && c.name === 'source_kind' ? "'event'"
          : t === 'raw_archive_refs' && c.name === 'source_kind' ? "'transcript'"
          : t === 'raw_archive_refs' && c.name === 'disposition' ? "'hot'"
          : t === 'injection_served_items' && c.name === 'kind' ? "'plan'"
          : t === 'session_artifacts' && c.name === 'kind' ? "'pr'" : t === 'session_artifacts' && c.name === 'url' ? "'https://x'"
          : t === 'prompt_context_answers' && c.name === 'outcome' ? "'empty'"
          : (t === 'embedding_source_state' || t === 'embedding_model_totals') && c.name === 'state' ? "'ready'"
          : t === 'turn_cards' && c.name === 'state' ? "'pending'" : t === 'turn_cards' && c.name === 'signal' ? "'none'"
          : (t === 'session_documents' || t === 'session_chunks') && c.name === 'state' ? "'live'" : t === 'transcript_publication' && c.name === 'state' ? "'active'"
          : t === 'session_chunks' && c.name === 'kind' ? "'page'" : t === 'session_chunks' && c.name === 'encoding' ? "'identity'"
          : c.name === 'scope_reason' || c.name.startsWith('delivered_') || c.name === 'claim' ? 'NULL' : c.name === 'ask_protocol' ? "'v1'"
          : t === 'archive_bundles' && (c.name === 'version' || c.name === 'entry_count') ? '1' : c.type === 'INTEGER' ? '0' : `'x'`));
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
      'publication_dependencies','session_lifecycle_facts','session_title_work','session_statistics','session_attachment_counts','context_placement_days','session_user_prompt_firsts','document_locator_repair',
      'document_owners','document_continuations','document_plan_keys','document_metadata_ready','document_metadata_progress',
      'document_transcript_pins','document_group_pins','document_pin_totals','document_failure_contributions','document_failure_totals','document_rebuild_receipts',
      'document_publication_contributions','document_publication_totals','document_publication_ready',
      'object_settlement_intents', 'attempt_spend', 'attempt_head', 'budget_totals', 'run_head', 'run_bodies', 'run_body_failures', 'run_retirements', 'run_live', 'run_output_membership', 'task_runtime', 'task_due', 'work_daily', 'work_run_contribution', 'work_window_sessions', 'work_window_totals',
      'agent_reports', 'agent_run_attempts', 'agent_run_events', 'agent_run_steps', 'agent_run_write_intents', 'agent_runs', 'agent_state', 'agent_turns',
      'document_due', 'document_publication_facts', 'embedding_due', 'embedding_calibration_state', 'embedding_calibration_population', 'embedding_passed_over', 'embedding_source_state', 'embedding_vector_pages', 'embedding_model_totals', 'embedding_resets', 'embedding_eligible_sources', 'embedding_models', 'embedding_hubness_revision', 'embedding_hubness_commits', 'event_refs', 'archive_bundles', 'attachments', 'blob_release_candidates', 'blob_reservations', 'blobs', 'canopy_maps', 'content_scan_checkpoints', 'embedding_cursors', 'embedding_hubness_members', 'embedding_receipts', 'embedding_retirement_queue', 'embedding_source_failures', 'embedding_versions', 'embedding_work_attention', 'embedding_work_state', 'enrollment_authorities', 'external_grants',
      'extraction_acks', 'injection_served_items', 'kpi_fact', 'knowledge_git_provenance', 'knowledge_release_state', 'machine_capture_heads', 'myco_tool_calls', 'plans', 'prepared_archive_bundles', 'processed_resources', 'project_capabilities', 'project_release_provenance', 'project_remotes', 'project_repositories', 'project_session_counts', 'project_session_days', 'projects', 'context_placements',
       'prompt_context_answers', 'prompt_identity_conflicts',  'publish_queue', 'raw_archive_refs', 'raw_resources', 'registered_content_proofs', 'release_check_due', 'release_propagation_due', 'release_state_unresolved', 'release_work_due', 'resolution_events',  'retired_objects', 'run_reads', 'run_served_material', 'search_blob_chunks', 'search_blob_queue', 'search_blob_refs', 'search_blobs', 'search_documents', 'search_index_status', 'session_artifacts', 'session_chunks', 'session_documents', 'session_edit_paths', 'session_path_build', 'session_turn_entries', 'session_turn_totals', 'session_injections', 'session_pages', 'session_paths', 'session_prompts', 'session_read_facts', 'session_sealed_records', 'session_tombstones',
      'spore_count_facts', 'spore_counts', 'spore_session_counts', 'spore_daily', 'plan_count_facts', 'plan_counts', 'spore_resolution_edges', 'learning_project_counts', 'learning_ready_projects', 'session_served_items',
      'session_deletion_jobs', 'transcript_reread_jobs', 'spore_injections', 'spores', 'storage_cleanup_omissions', 'storage_cleanup_queue', 'storage_usage', 'tags',   'transcript_publication', 'transcript_segments', 'transcripts',
      'learning_sessions', 'turn_cards', 'project_settings', 'spore_curation_work', 'spore_curation_candidates', 'spore_curation_changes', 'spore_curation_cursor', 'spore_curation_owners', 'spore_curation_receipts',
    ].sort());
  });
});

describe('runner sign-in schema upgrade', () => {
  it('defaults a populated v87 runner to its own sign-in on native and emitted D1 migrations', async () => {
    for (const target of ['native', 'd1'] as const) {
      const db = new Database(':memory:');
      try {
        const previous = SCHEMA_STEPS.filter(step => step.version <= 87);
        if (target === 'native') await applySchemaSteps(sqliteD1(db), previous);
        else for (const file of renderMigrationFiles().filter(file => file.name < '0088')) db.exec(file.sql);
        db.run("INSERT INTO runners(id,name,created_at) VALUES ('rn_existing','existing',1)");
        if (target === 'native') await applySchemaSteps(sqliteD1(db), SCHEMA_STEPS.filter(step => step.version === 88));
        else db.exec(readFileSync(join(MIGRATIONS, '0088_v88.sql'), 'utf8'));
        expect(db.query("SELECT name,credential_choices FROM runners WHERE id = 'rn_existing'").get())
          .toEqual({ name: 'existing', credential_choices: '{}' });
        expect(version(db)).toBe('88');
      } finally { db.close(); }
    }
  });
});

it('schema 101 only adds default-zero spore revisions and a stable dispatch boundary', async () => {
  const sqlite = fresh();
  const db = sqliteD1(sqlite);
  try {
    await applySchemaSteps(db, SCHEMA_STEPS.filter(step => step.version < 101));
    sqlite.run("INSERT INTO projects(project_id,name,created_at) VALUES ('proj_guard','guard',1)");
    sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES ('guard','guard','built-in',1,1)");
    sqlite.run("INSERT INTO spores(project_id,id,agent_id,observation_type,status,content,created_at) VALUES ('proj_guard','old','guard','gotcha','superseded','held',1)");
    const before = sqlite.query('SELECT * FROM spores').get() as Record<string, unknown>;
    const indexes = sqlite.query("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='spores' ORDER BY name").all();
    expect(await applySchemaSteps(db, SCHEMA_STEPS.filter(step => step.version === 101))).toEqual([101]);
    expect(sqlite.query('SELECT * FROM spores').get()).toEqual({ ...before, revision: 0 });
    expect(sqlite.query("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='spores' ORDER BY name").all()).toEqual(indexes);
    const stamp = sqlite.query("SELECT value FROM schema_meta WHERE key='guard_enabled_at'").get();
    expect(Number((stamp as { value: string }).value)).toBeGreaterThan(0);
    expect(await applySchemaSteps(db, SCHEMA_STEPS.filter(step => step.version === 101))).toEqual([]);
    expect(sqlite.query("SELECT value FROM schema_meta WHERE key='guard_enabled_at'").get()).toEqual(stamp);
  } finally { sqlite.close(); }
});

it('schema 107 installs the source-range path on empty and populated prompt storage on native and emitted D1 migrations', async () => {
  const range = "SELECT sql FROM sqlite_master WHERE name='idx_view_prompts_source_range'";
  for (const target of ['native', 'd1'] as const) for (const populated of [false, true]) {
    const db = new Database(':memory:');
    try {
      const previous = SCHEMA_STEPS.filter(step => step.version <= 106);
      if (target === 'native') await applySchemaSteps(sqliteD1(db), previous);
      else for (const file of renderMigrationFiles().filter(file => file.name < '0107')) db.exec(file.sql);
      if (populated) db.run(`INSERT INTO view_prompts(project_id,instance_id,session_id,prompt_id,origin,content_hash,created_at,updated_at,received_at)
        VALUES ('proj_range','inst','sess','prompt','live','h',1,1,1)`);
      const apply = target === 'native'
        ? () => applySchemaSteps(sqliteD1(db), SCHEMA_STEPS.filter(step => step.version === 107))
        : async () => {
          // Bun's multi-statement exec reports only the last statement's error, so each emitted statement runs alone.
          const statements = readFileSync(join(MIGRATIONS, '0107_v107.sql'), 'utf8').split(/;\n/).map(sql => sql.replace(/^(?:\s*--[^\n]*\n)*/, '').trim()).filter(Boolean);
          db.transaction(() => { for (const sql of statements) db.run(sql); })();
        };
      await apply();
      expect({ target, version: version(db), index: db.query(range).get() }).toEqual({ target, version: '107',
        index: { sql: 'CREATE INDEX idx_view_prompts_source_range ON view_prompts(project_id,instance_id,source_transcript_id,source_offset,source_end,prompt_id)' } });
    } finally { db.close(); }
  }
});

it('retires content storage only after documents are live, preserving the catalog and capture', () => {
  const sqlite = fresh();
  try {
    for (const prior of SCHEMA_STEPS.filter(step => step.version < 117)) step(sqlite, prior);
    sqlite.run(`INSERT INTO projects(project_id,name,created_at) VALUES('retirement','Retirement',0)`);
    sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('retirement','session','machine','token',0,0)`);
    sqlite.run(`INSERT INTO session_documents(project_id,session_id,state,updated_at) VALUES('retirement','session','convert',0)`);
    sqlite.run(`INSERT INTO prompt_batches(project_id,prompt_id,session_id,event_id,token_id,text,origin,created_at,updated_at,received_at,content_hash)
      VALUES('retirement','prompt','session','event','token','retained body','user',1,1,1,'hash')`);
    const retirement = SCHEMA_STEPS.find(step => step.version === 117)!;
    expect(() => step(sqlite, retirement)).toThrow('documents_retirement_incomplete');
    expect(version(sqlite)).toBe('116');
    sqlite.run(`UPDATE session_documents SET state='live',generation=1 WHERE project_id='retirement'`);
    sqlite.run(`UPDATE raw_provenance_backfill SET source=5,cursor_project='retirement',cursor_id='old',complete=0 WHERE id=1`);
    sqlite.run(`INSERT INTO view_instances(project_id,session_id,instance_id,parser_version,base,state,created_at) VALUES('retirement','session','instance',1,'full','live',1)`);
    sqlite.run(`INSERT INTO view_checkpoints(project_id,session_id,instance_id,transcript_id,ordinal,start_offset,parsed_offset) VALUES('retirement','session','instance','transcript',0,0,10)`);
    sqlite.run(`INSERT INTO view_checkpoint_chunks(project_id,session_id,instance_id,transcript_id,cursor_offset,chunk_index,chunk_count,payload) VALUES('retirement','session','instance','transcript',10,0,1,'{}')`);
    for (const next of SCHEMA_STEPS.filter(step => step.version >= 117 && step.version < 265)) step(sqlite, next);
    for (const table of DROPPED_CONTENT_TABLES) expect(sqlite.query(`SELECT 1 FROM sqlite_master WHERE name=?`).get(table)).not.toBeNull();
    expect(sqlite.query(`SELECT session_id FROM sessions WHERE project_id='retirement'`).get()).toEqual({session_id:'session'});
    expect(sqlite.query(`SELECT generation FROM session_documents WHERE project_id='retirement'`).get()).toEqual({generation:1});
    expect(sqlite.query(`SELECT source,cursor_project,cursor_id,complete FROM raw_provenance_backfill WHERE id=1`).get())
      .toEqual({source:0,cursor_project:'',cursor_id:'',complete:0});
  } finally { sqlite.close(); }
});

it('backfills only the reference catalog and retains content tables', () => {
  for (const {statements} of RETIREMENT_SCHEMA_STEPS) for(const sql of statements) {
    expect(sql).not.toMatch(/UPDATE events|CREATE (?:UNIQUE )?INDEX[^;]* ON events/i);
    const dropped=/^DROP TABLE (?:IF EXISTS )?(\w+)/i.exec(sql)?.[1];
    if(dropped!==undefined)expect(['_v117_documents_guard','_v117_reference_ranges']).toContain(dropped);
  }
});

describe('content storage removal, steps 265 to 464', () => {
  const objectsOf = (sqlite: Database) => sqlite.query(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const shadow = (name: string) => DROPPED_CONTENT.has(name.replace(/_(data|idx|docsize|config)$/, ''));
  const dataTables = (sqlite: Database) => objectsOf(sqlite).filter(o => o.type === 'table' && o.name !== 'schema_meta' && !o.name.endsWith('_fts') && !/_fts_(data|idx|docsize|config)$/.test(o.name)).map(o => o.name);
  const RANGED = ['tool_calls', 'view_tool_calls', 'responses', 'prompt_batches', 'view_prompts', 'view_responses', 'fact_classes', 'material_versions'];
  const ROWS = (table: string) => RANGED.includes(table) ? 100 : 2;
  /** Rows in every table, references and checks off, so each drop removes rows, each range deletes some, and each kept table has rows to keep. */
  const seed = (sqlite: Database) => {
    sqlite.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON');
    for (const name of dataTables(sqlite)) {
      const cols = sqlite.query(`PRAGMA table_info(${name})`).all() as { name: string; type: string }[];
      for (let k = 0; k < ROWS(name); k++) {
        try { sqlite.query(`INSERT OR IGNORE INTO ${name} (${cols.map(c => c.name).join(',')}) VALUES (${cols.map(c => /INT|REAL|NUM/i.test(c.type) ? String(k + 1) : `'{"k":${k}}'`).join(',')})`).run(); } catch {}
      }
    }
    sqlite.exec('PRAGMA ignore_check_constraints = OFF; PRAGMA foreign_keys = ON');
  };
  const through = DROP_CONTENT_SCHEMA_STEPS.at(-1)!.version;
  const keptRows = (sqlite: Database) => new Map(dataTables(sqlite).filter(name => !DROPPED_CONTENT.has(name) && name !== DROP_RANGES_TABLE)
    .map(name => [name, JSON.stringify(sqlite.query(`SELECT * FROM ${name}`).all())]));
  const at264 = () => { const sqlite = fresh(); for (const prior of SCHEMA_STEPS.filter(s => s.version < 265)) step(sqlite, prior); seed(sqlite); return sqlite; };

  it('drops every trigger and index of the retired tables first, deletes their rows in ranges, and leaves every kept row and a fresh store\'s schema', () => {
    const sqlite = at264();
    const store = fresh();
    try {
      const before = objectsOf(sqlite);
      expect(before.filter(o => (o.type === 'trigger' || o.type === 'view') && !DROPPED_CONTENT.has(o.tbl_name) && namesDroppedContent(o.sql!)).map(o => o.name)).toEqual([]);
      expect(DROP_CONTENT_SCHEMA_STEPS[0]!.statements.flatMap(sql => /^DROP TRIGGER IF EXISTS (\w+)/.exec(sql)?.[1] ?? []).sort())
        .toEqual(before.filter(o => o.type === 'trigger' && DROPPED_CONTENT.has(o.tbl_name)).map(o => o.name).sort());
      expect(DROP_CONTENT_SCHEMA_STEPS.flatMap(s => s.statements).flatMap(sql => /^DROP INDEX IF EXISTS (\w+)/.exec(sql)?.[1] ?? []).sort())
        .toEqual(before.filter(o => o.type === 'index' && DROPPED_CONTENT.has(o.tbl_name) && o.sql !== null).map(o => o.name).sort());
      const count = (table: string) => (sqlite.query(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
      for (const table of DROPPED_CONTENT_TABLES.filter(t => !t.endsWith('_fts'))) expect({ table, rows: count(table) }).toEqual({ table, rows: ROWS(table) });
      const kept = keptRows(sqlite);
      for (const table of ['event_refs', 'blobs', 'session_documents', 'session_read_facts', 'storage_cleanup_queue', 'object_releases', 'blob_release_candidates', 'search_blob_queue']) expect({ table, seeded: (kept.get(table) ?? '[]').length > 2 }).toEqual({ table, seeded: true });
      const keptViolations = () => (sqlite.query('PRAGMA foreign_key_check').all() as { table: string }[]).filter(v => !DROPPED_CONTENT.has(v.table));
      const violations = keptViolations();
      const firstDrop = DROP_CONTENT_SCHEMA_STEPS.find(s => s.statements[0]!.startsWith('DROP TABLE'))!.version;
      for (const next of SCHEMA_STEPS.filter(s => s.version >= 265 && s.version < firstDrop)) step(sqlite, next);
      expect(RANGED.map(table => ({ table, rows: count(table) }))).toEqual(RANGED.map(table => ({ table, rows: 0 })));
      expect(DROPPED_CONTENT_TABLES.filter(t => !t.endsWith('_fts') && !RANGED.includes(t)).map(table => count(table))).not.toContain(0);
      for (const next of SCHEMA_STEPS.filter(s => s.version >= firstDrop && s.version <= through)) step(sqlite, next);
      expect(version(sqlite)).toBe(String(through));
      const after = objectsOf(sqlite);
      expect(after.filter(o => DROPPED_CONTENT.has(o.tbl_name) || o.tbl_name === DROP_RANGES_TABLE || shadow(o.name))).toEqual([]);
      expect(keptRows(sqlite)).toEqual(kept);
      expect(keptViolations()).toEqual(violations);
      for (const f of renderMigrationFiles().filter(file => Number.parseInt(file.name, 10) <= through)) store.exec(f.sql);
      expect(after).toEqual(objectsOf(store));
    } finally { sqlite.close(); store.close(); }
  });

  it('leaves a store at the step before a failed drop step, its rows and objects unchanged', async () => {
    const sqlite = at264();
    const db = sqliteD1(sqlite);
    try {
      for (const pattern of [/^DROP TRIGGER/, /^DELETE FROM tool_calls/, /^DROP TABLE IF EXISTS prompt_batches_fts/, /^DROP TABLE IF EXISTS transcript_parser_state_chunks/]) {
        const sample = SCHEMA_STEPS.find(s => s.version >= 265 && pattern.test(s.statements[0]!))!;
        await applySchemaSteps(db, SCHEMA_STEPS.filter(s => s.version < sample.version));
        const probe = /DELETE FROM (\w+)/.exec(sample.statements[0]!)?.[1] ?? 'view_instances';
        const held = { version: String(sample.version - 1), objects: objectsOf(sqlite), rows: keptRows(sqlite), probe: sqlite.query(`SELECT COUNT(*) n FROM ${probe}`).get() };
        await expect(db.batch([...sample.statements.map(sql => db.prepare(sql)), db.prepare('INSERT INTO storage_content_guard(ok) VALUES(0)')])).rejects.toThrow();
        expect({ version: version(sqlite), objects: objectsOf(sqlite), rows: keptRows(sqlite), probe: sqlite.query(`SELECT COUNT(*) n FROM ${probe}`).get() }).toEqual(held);
      }
    } finally { sqlite.close(); }
  });
});

it('adds card fields without rewriting legacy cards or rebuilding their search index', async () => {
  const sqlite = fresh();
  try {
    const fieldStep = SCHEMA_STEPS.find(step => step.version === 465)!;
    for (const stepBefore of SCHEMA_STEPS.filter(step => step.version < fieldStep.version)) step(sqlite, stepBefore);
    for (let row = 0; row < 100; row++) sqlite.run("INSERT INTO turn_cards(project_id,session_id,turn_key,state,card,created_at) VALUES('project','session',?,'carded','Done: legacyneedle',1)", [String(row)]);
    const changes = () => (sqlite.query('SELECT total_changes() n').get() as { n: number }).n;
    const before = changes();
    await applySchemaSteps(sqliteD1(sqlite), [fieldStep]);
    const MAX_METADATA_WRITES = 4;
    expect(changes() - before).toBeLessThanOrEqual(MAX_METADATA_WRITES);
    expect(sqlite.query("SELECT COUNT(*) n FROM turn_cards WHERE fields IS NULL AND card='Done: legacyneedle'").get()).toEqual({ n: 100 });
    expect(sqlite.query("SELECT COUNT(*) n FROM turn_cards_fts WHERE turn_cards_fts MATCH 'legacyneedle'").get()).toEqual({ n: 100 });
  } finally { sqlite.close(); }
});


it('retains each cluster first attempt from canonical run subjects across the daily-allowance upgrade', async () => {
  const sqlite = fresh();
  try {
    await applySchemaSteps(sqliteD1(sqlite),SCHEMA_STEPS.filter(step=>step.version<700));
    sqlite.exec(`INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','p',1),('proj_2','q',1);
      INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','Agent','built-in',1,1);
      INSERT INTO spore_curation_work(project_id,cluster_key,members,failures) VALUES('proj_1','cluster','[]',2),('proj_2','cluster','[]',1),('proj_1','unclaimed','[]',0);
      INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,subject) VALUES
        ('proj_1','first','agent','curate-spores','failed',100,'curation:proj_1:cluster'),
        ('proj_1','retry','agent','curate-spores','failed',200,'curation:proj_1:cluster'),
        ('proj_2','other','agent','curate-spores','failed',50,'curation:proj_2:cluster');`);
    await applySchemaSteps(sqliteD1(sqlite),SCHEMA_STEPS.filter(step=>step.version===700));
    expect(sqlite.query('SELECT project_id,cluster_key,first_started_at FROM spore_curation_work ORDER BY project_id,cluster_key').all()).toEqual([
      {project_id:'proj_1',cluster_key:'cluster',first_started_at:100},
      {project_id:'proj_1',cluster_key:'unclaimed',first_started_at:null},
      {project_id:'proj_2',cluster_key:'cluster',first_started_at:50},
    ]);
    expect(version(sqlite)).toBe('700');
  } finally {sqlite.close();}
});

it('removes inventory facts while preserving spore history and curation lifecycle state in schema 709', async () => {
  const sqlite = fresh();
  try {
    await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(step => step.version < 709));
    sqlite.exec(`INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','p',1);
      INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','Agent','built-in',1,1);
      INSERT INTO agent_runs(project_id,id,agent_id,task,status,repository_files) VALUES('proj_1','run','agent','curate-spores','running','["src/gone.ts"]');
      INSERT INTO spores(project_id,id,agent_id,content,observation_type,file_path,created_at) VALUES('proj_1','spore','agent','Atomic counters survive their code','gotcha','src/gone.ts',1);
      INSERT INTO spore_curation_work(project_id,cluster_key,members,run_id) VALUES('proj_1','group','[{"id":"spore","revision":0}]','run');
      INSERT INTO spore_curation_candidates(project_id,run_id,spore_id,revision,read,currency) VALUES('proj_1','run','spore',0,1,'{"available":true,"missing":["src/gone.ts"]}');`);
    const spore = sqlite.query('SELECT * FROM spores').get();
    const work = sqlite.query('SELECT * FROM spore_curation_work').get();
    await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(step => step.version === 709));
    expect(sqlite.query('SELECT * FROM spores').get()).toEqual(spore);
    expect(sqlite.query('SELECT * FROM spore_curation_work').get()).toEqual(work);
    expect(sqlite.query('SELECT * FROM spore_curation_candidates').all())
      .toEqual([{project_id:'proj_1',run_id:'run',spore_id:'spore',revision:0,read:1}]);
    for (const [table,column] of [['agent_runs','repository_files'],['spore_curation_candidates','currency']]) {
      expect(sqlite.query(`PRAGMA table_info(${table})`).all().some(row => (row as {name:string}).name === column)).toBe(false);
    }
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name LIKE 'curation_inventory_%'").all()).toEqual([]);
    expect(sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { sqlite.close(); }
});
