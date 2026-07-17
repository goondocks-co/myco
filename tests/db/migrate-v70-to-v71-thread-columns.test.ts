/**
 * Tests for the v70 -> v71 migration: `thread_id` / `thread_label` on
 * `prompt_batches`.
 *
 * Sub-agent thread mining (Codex sub-agent transcripts) attributes batches
 * mined from a child thread back to the parent session, distinguishing them
 * from the session's main-thread batches. `thread_id` is NULL for
 * main-thread rows and set to the child thread's identifier for mined rows;
 * `thread_label` carries a friendly display name for the thread.
 *
 * Builds a v70-shaped vault (drop the two columns and the new index, rewind
 * schema_version to 70), re-runs createSchema to apply migrateV70ToV71, and
 * asserts the delta in isolation. Also asserts a fresh install already has
 * both columns and the index.
 */

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

function columnNames(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function indexExists(db: Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name);
}

function stampedVersion(db: Database): number {
  return (db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v;
}

/** Build a v70-shaped vault: full current schema minus the v71 delta, stamped at exactly 70. */
function seedV70Db(): Database {
  const db = new Database(':memory:');
  createSchema(db);
  db.exec('DROP INDEX IF EXISTS idx_prompt_batches_session_thread');
  db.exec('ALTER TABLE prompt_batches DROP COLUMN thread_id');
  db.exec('ALTER TABLE prompt_batches DROP COLUMN thread_label');
  db.prepare('DELETE FROM schema_version WHERE version > 70').run();
  return db;
}

function seedSessionAndBatch(db: Database, sessionId: string, batchOverrides: Record<string, unknown> = {}): number {
  db.prepare(`INSERT OR IGNORE INTO agents (id, name, created_at) VALUES ('agent-1', 'Agent', 1000)`).run();
  db.prepare(
    `INSERT INTO sessions (id, agent, started_at, created_at) VALUES (?, 'test', 1000, 1000)`,
  ).run(sessionId);
  const userPrompt = (batchOverrides.user_prompt as string) ?? 'hello world';
  const result = db.prepare(
    `INSERT INTO prompt_batches (session_id, user_prompt, created_at) VALUES (?, ?, 1000)`,
  ).run(sessionId, userPrompt);
  return Number(result.lastInsertRowid);
}

describe('migrateV70ToV71 — prompt_batches thread_id/thread_label', () => {
  it('SCHEMA_VERSION includes this migration', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(71);
  });

  it('fresh install already has both columns and the composite index', () => {
    const db = new Database(':memory:');
    createSchema(db);

    const cols = columnNames(db, 'prompt_batches');
    expect(cols).toContain('thread_id');
    expect(cols).toContain('thread_label');
    expect(indexExists(db, 'idx_prompt_batches_session_thread')).toBe(true);

    db.close();
  });

  it('a v70-stamped vault missing the columns gets them added, stamping v71', () => {
    const db = seedV70Db();
    expect(columnNames(db, 'prompt_batches')).not.toContain('thread_id');
    expect(columnNames(db, 'prompt_batches')).not.toContain('thread_label');
    expect(indexExists(db, 'idx_prompt_batches_session_thread')).toBe(false);

    createSchema(db);

    const cols = columnNames(db, 'prompt_batches');
    expect(cols).toContain('thread_id');
    expect(cols).toContain('thread_label');
    expect(indexExists(db, 'idx_prompt_batches_session_thread')).toBe(true);
    expect(stampedVersion(db)).toBe(SCHEMA_VERSION);

    db.close();
  });

  it('existing prompt_batches rows survive the migration intact with both new columns NULL', () => {
    const db = seedV70Db();
    const batchId = seedSessionAndBatch(db, 'sess-a', { user_prompt: 'pre-migration prompt' });

    createSchema(db);

    const row = db.prepare(
      `SELECT session_id, user_prompt, thread_id, thread_label FROM prompt_batches WHERE id = ?`,
    ).get(batchId) as { session_id: string; user_prompt: string; thread_id: string | null; thread_label: string | null };

    expect(row.session_id).toBe('sess-a');
    expect(row.user_prompt).toBe('pre-migration prompt');
    expect(row.thread_id).toBeNull();
    expect(row.thread_label).toBeNull();

    db.close();
  });

  it('is idempotent — re-running createSchema on an already-migrated vault does not error or duplicate rows', () => {
    const db = seedV70Db();
    seedSessionAndBatch(db, 'sess-a');

    createSchema(db);
    createSchema(db); // second boot

    const n = (db.prepare(`SELECT COUNT(*) AS n FROM prompt_batches`).get() as { n: number }).n;
    expect(n).toBe(1);
    expect(stampedVersion(db)).toBe(SCHEMA_VERSION);

    db.close();
  });

  it('the new index supports lookups by (session_id, thread_id)', () => {
    const db = new Database(':memory:');
    createSchema(db);
    seedSessionAndBatch(db, 'sess-main');
    db.prepare(`INSERT INTO prompt_batches (session_id, user_prompt, created_at, thread_id, thread_label)
       VALUES ('sess-main', 'from a sub-agent', 2000, 'task_6', 'task_6_reviewer')`).run();

    const rows = db.prepare(
      `SELECT thread_label FROM prompt_batches WHERE session_id = 'sess-main' AND thread_id = 'task_6'`,
    ).all() as Array<{ thread_label: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.thread_label).toBe('task_6_reviewer');

    db.close();
  });
});
