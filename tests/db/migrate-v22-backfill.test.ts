import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { MIGRATIONS } from '@myco/db/migrations.js';
import type { Database } from 'bun:sqlite';

// The v22 migration originally contained an OpenCode steering backfill that
// re-parented any batch with response_summary=NULL to the prior batch. That
// heuristic was premised on "missing summary ⇒ mid-turn steering" — which
// turned out to be wrong: the missing summaries were a separate capture bug
// (opencode plugin's stop events had no buffer fallback). The backfill was
// removed before shipping. These tests pin the no-op contract so nothing
// silently re-introduces the heuristic.

function buildV21Schema(db: Database): void {
  db.prepare(
    `CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
  ).run();
  db.prepare(
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, agent TEXT, started_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  ).run();
  db.prepare(
    `CREATE TABLE prompt_batches (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       session_id TEXT NOT NULL REFERENCES sessions(id),
       prompt_number INTEGER, user_prompt TEXT, response_summary TEXT, classification TEXT,
       started_at INTEGER, ended_at INTEGER, status TEXT,
       activity_count INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0,
       content_hash TEXT, created_at INTEGER NOT NULL
     )`,
  ).run();
  db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (21, 1000)`).run();
}

describe('migrateV21ToV22 — OpenCode backfill removed', () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase();
    buildV21Schema(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it('does NOT reclassify NULL-summary batches on opencode sessions', () => {
    db.prepare(
      `INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('s1', 'opencode', 1000, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO prompt_batches (session_id, user_prompt, response_summary, started_at, ended_at, created_at)
       VALUES ('s1', 'prompt A', 'done', 100, 200, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO prompt_batches (session_id, user_prompt, response_summary, started_at, ended_at, created_at)
       VALUES ('s1', 'maybe-steer B', NULL, 150, 180, 1001)`,
    ).run();

    const migration = MIGRATIONS.find((m) => m.version === 22)!;
    migration.migrate(db, 'local');

    const rows = db.prepare(
      `SELECT id, kind, parent_prompt_batch_id FROM prompt_batches ORDER BY id`,
    ).all() as Array<{ id: number; kind: string; parent_prompt_batch_id: number | null }>;

    for (const row of rows) {
      expect(row.kind).toBe('initial');
      expect(row.parent_prompt_batch_id).toBeNull();
    }
  });

  it('still adds parent_prompt_batch_id and kind columns to prompt_batches', () => {
    const migration = MIGRATIONS.find((m) => m.version === 22)!;
    migration.migrate(db, 'local');

    const columns = db
      .prepare(`PRAGMA table_info(prompt_batches)`)
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));
    expect(names.has('kind')).toBe(true);
    expect(names.has('parent_prompt_batch_id')).toBe(true);
  });

  it('records schema version 22 after migration', () => {
    const migration = MIGRATIONS.find((m) => m.version === 22)!;
    migration.migrate(db, 'local');

    const row = db
      .prepare(`SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`)
      .get() as { version: number };
    expect(row.version).toBe(22);
  });
});
