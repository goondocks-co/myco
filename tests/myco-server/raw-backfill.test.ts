import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { RawResourceReader } from '@myco-server-worker/core/raw-resources.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { sqliteD1 } from './helpers/d1.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { BACKFILL_PROJECTS, historicalBackfillSql, HISTORICAL_BLOBS, HISTORICAL_EVENTS, HISTORICAL_PLANS, HISTORICAL_TRANSCRIPTS } from '../parity/scenarios/raw-backfill.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const MAX_PASSES = 200;

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
        expect(result.results.length).toBeLessThanOrEqual(100);
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
      const selected = sqlite.query('SELECT project_id, key FROM blobs ORDER BY project_id, key LIMIT 100').all();
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
      expect(await rawBackfill(concurrent, NOW)).toEqual({ changed: 100, more: true });
      expect(injected).toBe(true);
      for (const row of selected as Array<{ project_id: string; key: string }>) {
        expect(sqlite.query(`SELECT owner_member_id FROM raw_resources WHERE kind = 'blob' AND project_id = ? AND resource_id = ?`).get(row.project_id, row.key)).toEqual({ owner_member_id: 'member_backfill' });
      }
      const last = selected.at(-1) as { project_id: string; key: string };
      expect(sqlite.query('SELECT cursor_project, cursor_id FROM raw_provenance_backfill').get()).toEqual({ cursor_project: last.project_id, cursor_id: last.key });
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
      const originals = await Promise.all(['blobs', 'events', 'transcripts', 'transcript_segments', 'plans'].map(async (table) => ({ table, hash: await fingerprint(sqlite, table) })));
      const { RAW_BACKFILL_BATCH, rawBackfill } = await import('@myco-server-worker/core/raw-backfill.js');
      expect(RAW_BACKFILL_BATCH).toBe(100);
      const pages: number[] = [];
      let completed = false;
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        const provenanceCount = () => count(sqlite, 'raw_resources') + count(sqlite, 'processed_resources') + count(sqlite, 'raw_credentials');
        const previous = provenanceCount();
        const result = await rawBackfill(sourcePageGate(sqlite, pages), NOW + pass);
        expect(result.changed).toBeLessThanOrEqual(100);
        expect(result.changed).toBeGreaterThanOrEqual(0);
        const added = provenanceCount() - previous;
        expect(added).toBeLessThanOrEqual(100);
        expect(added).toBeGreaterThanOrEqual(0);
        expect(result.changed).toBe(added);
        if (pass === 3) {
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
      expect(pages.length).toBeGreaterThan(100);
      expect(sqlite.query(`SELECT complete FROM raw_provenance_backfill WHERE id = 1`).get()).toEqual({ complete: 1 });
      expect(count(sqlite, 'raw_resources')).toBe(HISTORICAL_BLOBS + HISTORICAL_TRANSCRIPTS);
      expect(sqlite.query('SELECT kind, COUNT(*) AS n FROM processed_resources GROUP BY kind ORDER BY kind').all()).toEqual([
        { kind: 'attachment', n: HISTORICAL_BLOBS }, { kind: 'plan', n: HISTORICAL_PLANS },
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
