import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { MIGRATIONS } from '@myco/db/migrations.js';
import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal v21-shaped schema on `db`.
 *
 * Only the tables the v22 migration and the backfill touch need to be present:
 *   - schema_version (required by all migrations)
 *   - sessions (FK target; must have `agent` column for backfill gating)
 *   - prompt_batches (v21 shape — without kind or parent_prompt_batch_id)
 */
function buildV21Schema(db: Database): void {
  db.prepare(
    `CREATE TABLE schema_version (
       version    INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  ).run();

  db.prepare(
    `CREATE TABLE sessions (
       id         TEXT PRIMARY KEY,
       agent      TEXT,
       started_at INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     )`,
  ).run();

  // v21 prompt_batches — no parent_prompt_batch_id, no kind column
  db.prepare(
    `CREATE TABLE prompt_batches (
       id               INTEGER PRIMARY KEY AUTOINCREMENT,
       session_id       TEXT NOT NULL REFERENCES sessions(id),
       prompt_number    INTEGER,
       user_prompt      TEXT,
       response_summary TEXT,
       classification   TEXT,
       started_at       INTEGER,
       ended_at         INTEGER,
       status           TEXT,
       activity_count   INTEGER NOT NULL DEFAULT 0,
       processed        INTEGER NOT NULL DEFAULT 0,
       content_hash     TEXT,
       created_at       INTEGER NOT NULL
     )`,
  ).run();

  db.prepare(
    `INSERT INTO schema_version (version, applied_at) VALUES (21, 1000)`,
  ).run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateV21ToV22 — OpenCode backfill', () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase();
    buildV21Schema(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it('reclassifies orphan steering batches for opencode sessions', () => {
    // Session with agent='opencode'
    db.prepare(
      `INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('s1', 'opencode', 1000, 1000)`,
    ).run();

    // Batch A: initial-style, has response_summary — started_at=100, ended_at=200
    db.prepare(
      `INSERT INTO prompt_batches (session_id, user_prompt, response_summary, started_at, ended_at, created_at)
       VALUES ('s1', 'prompt A', 'done', 100, 200, 1000)`,
    ).run();
    const batchA = db.prepare(`SELECT id FROM prompt_batches WHERE response_summary = 'done'`).get() as { id: number };

    // Batch B: orphan steering style within A's window — started_at=150, ended_at=180, no response_summary
    db.prepare(
      `INSERT INTO prompt_batches (session_id, user_prompt, response_summary, started_at, ended_at, created_at)
       VALUES ('s1', 'steer B', NULL, 150, 180, 1001)`,
    ).run();
    const batchB = db.prepare(`SELECT id FROM prompt_batches WHERE started_at = 150`).get() as { id: number };

    // Batch C: another initial-style batch after A's window — started_at=300, ended_at=400
    db.prepare(
      `INSERT INTO prompt_batches (session_id, user_prompt, response_summary, started_at, ended_at, created_at)
       VALUES ('s1', 'prompt C', 'second-done', 300, 400, 1002)`,
    ).run();
    const batchC = db.prepare(`SELECT id FROM prompt_batches WHERE response_summary = 'second-done'`).get() as { id: number };

    const migration = MIGRATIONS.find((m) => m.version === 22)!;
    migration.migrate(db, 'local');

    const rows = db.prepare(
      `SELECT id, kind, parent_prompt_batch_id FROM prompt_batches ORDER BY id`,
    ).all() as Array<{ id: number; kind: string; parent_prompt_batch_id: number | null }>;

    expect(rows).toHaveLength(3);

    const rowA = rows.find((r) => r.id === batchA.id)!;
    expect(rowA.kind).toBe('initial');
    expect(rowA.parent_prompt_batch_id).toBeNull();

    const rowB = rows.find((r) => r.id === batchB.id)!;
    expect(rowB.kind).toBe('steering');
    expect(rowB.parent_prompt_batch_id).toBe(batchA.id);

    const rowC = rows.find((r) => r.id === batchC.id)!;
    expect(rowC.kind).toBe('initial');
    expect(rowC.parent_prompt_batch_id).toBeNull();
  });

  it('does NOT reclassify batches for non-opencode agents (claude-code)', () => {
    // Session with agent='claude-code'
    db.prepare(
      `INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('s2', 'claude-code', 1000, 1000)`,
    ).run();

    // Same batch structure as the opencode test
    db.prepare(
      `INSERT INTO prompt_batches (session_id, user_prompt, response_summary, started_at, ended_at, created_at)
       VALUES ('s2', 'prompt A', 'done', 100, 200, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO prompt_batches (session_id, user_prompt, response_summary, started_at, ended_at, created_at)
       VALUES ('s2', 'steer B', NULL, 150, 180, 1001)`,
    ).run();
    db.prepare(
      `INSERT INTO prompt_batches (session_id, user_prompt, response_summary, started_at, ended_at, created_at)
       VALUES ('s2', 'prompt C', 'second-done', 300, 400, 1002)`,
    ).run();

    const migration = MIGRATIONS.find((m) => m.version === 22)!;
    migration.migrate(db, 'local');

    const rows = db.prepare(
      `SELECT id, kind, parent_prompt_batch_id FROM prompt_batches ORDER BY id`,
    ).all() as Array<{ id: number; kind: string; parent_prompt_batch_id: number | null }>;

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.kind).toBe('initial');
      expect(row.parent_prompt_batch_id).toBeNull();
    }
  });
});
