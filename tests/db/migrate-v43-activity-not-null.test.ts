/**
 * Verifies the v43 migration: NOT NULL on `activities.prompt_batch_id`
 * plus backfill of pre-invariant orphans to synthetic kind='recovered'
 * batches.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from 'bun:sqlite';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';

// Stage a database at "post-v42 with the v43 NOT NULL reverted." Concretely:
// run createSchema() once to install all current DDL, recreate the
// activities table without the NOT NULL on prompt_batch_id (mirroring the
// pre-fix shape that produced orphans in the wild), then rewind
// schema_version to 42 so the v43 migration applies on the next call.
function seedV42Database(dbPath: string): void {
  const db = new Database(dbPath);
  createSchema(db as never);
  db.exec(`
    CREATE TABLE activities_legacy (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id           TEXT,
      session_id           TEXT NOT NULL REFERENCES sessions(id),
      prompt_batch_id      INTEGER REFERENCES prompt_batches(id),
      tool_name            TEXT NOT NULL,
      tool_input           TEXT,
      tool_output_summary  TEXT,
      file_path            TEXT,
      files_affected       TEXT,
      duration_ms          INTEGER,
      success              INTEGER DEFAULT 1,
      error_message        TEXT,
      timestamp            INTEGER NOT NULL,
      processed            INTEGER DEFAULT 0,
      content_hash         TEXT,
      created_at           INTEGER NOT NULL,
      canopy_injection_tokens INTEGER
    )
  `);
  // Explicit column list (not SELECT *) so adding columns to the current
  // `activities` schema in later versions can't break this v42-snapshot copy.
  db.exec(`INSERT INTO activities_legacy SELECT
    id, project_id, session_id, prompt_batch_id, tool_name, tool_input,
    tool_output_summary, file_path, files_affected, duration_ms, success,
    error_message, timestamp, processed, content_hash, created_at,
    canopy_injection_tokens FROM activities`);
  db.exec('DROP TABLE activities');
  db.exec('ALTER TABLE activities_legacy RENAME TO activities');
  db.exec('DELETE FROM schema_version');
  db.prepare(
    'INSERT INTO schema_version (version, applied_at) VALUES (42, ?)',
  ).run(epochSeconds());
  db.close();
}

describe('migrateV42ToV43 — activity NOT NULL + recovery batch backfill', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-v43-'));
    dbPath = path.join(tmpDir, 'myco.db');
    seedV42Database(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backfills orphan activities to a per-session synthetic recovery batch', () => {
    const seed = new Database(dbPath);
    const now = epochSeconds();
    seed.exec(`INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('sess-A', 'claude-code', ${now}, ${now})`);
    seed.exec(`INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('sess-B', 'codex', ${now}, ${now})`);
    seed.exec(`INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('sess-clean', 'claude-code', ${now}, ${now})`);
    seed.exec(`INSERT INTO activities (session_id, tool_name, timestamp, created_at) VALUES ('sess-A', 'Read', ${now}, ${now})`);
    seed.exec(`INSERT INTO activities (session_id, tool_name, timestamp, created_at) VALUES ('sess-A', 'Bash', ${now + 1}, ${now + 1})`);
    seed.exec(`INSERT INTO activities (session_id, tool_name, timestamp, created_at) VALUES ('sess-B', 'Write', ${now + 2}, ${now + 2})`);
    const batchResult = seed.prepare(
      `INSERT INTO prompt_batches (session_id, prompt_number, user_prompt, started_at, created_at, status)
       VALUES ('sess-clean', 1, 'real prompt', ?, ?, 'active')`,
    ).run(now, now);
    const cleanBatchId = Number(batchResult.lastInsertRowid);
    seed.prepare(
      `INSERT INTO activities (session_id, prompt_batch_id, tool_name, timestamp, created_at)
       VALUES ('sess-clean', ?, 'Edit', ?, ?)`,
    ).run(cleanBatchId, now, now);
    seed.close();

    initDatabase(dbPath);
    createSchema(getDatabase() as never);

    const db = new Database(dbPath, { readonly: true });

    const recoveryBatches = db.prepare(
      "SELECT session_id, user_prompt, kind FROM prompt_batches WHERE kind = 'recovered'",
    ).all() as Array<{ session_id: string; user_prompt: string; kind: string }>;
    expect(recoveryBatches).toHaveLength(2);
    const sessions = new Set(recoveryBatches.map((r) => r.session_id));
    expect(sessions.has('sess-A')).toBe(true);
    expect(sessions.has('sess-B')).toBe(true);
    expect(sessions.has('sess-clean')).toBe(false);

    const remainingNull = (db.prepare(
      'SELECT count(*) AS n FROM activities WHERE prompt_batch_id IS NULL',
    ).get() as { n: number }).n;
    expect(remainingNull).toBe(0);

    const sessARecovery = db.prepare("SELECT id FROM prompt_batches WHERE session_id = 'sess-A' AND kind = 'recovered'").get() as { id: number };
    const sessBRecovery = db.prepare("SELECT id FROM prompt_batches WHERE session_id = 'sess-B' AND kind = 'recovered'").get() as { id: number };
    const sessAActs = db.prepare("SELECT prompt_batch_id FROM activities WHERE session_id = 'sess-A'").all() as Array<{ prompt_batch_id: number }>;
    expect(sessAActs.every((a) => a.prompt_batch_id === sessARecovery.id)).toBe(true);
    const sessBActs = db.prepare("SELECT prompt_batch_id FROM activities WHERE session_id = 'sess-B'").all() as Array<{ prompt_batch_id: number }>;
    expect(sessBActs.every((a) => a.prompt_batch_id === sessBRecovery.id)).toBe(true);
    const cleanAct = db.prepare("SELECT prompt_batch_id FROM activities WHERE session_id = 'sess-clean'").get() as { prompt_batch_id: number };
    expect(cleanAct.prompt_batch_id).toBe(cleanBatchId);

    const version = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(version).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('rejects new activity inserts without a non-NULL prompt_batch_id', () => {
    initDatabase(dbPath);
    createSchema(getDatabase() as never);

    const db = new Database(dbPath);
    db.exec(`INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('sess-X', 'claude-code', ${epochSeconds()}, ${epochSeconds()})`);
    expect(() => {
      db.exec(`INSERT INTO activities (session_id, tool_name, timestamp, created_at) VALUES ('sess-X', 'Read', ${epochSeconds()}, ${epochSeconds()})`);
    }).toThrow();
    db.close();
  });

  it('is idempotent — re-running createSchema does not create a second recovery batch', () => {
    const seed = new Database(dbPath);
    const now = epochSeconds();
    seed.exec(`INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('sess-idem', 'claude-code', ${now}, ${now})`);
    seed.exec(`INSERT INTO activities (session_id, tool_name, timestamp, created_at) VALUES ('sess-idem', 'Read', ${now}, ${now})`);
    seed.close();

    initDatabase(dbPath);
    createSchema(getDatabase() as never);

    const db1 = new Database(dbPath, { readonly: true });
    const firstRun = (db1.prepare("SELECT count(*) AS n FROM prompt_batches WHERE kind = 'recovered'").get() as { n: number }).n;
    db1.close();
    expect(firstRun).toBe(1);

    createSchema(getDatabase() as never);

    const db2 = new Database(dbPath, { readonly: true });
    const secondRun = (db2.prepare("SELECT count(*) AS n FROM prompt_batches WHERE kind = 'recovered'").get() as { n: number }).n;
    db2.close();
    expect(secondRun).toBe(1);
  });
});
