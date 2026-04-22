import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { MIGRATIONS } from '@myco/db/migrations.js';
import type { Database } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getColumnNames(db: Database, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function indexExists(db: Database, indexName: string): boolean {
  const row = db.prepare(
    `SELECT count(*) AS cnt FROM sqlite_master WHERE type = 'index' AND name = ?`,
  ).get(indexName) as { cnt: number };
  return row.cnt > 0;
}

/**
 * Build a minimal v21-shaped schema on `db`.
 *
 * Only the tables the v22 migration touches need to be present:
 *   - schema_version (required by all migrations)
 *   - sessions (FK target for prompt_batches)
 *   - prompt_batches (v21 shape — without the new columns)
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
       agent      TEXT NOT NULL,
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

describe('migrateV21ToV22', () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase();
    buildV21Schema(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it('is registered in MIGRATIONS at version 22', () => {
    const migration = MIGRATIONS.find((m) => m.version === 22);
    expect(migration, 'v22 migration missing').toBeDefined();
  });

  it('adds parent_prompt_batch_id and kind columns to prompt_batches', () => {
    expect(getColumnNames(db, 'prompt_batches')).not.toContain('parent_prompt_batch_id');
    expect(getColumnNames(db, 'prompt_batches')).not.toContain('kind');

    const migration = MIGRATIONS.find((m) => m.version === 22)!;
    migration.migrate(db, 'local');

    const cols = getColumnNames(db, 'prompt_batches');
    expect(cols).toContain('parent_prompt_batch_id');
    expect(cols).toContain('kind');
  });

  it('creates idx_prompt_batches_parent index', () => {
    const migration = MIGRATIONS.find((m) => m.version === 22)!;
    migration.migrate(db, 'local');

    expect(indexExists(db, 'idx_prompt_batches_parent')).toBe(true);
  });

  it('stamps schema_version row 22', () => {
    const migration = MIGRATIONS.find((m) => m.version === 22)!;
    migration.migrate(db, 'local');

    const row = db.prepare(
      `SELECT version FROM schema_version WHERE version = 22`,
    ).get() as { version: number } | undefined;
    expect(row?.version).toBe(22);
  });

  it('backfills existing rows with kind=initial and null parent', () => {
    // Seed a session and a couple of pre-migration prompt_batches rows
    db.prepare(
      `INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('s1', 'test-agent', 1000, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO prompt_batches (session_id, prompt_number, user_prompt, created_at)
       VALUES ('s1', 1, 'hello', 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO prompt_batches (session_id, prompt_number, user_prompt, created_at)
       VALUES ('s1', 2, 'world', 1001)`,
    ).run();

    const migration = MIGRATIONS.find((m) => m.version === 22)!;
    migration.migrate(db, 'local');

    const rows = db.prepare(
      `SELECT kind, parent_prompt_batch_id FROM prompt_batches ORDER BY id`,
    ).all() as Array<{ kind: string; parent_prompt_batch_id: number | null }>;

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.kind).toBe('initial');
      expect(row.parent_prompt_batch_id).toBeNull();
    }
  });

  it('is idempotent — running twice does not throw', () => {
    const migration = MIGRATIONS.find((m) => m.version === 22)!;
    migration.migrate(db, 'local');
    expect(() => migration.migrate(db, 'local')).not.toThrow();
  });
});
