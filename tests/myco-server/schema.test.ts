import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SCHEMA_DDL, SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { MEMBER_TOKEN_BYTE_QUOTA, SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';

const table = (name: string) => SCHEMA_DDL.find((s) => new RegExp(`CREATE TABLE IF NOT EXISTS ${name}\\b`).test(s))!;

/** The tables schema v2 introduces; every one is project-scoped and attributed. */
const V2_TABLES = ['blobs', 'prompt_batches', 'tool_calls', 'responses', 'plans', 'attachments', 'transcripts', 'transcript_segments', 'tags'];
const CONTINUED_TABLES = ['plans', 'transcripts'];

function applied(): Database {
  const sqlite = new Database(':memory:');
  for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
  return sqlite;
}
const columns = (sqlite: Database, t: string) => sqlite.query(`PRAGMA table_info(${t})`).all() as { name: string; type: string; notnull: number; pk: number }[];
const indexes = (sqlite: Database, t: string) => (sqlite.query(`PRAGMA index_list(${t})`).all() as { name: string; origin: string }[]).filter((i) => i.origin === 'c');
const indexColumns = (sqlite: Database, i: string) => (sqlite.query(`PRAGMA index_info(${i})`).all() as { name: string }[]).map((c) => c.name);

describe('server schema', () => {
  it('scopes sessions and events by project and attributes every write to a token', () => {
    expect(table('sessions')).toMatch(/PRIMARY KEY \(project_id, session_id\)/);
    expect(table('events')).toMatch(/PRIMARY KEY \(project_id, event_id\)/);
    expect(table('events')).toMatch(/token_id\s+TEXT NOT NULL/);
    expect(table('sessions')).toMatch(/created_by_token_id TEXT NOT NULL/);
  });

  it('gives project_id referential identity and tracks token write volume with a named quota constraint', () => {
    expect(table('projects')).toBeDefined();
    expect(table('member_tokens')).toMatch(/REFERENCES projects/);
    expect(table('member_tokens')).toMatch(/bytes_written INTEGER NOT NULL DEFAULT 0/);
    expect(table('member_tokens')).toMatch(new RegExp(`CONSTRAINT member_tokens_quota CHECK \\(bytes_written <= ${MEMBER_TOKEN_BYTE_QUOTA}\\)`));
    expect(table('events')).toMatch(/envelope_hash TEXT NOT NULL/);
  });

  it('adds producer identity, the spill key, and payload bytes to events, and only facts to sessions', () => {
    const sqlite = applied();
    const events = columns(sqlite, 'events').map((c) => c.name);
    expect(events).toEqual(expect.arrayContaining(['producer_adapter', 'producer_version', 'blob_key', 'payload_bytes']));
    const sessions = columns(sqlite, 'sessions').map((c) => c.name);
    expect(sessions).toEqual(['project_id', 'session_id', 'machine_id', 'created_by_token_id', 'first_received_at', 'last_received_at', 'agent', 'branch', 'started_at', 'ended_at', 'origin_path', 'parent_session_id', 'parent_reason', 'facts_event_id']);
    expect(sessions.some((c) => /count|canopy|transport|injection/.test(c))).toBe(false);
  });

  it('keeps every v2 table project-led, attributed, receipt-stamped, and free of BLOB columns', () => {
    const sqlite = applied();
    for (const t of V2_TABLES) {
      const cols = columns(sqlite, t);
      const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      expect({ t, first: pk[0] }).toEqual({ t, first: 'project_id' });
      const byName = new Map(cols.map((c) => [c.name, c]));
      expect({ t, projectNotNull: byName.get('project_id')!.notnull }).toEqual({ t, projectNotNull: 1 });
      if (t !== 'tags') {
        expect({ t, tokenNotNull: byName.get('token_id')?.notnull }).toEqual({ t, tokenNotNull: 1 });
        expect({ t, receiptNotNull: byName.get('received_at')?.notnull ?? byName.get('first_received_at')?.notnull }).toEqual({ t, receiptNotNull: 1 });
      }
      for (const c of cols) {
        expect({ t, c: c.name, blob: c.type === 'BLOB' }).toEqual({ t, c: c.name, blob: false });
        if (c.name.endsWith('_at')) expect({ t, c: c.name, type: c.type }).toEqual({ t, c: c.name, type: 'INTEGER' });
      }
      for (const i of indexes(sqlite, t)) expect({ t, i: i.name, first: indexColumns(sqlite, i.name)[0] }).toEqual({ t, i: i.name, first: 'project_id' });
    }
    for (const t of CONTINUED_TABLES) {
      const machine = columns(sqlite, t).find((c) => c.name === 'machine_id')!;
      expect({ t, machineNotNull: machine.notnull }).toEqual({ t, machineNotNull: 1 });
    }
    for (const s of SCHEMA_DDL) expect(s).not.toMatch(/\bgrove_id\b/);
  });

  it('is idempotent by construction: every create carries IF NOT EXISTS, and a scratch guard table is dropped before it is created and again once it is checked', () => {
    const statements = SCHEMA_STEPS.flatMap((x) => x.statements);
    const scratch = /^CREATE TABLE (\w*_guard_\w+)/;
    for (const s of statements) {
      if (!/^CREATE /.test(s)) continue;
      const guard = scratch.exec(s);
      if (guard) {
        expect(statements.filter((x) => x === `DROP TABLE IF EXISTS ${guard[1]}`).length).toBe(1);
        expect(statements.filter((x) => x === `DROP TABLE ${guard[1]}`).length).toBe(1);
        continue;
      }
      expect(s).toMatch(/IF NOT EXISTS/);
    }
  });

  it('records the build version last and applies into real SQLite', () => {
    const sqlite = applied();
    expect((sqlite.query(`SELECT value FROM schema_meta WHERE key='version'`).get() as any).value).toBe(String(SERVER_SCHEMA_VERSION));
    expect(SCHEMA_STEPS[SCHEMA_STEPS.length - 1].version).toBe(SERVER_SCHEMA_VERSION);
  });
});
