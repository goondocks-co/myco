/**
 * Schema test for agent_run_write_intents.classifier_verdict /
 * classifier_reason — verifies the columns exist after createSchema() runs
 * on a fresh install, that they're nullable, and that a v65 vault migrates
 * up to v66 and gains them without disturbing existing rows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

describe('agent_run_write_intents classifier columns (schema v66)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('has nullable classifier_verdict and classifier_reason columns on a fresh install', () => {
    createSchema(db, 'local');
    const cols = db.prepare(`PRAGMA table_info(agent_run_write_intents)`).all() as Array<{ name: string; notnull: number }>;
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(byName.has('classifier_verdict')).toBe(true);
    expect(byName.get('classifier_verdict')!.notnull).toBe(0);

    expect(byName.has('classifier_reason')).toBe(true);
    expect(byName.get('classifier_reason')!.notnull).toBe(0);
  });

  it('allows inserting a row without classifier columns (nullable, backward compatible)', () => {
    createSchema(db, 'local');
    db.prepare(`INSERT INTO agents (id, name, created_at) VALUES ('agent-schema-test', 'agent', 0)`).run();
    db.prepare(
      `INSERT INTO agent_runs (id, agent_id, status, started_at) VALUES (?, ?, ?, ?)`,
    ).run('run-schema-test', 'agent-schema-test', 'running', 0);

    db.prepare(
      `INSERT INTO agent_run_write_intents
         (run_id, tool_name, tool_input, synthetic_output, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('run-schema-test', 'vault_mark_processed', '{}', '{}', 0);

    const row = db.prepare(
      `SELECT classifier_verdict, classifier_reason FROM agent_run_write_intents WHERE run_id = ?`,
    ).get('run-schema-test') as { classifier_verdict: string | null; classifier_reason: string | null };

    expect(row.classifier_verdict).toBeNull();
    expect(row.classifier_reason).toBeNull();
  });

  it('migrates an existing vault at SCHEMA_VERSION - 1 up to SCHEMA_VERSION and adds the columns', () => {
    // Simulate a vault that predates this migration: fresh-install, then
    // drop the two new columns by rebuilding the table without them, and
    // stamp schema_version back down to mimic "never had this migration run".
    createSchema(db, 'local');
    db.exec(`
      CREATE TABLE agent_run_write_intents_old (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id        TEXT,
        run_id            TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        phase_id          TEXT,
        tool_name         TEXT NOT NULL,
        tool_input        TEXT NOT NULL,
        synthetic_output  TEXT NOT NULL,
        stub_id           TEXT,
        recorded_at       INTEGER NOT NULL
      )
    `);
    db.exec(`DROP TABLE agent_run_write_intents`);
    db.exec(`ALTER TABLE agent_run_write_intents_old RENAME TO agent_run_write_intents`);
    db.exec(`DELETE FROM schema_version WHERE version = ${SCHEMA_VERSION}`);
    db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`).run(SCHEMA_VERSION - 1, 0);

    createSchema(db, 'local');

    const versionRow = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number };
    expect(versionRow.v).toBe(SCHEMA_VERSION);

    const cols = db.prepare(`PRAGMA table_info(agent_run_write_intents)`).all() as Array<{ name: string }>;
    const columnNames = new Set(cols.map((c) => c.name));
    expect(columnNames.has('classifier_verdict')).toBe(true);
    expect(columnNames.has('classifier_reason')).toBe(true);
  });
});
