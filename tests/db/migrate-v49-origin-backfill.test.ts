/**
 * Verifies the v49 migration: prefix-based backfill of
 * `prompt_batches.origin` for agent-synthesized envelopes mis-tagged as
 * `'human'` by pre-v49 capture paths.
 *
 * The discriminator existed since v38, but only the Stop-time transcript
 * miner consulted manifest `set_origin` rules; the live `/events` hook
 * threaded `kind` and not `origin`, and a hardcoded SYSTEM_MESSAGE_PREFIXES
 * filter dropped two known envelopes entirely. Result by 2026-05: 1182
 * `<teammate-message>` rows plus partial bleed-through of every other
 * envelope class were tagged `'human'` and feeding noise into vault-evolve.
 *
 * The migration applies eight `UPDATE … WHERE origin='human' AND user_prompt
 * LIKE '<prefix>%'` statements, six tagging `'system'` and two tagging
 * `'agent_dispatch'`. Real user prompts are untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from 'bun:sqlite';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';

function seedV48Database(dbPath: string): void {
  const db = new Database(dbPath);
  createSchema(db as never);
  db.prepare('DELETE FROM schema_version').run();
  db.prepare(
    'INSERT INTO schema_version (version, applied_at) VALUES (48, ?)',
  ).run(epochSeconds());
  db.close();
}

describe('migrateV48ToV49 — prompt_batches origin backfill', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-v49-'));
    dbPath = path.join(tmpDir, 'myco.db');
    seedV48Database(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedHumanBatches(): Record<string, number> {
    const seed = new Database(dbPath);
    const now = epochSeconds();
    seed.prepare(
      `INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('sess-bf', 'claude-code', ?, ?)`,
    ).run(now, now);

    const insert = seed.prepare(
      `INSERT INTO prompt_batches (session_id, prompt_number, user_prompt,
                                    started_at, created_at, kind, status, machine_id, origin)
       VALUES ('sess-bf', ?, ?, ?, ?, 'initial', 'active', 'local', 'human')`,
    );

    const fixtures = [
      ['teammate', '<teammate-message teammate_id="x" color="blue">work done</teammate-message>'],
      ['teammate_no_attrs', '<teammate-messages>plural typo</teammate-messages>'],
      ['subagent', '<subagent_notification>\n{"agent":"y"}\n</subagent_notification>'],
      ['task_notif', '<task-notification>\n<task-id>t1</task-id>\n</task-notification>'],
      ['system_reminder', '<system-reminder>\nbe nice\n</system-reminder>'],
      ['skill', '<skill>\n<name>foo</name>\n</skill>'],
      ['env_ctx', '<environment_context>\n<cwd>/tmp</cwd>\n</environment_context>'],
      ['autoloop', '<<autonomous-loop-dynamic>>'],
      ['caveat', '<local-command-caveat>Caveat: do thing'],
      ['persisted', '<persisted-output>\nresumed\n</persisted-output>'],
      ['human_real', 'fix the bug in foo.ts'],
    ];

    const ids: Record<string, number> = {};
    for (let i = 0; i < fixtures.length; i++) {
      const [label, text] = fixtures[i];
      const info = insert.run(i + 1, text, now + i, now + i);
      ids[label] = Number(info.lastInsertRowid);
    }
    seed.close();
    return ids;
  }

  function runMigrations(): void {
    initDatabase(dbPath, { embeddingDimensions: 1024 });
    createSchema(getDatabase());
  }

  it('tags <teammate-message> and <subagent_notification> as agent_dispatch', () => {
    const ids = seedHumanBatches();
    runMigrations();
    const db = getDatabase();
    const row = (id: number) => db.prepare('SELECT origin FROM prompt_batches WHERE id = ?').get(id) as { origin: string };
    expect(row(ids.teammate).origin).toBe('agent_dispatch');
    expect(row(ids.subagent).origin).toBe('agent_dispatch');
  });

  it('tags <task-notification>, <system-reminder>, <skill>, <environment_context>, <<autonomous-loop, <local-command-caveat>, <persisted-output> as system', () => {
    const ids = seedHumanBatches();
    runMigrations();
    const db = getDatabase();
    const row = (id: number) => db.prepare('SELECT origin FROM prompt_batches WHERE id = ?').get(id) as { origin: string };
    expect(row(ids.task_notif).origin).toBe('system');
    expect(row(ids.system_reminder).origin).toBe('system');
    expect(row(ids.skill).origin).toBe('system');
    expect(row(ids.env_ctx).origin).toBe('system');
    expect(row(ids.autoloop).origin).toBe('system');
    expect(row(ids.caveat).origin).toBe('system');
    expect(row(ids.persisted).origin).toBe('system');
  });

  it('leaves real human prompts untouched', () => {
    const ids = seedHumanBatches();
    runMigrations();
    const db = getDatabase();
    const row = db.prepare('SELECT origin FROM prompt_batches WHERE id = ?').get(ids.human_real) as { origin: string };
    expect(row.origin).toBe('human');
  });

  it("doesn't false-match neighbouring tags like <teammate-messages>", () => {
    // Tightened prefix `<teammate-message ` (with trailing space) requires the
    // attribute separator; bare `<teammate-messages>` is left as 'human'.
    const ids = seedHumanBatches();
    runMigrations();
    const db = getDatabase();
    const row = db.prepare('SELECT origin FROM prompt_batches WHERE id = ?').get(ids.teammate_no_attrs) as { origin: string };
    expect(row.origin).toBe('human');
  });

  it('is idempotent: re-running the migration leaves origins stable', () => {
    seedHumanBatches();
    runMigrations();
    const db = getDatabase();
    const beforeRerun = db.prepare('SELECT id, origin FROM prompt_batches ORDER BY id').all();
    // Re-apply by rewinding schema_version and calling createSchema again.
    db.prepare('DELETE FROM schema_version WHERE version = 49').run();
    createSchema(db);
    const afterRerun = db.prepare('SELECT id, origin FROM prompt_batches ORDER BY id').all();
    expect(afterRerun).toEqual(beforeRerun);
  });
});
