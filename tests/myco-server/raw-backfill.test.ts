import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { RAW_BACKFILL_BATCH, RAW_BACKFILL_BUDGET, rawBackfill } from '@myco-server-worker/core/raw-backfill.js';
import { RawResourceReader } from '@myco-server-worker/core/raw-resources.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { sqliteD1 } from './helpers/d1.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { BACKFILL_PROJECTS, historicalBackfillSql, HISTORICAL_BLOBS, HISTORICAL_EVENTS, HISTORICAL_PLANS, HISTORICAL_TRANSCRIPTS } from './helpers/raw-backfill-fixture.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const MAX_PASSES = 3;

function historical(): Database {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const step of SCHEMA_STEPS.filter((step) => step.version < 71)) for (const statement of step.statements) sqlite.exec(statement);
  for (const statement of historicalBackfillSql(NOW)) sqlite.exec(statement);
  return sqlite;
}

const count = (sqlite: Database, table: string): number => (sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const fingerprint = async (sqlite: Database, table: string): Promise<string> => {
  const rows = sqlite.query(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => {
    if (table !== 'events') return row;
    const { raw_revision: _revision, ...original } = row as Record<string, unknown>;
    return original;
  });
  return sha256Hex(JSON.stringify(rows));
};

function sourcePageGate(sqlite: Database, pages: number[]): RelationalStore {
  const db = sqliteD1(sqlite);
  const observe = (sql: string, statement: PreparedStatement): PreparedStatement => ({
    ...statement,
    bind: (...values) => observe(sql, statement.bind(...values)),
    all: async <T = Record<string, unknown>>() => {
      const result = await statement.all<T>();
      if (sql.startsWith('SELECT s.project_id,') && sql.includes('AS resource_id FROM')) {
        pages.push(result.results.length);
        expect(result.results.length).toBeLessThanOrEqual(RAW_BACKFILL_BATCH);
      }
      return result;
    },
  });
  return { ...db, prepare: (sql) => observe(sql, db.prepare(sql)) };
}

describe('bounded raw provenance backfill correction gates', () => {
  it('attests the selected page before advancing past a concurrent earlier insertion', async () => {
    const sqlite = historical();
    try {
      for (const statement of SCHEMA_STEPS.find((step) => step.version === 71)!.statements) sqlite.exec(statement);
      const db = sqliteD1(sqlite);
      const selected = sqlite.query(`SELECT project_id, key FROM blobs ORDER BY project_id, key LIMIT ${RAW_BACKFILL_BATCH}`).all();
      const injectedKey = '0'.repeat(63) + '-';
      let injected = false;
      const concurrent: RelationalStore = {
        ...db,
        batch: async (statements) => {
          if (!injected) {
            sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation)
              VALUES (?, ?, 1, 'text/plain', 'credential_backfill', ?, '00000000-0000-4000-8000-000000000001')`, [BACKFILL_PROJECTS[0], injectedKey, NOW]);
            injected = true;
          }
          return db.batch(statements);
        },
      };
      const { rawBackfill } = await import('@myco-server-worker/core/raw-backfill.js');
      expect(await rawBackfill(concurrent, NOW, { budget: { calls: 6, wallMs: 2_000 } })).toEqual({ changed: RAW_BACKFILL_BATCH, more: true });
      expect(injected).toBe(true);
      for (const row of selected as Array<{ project_id: string; key: string }>) {
        expect(sqlite.query(`SELECT owner_member_id FROM raw_resources WHERE kind = 'blob' AND project_id = ? AND resource_id = ?`).get(row.project_id, row.key)).toEqual({ owner_member_id: 'member_backfill' });
      }
      const last = selected.at(-1) as { project_id: string; key: string };
      expect(sqlite.query('SELECT cursor_project, cursor_id FROM raw_provenance_backfill').get()).toEqual({ cursor_project: last.project_id, cursor_id: last.key });
    } finally { sqlite.close(); }
  });

  it('stops before the elapsed deadline and never exceeds the statement allowance', async () => {
    const sqlite = historical();
    try {
      for (const sql of SCHEMA_STEPS.find(s => s.version === 71)!.statements) sqlite.exec(sql);
      const db = sqliteD1(sqlite);
      let elapsed = 0;
      let commits = 0;
      const timed: RelationalStore = { ...db, batch: async statements => {
        const result = await db.batch(statements);
        commits++; elapsed += 40; return result;
      }};
      expect(await rawBackfill(timed, NOW, { clock: () => elapsed, budget: { calls: 120, wallMs: 100 } }))
        .toEqual({ changed: RAW_BACKFILL_BATCH * 2, more: true });
      expect(commits).toBe(2);
      expect(elapsed).toBeLessThan(100);
      let statements = 0;
      const counted = sqliteD1(sqlite, { onSql: () => { statements++; } });
      expect((await rawBackfill(counted, NOW, { clock: () => 0, budget: { calls: 12, wallMs: 100 } })).more).toBe(true);
      expect(statements).toBeLessThanOrEqual(12);
      expect(statements).toBeGreaterThan(6);
      sqlite.exec("UPDATE raw_provenance_backfill SET source = 2, cursor_project = '', cursor_id = '', complete = 0 WHERE id = 1");
      statements = 0;
      expect((await rawBackfill(counted, NOW, { clock: () => 0, budget: { calls: 12, wallMs: 100 } })).more).toBe(true);
      expect(statements).toBe(12);
      const checkpoint = sqlite.query('SELECT * FROM raw_provenance_backfill').all();
      expect(await rawBackfill(counted, NOW, { budget: { calls: 5, wallMs: 100 } })).toEqual({ changed: 0, more: true });
      expect(await rawBackfill(counted, NOW, { budget: { calls: 120, wallMs: 0 } })).toEqual({ changed: 0, more: true });
      expect(sqlite.query('SELECT * FROM raw_provenance_backfill').all()).toEqual(checkpoint);
    } finally { sqlite.close(); }
  });

  it('resumes an interrupted run from its committed page and keeps first attribution on replay', async () => {
    let sqlite = historical();
    try {
      for (const sql of SCHEMA_STEPS.find(s => s.version === 71)!.statements) sqlite.exec(sql);
      const db = sqliteD1(sqlite);
      let commits = 0;
      const interrupted: RelationalStore = { ...db, batch: async statements => {
        if (commits === 1) throw new Error('interrupted between pages');
        const result = await db.batch(statements); commits++; return result;
      }};
      await expect(rawBackfill(interrupted, NOW)).rejects.toThrow('interrupted between pages');
      expect(count(sqlite, 'raw_resources')).toBe(RAW_BACKFILL_BATCH);
      const checkpoint = sqlite.query('SELECT * FROM raw_provenance_backfill').all();
      const committed = sqlite.query('SELECT * FROM raw_resources ORDER BY rowid').all();
      const image = sqlite.serialize(); sqlite.close(); sqlite = Database.deserialize(image);
      sqlite.exec('PRAGMA foreign_keys = ON');
      expect(sqlite.query('SELECT * FROM raw_provenance_backfill').all()).toEqual(checkpoint);
      sqlite.exec("UPDATE machine_claims SET member_id = 'member_backfill_other' WHERE machine_id = 'machine_backfill'");
      sqlite.exec("UPDATE member_credentials SET member_id = 'member_backfill_other' WHERE id = 'credential_backfill'");
      expect((await rawBackfill(sqliteD1(sqlite), NOW + 1, { budget: { calls: 6, wallMs: 2_000 } })).changed).toBe(RAW_BACKFILL_BATCH);
      expect(sqlite.query(`SELECT * FROM raw_resources ORDER BY rowid LIMIT ${RAW_BACKFILL_BATCH}`).all()).toEqual(committed);
      sqlite.exec("UPDATE raw_provenance_backfill SET source = 0, cursor_project = '', cursor_id = '' WHERE id = 1");
      expect((await rawBackfill(sqliteD1(sqlite), NOW + 2, { budget: { calls: 6, wallMs: 2_000 } })).changed).toBe(0);
      expect(sqlite.query(`SELECT * FROM raw_resources ORDER BY rowid LIMIT ${RAW_BACKFILL_BATCH}`).all()).toEqual(committed);
      let done = false;
      for (let pass = 0; pass < MAX_PASSES; pass++) if (!(await rawBackfill(sqliteD1(sqlite), NOW + 3 + pass)).more) { done = true; break; }
      expect(done).toBe(true);
      expect(count(sqlite, 'raw_resources')).toBe(HISTORICAL_BLOBS + HISTORICAL_TRANSCRIPTS);
      expect(sqlite.query(`SELECT * FROM raw_resources ORDER BY rowid LIMIT ${RAW_BACKFILL_BATCH}`).all()).toEqual(committed);
    } finally { sqlite.close(); }
  });

  it('adds schema without copying the historical event log or granting pending raw references', async () => {
    const sqlite = historical();
    try {
      const before = await fingerprint(sqlite, 'events');
      for (const statement of SCHEMA_STEPS.find((step) => step.version === 71)!.statements) sqlite.exec(statement);
      expect(count(sqlite, 'raw_resources')).toBe(0);
      expect(count(sqlite, 'processed_resources')).toBe(0);
      expect(count(sqlite, 'events')).toBe(HISTORICAL_EVENTS + HISTORICAL_PLANS);
      const current = sqlite.query(`SELECT complete FROM raw_provenance_backfill WHERE id = 1`).get();
      expect(current).toEqual({ complete: 0 });
      const reader = new RawResourceReader({ db: sqliteD1(sqlite), blobs: memoryBlobStore() }, { projectId: BACKFILL_PROJECTS[0] }, { kind: 'member', memberId: 'member_backfill' });
      expect(await reader.allows({ kind: 'blob', id: '0'.repeat(64) }, 'read')).toBe(false);
      expect(await reader.allows({ kind: 'transcript', id: 'retained' }, 'read')).toBe(false);
      expect(await reader.event('raw-event-00000')).toBeNull();
      const after = sqlite.query(`SELECT * FROM events ORDER BY rowid`).all().map((row) => {
        const { raw_revision: _revision, ...original } = row as Record<string, unknown>;
        return original;
      });
      expect(await sha256Hex(JSON.stringify(after))).toBe(before);
    } finally { sqlite.close(); }
  });

  it('bounds every pass, persists its checkpoint across a restart, retains pruned ownership and preserves source bytes', async () => {
    let sqlite = historical();
    try {
      for (const statement of SCHEMA_STEPS.find((step) => step.version === 71)!.statements) sqlite.exec(statement);
      expect(count(sqlite, 'raw_resources')).toBe(0);
      const originals = await Promise.all(['blobs', 'events', 'transcripts', 'transcript_segments', 'plans', 'prompt_batches', 'responses', 'tool_calls'].map(async (table) => ({ table, hash: await fingerprint(sqlite, table) })));
      const { RAW_BACKFILL_BATCH, rawBackfill } = await import('@myco-server-worker/core/raw-backfill.js');
      expect(RAW_BACKFILL_BATCH).toBe(500);
      const pages: number[] = [];
      let completed = false;
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        const provenanceCount = () => count(sqlite, 'raw_resources') + count(sqlite, 'processed_resources') + count(sqlite, 'raw_credentials');
        const previous = provenanceCount();
        const result = await rawBackfill(sourcePageGate(sqlite, pages), NOW + pass);
        expect(result.changed).toBeLessThanOrEqual(RAW_BACKFILL_BATCH * RAW_BACKFILL_BUDGET.calls / 6);
        expect(result.changed).toBeGreaterThanOrEqual(0);
        const added = provenanceCount() - previous;
        expect(added).toBeLessThanOrEqual(RAW_BACKFILL_BATCH * RAW_BACKFILL_BUDGET.calls / 6);
        expect(added).toBeGreaterThanOrEqual(0);
        expect(result.changed).toBe(added);
        if (pass === 0) {
          expect(result.more).toBe(true);
          const checkpoint = sqlite.query(`SELECT * FROM raw_provenance_backfill`).all();
          const provenance = sqlite.query(`SELECT * FROM raw_resources ORDER BY project_id, kind, resource_id, reference_id`).all();
          const image = sqlite.serialize();
          sqlite.close();
          sqlite = Database.deserialize(image);
          sqlite.exec('PRAGMA foreign_keys = ON');
          expect(sqlite.query(`SELECT * FROM raw_provenance_backfill`).all()).toEqual(checkpoint);
          expect(sqlite.query(`SELECT * FROM raw_resources ORDER BY project_id, kind, resource_id, reference_id`).all()).toEqual(provenance);
        }
        if (!result.more) { completed = true; break; }
      }
      expect(completed).toBe(true);
      expect(pages.length).toBeGreaterThan(20);
      expect(sqlite.query(`SELECT complete FROM raw_provenance_backfill WHERE id = 1`).get()).toEqual({ complete: 1 });
      expect(count(sqlite, 'raw_resources')).toBe(HISTORICAL_BLOBS + HISTORICAL_TRANSCRIPTS);
      expect(sqlite.query('SELECT kind, COUNT(*) AS n FROM processed_resources GROUP BY kind ORDER BY kind').all()).toEqual([
        { kind: 'attachment', n: HISTORICAL_BLOBS }, { kind: 'plan', n: HISTORICAL_PLANS },
        { kind: 'prompt', n: HISTORICAL_BLOBS }, { kind: 'response', n: HISTORICAL_BLOBS },
        { kind: 'tool-input', n: HISTORICAL_BLOBS }, { kind: 'tool-output', n: HISTORICAL_BLOBS },
      ]);
      expect(sqlite.query(`SELECT COUNT(*) AS n FROM raw_resources WHERE kind = 'event'`).get()).toEqual({ n: 0 });
      for (const original of originals) expect(await fingerprint(sqlite, original.table)).toBe(original.hash);
      expect(await rawBackfill(sqliteD1(sqlite), NOW + MAX_PASSES)).toEqual({ changed: 0, more: false });
      const reader = new RawResourceReader({ db: sqliteD1(sqlite), blobs: memoryBlobStore() }, { projectId: BACKFILL_PROJECTS[0] }, { kind: 'member', memberId: 'member_backfill' });
      expect(await reader.allows({ kind: 'transcript', id: 'retained' }, 'read')).toBe(true);
      for (const id of ['mixed', 'unknown', 'conflicting']) expect(await reader.allows({ kind: 'transcript', id }, 'read')).toBe(false);
      expect(await reader.event('raw-event-00000')).toBe(JSON.stringify({ message: 'preserved 0' }));
      expect(sqlite.query(`SELECT segment_count, (SELECT COUNT(*) FROM transcript_segments s WHERE s.project_id = t.project_id AND s.transcript_id = t.transcript_id) AS live FROM transcripts t WHERE transcript_id = 'retained'`).get()).toEqual({ segment_count: 20, live: 1 });
    } finally { sqlite.close(); }
  });
});
