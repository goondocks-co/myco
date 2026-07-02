/**
 * Schema test for the agent_run_events table — verifies the table and its
 * index exist after createSchema() runs, and that the column set matches
 * what queries/agent-run-events.ts (Task 3) will rely on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

describe('agent_run_events schema', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates agent_run_events with the expected columns on a fresh install', () => {
    createSchema(db, 'local');
    const columns = db.prepare(`PRAGMA table_info(agent_run_events)`).all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));
    expect(columnNames).toEqual(new Set([
      'id', 'project_id', 'run_id', 'phase_name', 'event_type',
      'tool_name', 'outcome', 'duration_ms', 'payload', 'recorded_at',
    ]));
  });

  it('creates an index on (run_id, id) for cursor-based polling', () => {
    createSchema(db, 'local');
    const indexes = db.prepare(`PRAGMA index_list(agent_run_events)`).all() as Array<{ name: string }>;
    expect(indexes.some((idx) => idx.name === 'idx_agent_run_events_run_id')).toBe(true);
  });

  it('migrates an existing vault at SCHEMA_VERSION - 1 up to SCHEMA_VERSION and creates the table', () => {
    // Simulate a vault that predates this migration: create schema at the
    // prior version by stamping schema_version down after a fresh install,
    // dropping the new table to mimic "never had this migration run".
    createSchema(db, 'local');
    db.exec(`DROP TABLE IF EXISTS agent_run_events`);
    db.exec(`DELETE FROM schema_version WHERE version = ${SCHEMA_VERSION}`);
    db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`).run(SCHEMA_VERSION - 1, 0);

    createSchema(db, 'local');

    const versionRow = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number };
    expect(versionRow.v).toBe(SCHEMA_VERSION);
    const columns = db.prepare(`PRAGMA table_info(agent_run_events)`).all() as Array<{ name: string }>;
    expect(columns.length).toBe(10);
  });

  it('agent_run_events.run_id cascades on agent_runs delete', () => {
    db.exec('PRAGMA foreign_keys = ON');
    createSchema(db, 'local');
    db.prepare(`INSERT INTO agents (id, name, created_at) VALUES ('a1', 'agent', 0)`).run();
    db.prepare(`INSERT INTO agent_runs (id, agent_id, status, started_at) VALUES ('run-1', 'a1', 'running', 0)`).run();
    db.prepare(
      `INSERT INTO agent_run_events (run_id, event_type, recorded_at) VALUES ('run-1', 'phase_start', 0)`,
    ).run();
    db.prepare(`DELETE FROM agent_runs WHERE id = 'run-1'`).run();
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM agent_run_events WHERE run_id = 'run-1'`).get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});
