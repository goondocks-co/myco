import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { MIGRATIONS } from '@myco/db/migrations.js';
import { SCHEMA_VERSION } from '@myco/db/schema.js';
import type { Database } from 'bun:sqlite';

function getColumnNames(db: Database, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function getPrimaryKeyColumns(db: Database, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
    pk: number;
  }>;
  return rows
    .filter((r) => r.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((r) => r.name);
}

function indexExists(db: Database, indexName: string): boolean {
  const row = db.prepare(
    `SELECT count(*) AS cnt FROM sqlite_master WHERE type = 'index' AND name = ?`,
  ).get(indexName) as { cnt: number };
  return row.cnt > 0;
}

/**
 * Build a minimal v39-shaped schema covering only what the v40 migration
 * touches: schema_version, agents (FK target), agent_runs (backfill source),
 * and the old-shape agent_state with PK (agent_id, key).
 */
function buildV39Schema(db: Database): void {
  db.prepare(
    `CREATE TABLE schema_version (
       version    INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  ).run();

  db.prepare(
    `CREATE TABLE agents (
       id         TEXT PRIMARY KEY,
       name       TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
  ).run();

  db.prepare(
    `CREATE TABLE agent_runs (
       id         TEXT PRIMARY KEY,
       project_id TEXT,
       agent_id   TEXT NOT NULL REFERENCES agents(id),
       started_at INTEGER
     )`,
  ).run();

  db.prepare(
    `CREATE TABLE agent_state (
       agent_id    TEXT NOT NULL REFERENCES agents(id),
       key         TEXT NOT NULL,
       value       TEXT NOT NULL,
       updated_at  INTEGER NOT NULL,
       PRIMARY KEY (agent_id, key)
     )`,
  ).run();

  db.prepare(
    `INSERT INTO schema_version (version, applied_at) VALUES (39, 1000)`,
  ).run();
}

function seedAgent(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(id, `agent-${id}`, 1000);
}

function seedAgentRun(
  db: Database,
  runId: string,
  agentId: string,
  projectId: string | null,
  startedAt: number,
): void {
  db.prepare(
    `INSERT INTO agent_runs (id, project_id, agent_id, started_at) VALUES (?, ?, ?, ?)`,
  ).run(runId, projectId, agentId, startedAt);
}

describe('migrateV39ToV40', () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase();
    buildV39Schema(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it('SCHEMA_VERSION is 41', () => {
    expect(SCHEMA_VERSION).toBe(41);
  });

  it('is registered in MIGRATIONS at version 40', () => {
    const migration = MIGRATIONS.find((m) => m.version === 40);
    expect(migration, 'v40 migration missing').toBeDefined();
  });

  it('adds project_id column and rebuilds PK as (agent_id, project_id, key)', () => {
    seedAgent(db, 'survey-agent');
    seedAgentRun(db, 'run-1', 'survey-agent', 'proj_abc', 1500);
    db.prepare(
      `INSERT INTO agent_state (agent_id, key, value, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('survey-agent', 'watermark', '12345', 1500);

    expect(getColumnNames(db, 'agent_state')).not.toContain('project_id');
    expect(getPrimaryKeyColumns(db, 'agent_state')).toEqual(['agent_id', 'key']);

    const migration = MIGRATIONS.find((m) => m.version === 40)!;
    migration.migrate(db, 'local');

    const cols = getColumnNames(db, 'agent_state');
    expect(cols).toContain('project_id');
    expect(getPrimaryKeyColumns(db, 'agent_state')).toEqual([
      'agent_id',
      'project_id',
      'key',
    ]);
  });

  it('backfills project_id from most recent agent_runs row per agent', () => {
    seedAgent(db, 'survey-agent');
    // Older run wins on lower started_at; newer run with proj_new should win.
    seedAgentRun(db, 'run-old', 'survey-agent', 'proj_old', 1000);
    seedAgentRun(db, 'run-new', 'survey-agent', 'proj_new', 2000);
    db.prepare(
      `INSERT INTO agent_state (agent_id, key, value, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('survey-agent', 'watermark', '12345', 1500);

    const migration = MIGRATIONS.find((m) => m.version === 40)!;
    migration.migrate(db, 'local');

    const row = db.prepare(
      `SELECT agent_id, project_id, key, value FROM agent_state WHERE agent_id = ?`,
    ).get('survey-agent') as {
      agent_id: string;
      project_id: string;
      key: string;
      value: string;
    };
    expect(row.project_id).toBe('proj_new');
    expect(row.value).toBe('12345');
  });

  it('drops rows whose agent has no project-scoped agent_runs', () => {
    seedAgent(db, 'orphan-agent');
    // Only a NULL-project run exists — the backfill subselect filters those
    // out, so the row is unrecoverable and must be deleted.
    seedAgentRun(db, 'run-null', 'orphan-agent', null, 1500);
    db.prepare(
      `INSERT INTO agent_state (agent_id, key, value, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('orphan-agent', 'cursor', 'stale', 1500);

    const migration = MIGRATIONS.find((m) => m.version === 40)!;
    migration.migrate(db, 'local');

    const remaining = db.prepare(`SELECT count(*) AS c FROM agent_state`).get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it('creates the idx_agent_state_project index', () => {
    seedAgent(db, 'a');
    seedAgentRun(db, 'r', 'a', 'p', 1000);
    db.prepare(
      `INSERT INTO agent_state (agent_id, key, value, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('a', 'k', 'v', 1000);

    const migration = MIGRATIONS.find((m) => m.version === 40)!;
    migration.migrate(db, 'local');

    expect(indexExists(db, 'idx_agent_state_project')).toBe(true);
  });

  it('stamps schema_version row 40', () => {
    const migration = MIGRATIONS.find((m) => m.version === 40)!;
    migration.migrate(db, 'local');
    const row = db.prepare(
      `SELECT version FROM schema_version WHERE version = 40`,
    ).get() as { version: number } | undefined;
    expect(row?.version).toBe(40);
  });

  it('is a no-op when agent_state does not exist (fresh-DB safety)', () => {
    db.prepare('DROP TABLE agent_state').run();
    const migration = MIGRATIONS.find((m) => m.version === 40)!;
    expect(() => migration.migrate(db, 'local')).not.toThrow();
    const row = db.prepare(
      `SELECT version FROM schema_version WHERE version = 40`,
    ).get() as { version: number } | undefined;
    expect(row?.version).toBe(40);
  });
});
