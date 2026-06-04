import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

const now = 1_780_346_900;

function seedV54DbWithActivity(): Database {
  const db = new Database(':memory:');
  createSchema(db, 'test-machine');
  db.prepare('DELETE FROM schema_version').run();
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (54, ?)').run(now);

  db.prepare(
    `INSERT INTO sessions (id, agent, started_at, created_at)
     VALUES ('sess-v55', 'codex', ?, ?)`,
  ).run(now, now);
  const batch = db.prepare(
    `INSERT INTO prompt_batches (session_id, prompt_number, started_at, created_at, status)
     VALUES ('sess-v55', 1, ?, ?, 'active')`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO activities (
       session_id, prompt_batch_id, tool_name, tool_input, file_path,
       timestamp, created_at
     ) VALUES ('sess-v55', ?, 'Grep', 'migrationneedle', 'v55.ts', ?, ?)`,
  ).run(Number(batch.lastInsertRowid), now, now);
  db.prepare(`INSERT INTO activities_fts(activities_fts) VALUES('delete-all')`).run();
  db.prepare('DROP TRIGGER IF EXISTS activities_fts_ai').run();
  db.prepare('DROP TRIGGER IF EXISTS activities_fts_au').run();
  db.prepare('DROP TRIGGER IF EXISTS activities_fts_ad').run();
  return db;
}

function triggerNames(db: Database): string[] {
  return (db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'trigger' AND name LIKE 'activities_fts_%'
     ORDER BY name`,
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

describe('migration v54 -> v55: activities_fts triggers', () => {
  it('creates activities_fts triggers, rebuilds existing rows, and records schema version 55', () => {
    const db = seedV54DbWithActivity();

    createSchema(db, 'test-machine');

    expect(triggerNames(db)).toEqual(['activities_fts_ad', 'activities_fts_ai', 'activities_fts_au']);
    const match = db.prepare(
      `SELECT COUNT(*) AS n FROM activities_fts WHERE activities_fts MATCH 'migrationneedle'`,
    ).get() as { n: number };
    expect(match.n).toBe(1);

    // createSchema runs the full migration chain, so the terminal version is
    // the current SCHEMA_VERSION; assert the v55 step ran on its own.
    const v55Applied = db.prepare(
      `SELECT COUNT(*) AS n FROM schema_version WHERE version = 55`,
    ).get() as { n: number };
    expect(v55Applied.n).toBe(1);
    const version = db.prepare(
      `SELECT MAX(version) AS version FROM schema_version`,
    ).get() as { version: number };
    expect(version.version).toBe(SCHEMA_VERSION);
    db.close();
  });
});
