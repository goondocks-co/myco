/**
 * Verifies the v44 migration: deletion of phantom kind='recovered' batches
 * fabricated by PR #346's over-eager ensureOpenBatch, plus recomputation
 * of drifted activity_count across remaining batches.
 *
 * Phantom rows are identified by the exact user_prompt body the function
 * used: `'(implicit batch — capture recovered)'`. Pre-#346 recovered
 * rows carry the body `'(recovered — pre-invariant orphans)'` and must
 * survive the migration untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from 'bun:sqlite';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';

/**
 * Stage a database at "post-v43, pre-v44." Rewinds schema_version to 43
 * after installing the current schema so the v44 migration applies on the
 * next createSchema() call.
 */
function seedV43Database(dbPath: string): void {
  const db = new Database(dbPath);
  createSchema(db as never);
  db.prepare('DELETE FROM schema_version').run();
  db.prepare(
    'INSERT INTO schema_version (version, applied_at) VALUES (43, ?)',
  ).run(epochSeconds());
  db.close();
}

describe('migrateV43ToV44 — phantom recovered cleanup + activity_count repair', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-v44-'));
    dbPath = path.join(tmpDir, 'myco.db');
    seedV43Database(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedSessionWithPhantoms(): void {
    const seed = new Database(dbPath);
    const now = epochSeconds();

    seed.prepare(
      `INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('sess-fix', 'claude-code', ?, ?)`,
    ).run(now, now);

    // 1. A normal INITIAL batch from a turn that completed.
    const realBatchId = `pbat_${'1'.repeat(32)}`;
    seed.prepare(
      `INSERT INTO prompt_batches (id, session_id, prompt_number, user_prompt,
                                    started_at, ended_at, created_at, kind, status, machine_id, origin)
       VALUES (?, 'sess-fix', 1, 'real turn prompt', ?, ?, ?, 'initial', 'completed', 'local', 'system')`,
    ).run(realBatchId, now, now + 60, now);

    // Three tool_use activities on the real batch — but activity_count
    // intentionally left at 0 to simulate the drift bug.
    const insertActivity = seed.prepare(
      `INSERT INTO activities (session_id, prompt_batch_id, tool_name, timestamp, created_at)
       VALUES ('sess-fix', ?, 'Read', ?, ?)`,
    );
    for (let i = 0; i < 3; i++) {
      insertActivity.run(realBatchId, now + i, now + i);
    }

    // 2. A phantom RECOVERED batch from PR #346's ensureOpenBatch fallback,
    //    holding a single synthetic subagent_stop activity.
    const phantomBatchId = `pbat_${'2'.repeat(32)}`;
    seed.prepare(
      `INSERT INTO prompt_batches (id, session_id, prompt_number, user_prompt,
                                    started_at, ended_at, created_at, kind, status, machine_id, origin)
       VALUES (?, 'sess-fix', 0, '(implicit batch — capture recovered)', ?, ?, ?, 'recovered', 'completed', 'local', 'system')`,
    ).run(phantomBatchId, now + 70, now + 72, now + 70);
    seed.prepare(
      `INSERT INTO activities (session_id, prompt_batch_id, tool_name, tool_input, timestamp, created_at)
       VALUES ('sess-fix', ?, 'subagent_stop', '{"agent_id":"a3c68fc","agent_type":""}', ?, ?)`,
    ).run(phantomBatchId, now + 71, now + 71);

    // 3. A pre-#346 recovery batch (legitimate orphan backfill). Body
    //    differs — must survive the migration.
    seed.prepare(
      `INSERT INTO prompt_batches (id, session_id, prompt_number, user_prompt,
                                    started_at, ended_at, created_at, kind, status, machine_id, origin)
       VALUES (?, 'sess-fix', 0, '(recovered — pre-invariant orphans)', ?, ?, ?, 'recovered', 'completed', 'local', 'system')`,
    ).run(`pbat_${'3'.repeat(32)}`, now - 100, now - 90, now - 100);

    seed.close();
  }

  it('deletes phantom recovered batches and their synthetic subagent_stop activities', () => {
    seedSessionWithPhantoms();

    initDatabase(dbPath);
    createSchema(getDatabase() as never);
    const db = getDatabase();

    const recoveredRows = db.prepare(
      `SELECT user_prompt FROM prompt_batches WHERE session_id = 'sess-fix' AND kind = 'recovered'`,
    ).all() as Array<{ user_prompt: string }>;
    expect(recoveredRows).toHaveLength(1);
    expect(recoveredRows[0].user_prompt).toBe('(recovered — pre-invariant orphans)');

    const synthetic = db.prepare(
      `SELECT id FROM activities WHERE session_id = 'sess-fix' AND tool_name = 'subagent_stop'`,
    ).all();
    expect(synthetic).toHaveLength(0);
  });

  it('preserves the real turn batch and recomputes drifted activity_count', () => {
    seedSessionWithPhantoms();

    initDatabase(dbPath);
    createSchema(getDatabase() as never);
    const db = getDatabase();

    const initial = db.prepare(
      `SELECT id, activity_count FROM prompt_batches WHERE session_id = 'sess-fix' AND kind = 'initial'`,
    ).get() as { id: number; activity_count: number };
    expect(initial.activity_count).toBe(3);

    const activities = db.prepare(
      `SELECT COUNT(*) AS n FROM activities WHERE prompt_batch_id = ?`,
    ).get(initial.id) as { n: number };
    expect(activities.n).toBe(3);
  });

  it('is idempotent — re-running createSchema does not re-delete or re-touch rows', () => {
    seedSessionWithPhantoms();

    initDatabase(dbPath);
    createSchema(getDatabase() as never);
    const before = getDatabase().prepare(
      `SELECT COUNT(*) AS n FROM prompt_batches WHERE session_id = 'sess-fix'`,
    ).get() as { n: number };

    // Same connection, second createSchema. Should short-circuit at the
    // "currentVersion === SCHEMA_VERSION" branch and not run v44 again.
    createSchema(getDatabase() as never);

    const after = getDatabase().prepare(
      `SELECT COUNT(*) AS n FROM prompt_batches WHERE session_id = 'sess-fix'`,
    ).get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});
