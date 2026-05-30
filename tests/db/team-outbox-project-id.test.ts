/**
 * team_outbox.project_id foundation.
 *
 * Per-row project attribution on the team-sync outbox so a later step can
 * route each queued row to the right team's worker. Covers:
 *   1. syncRow on a project-scoped table carries project_id into the outbox.
 *   2. syncRow on a machine-scoped table (no project_id) leaves it null.
 *   3. The v53 schema: the project_id column exists on a fresh schema, and the
 *      recreated AFTER DELETE trigger captures OLD.project_id through a real
 *      source-table delete.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { syncRow, listPending } from '@myco/db/queries/team-outbox.js';
import { setTeamSyncEnabled } from '@myco/db/queries/team-sync-state.js';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

describe('team_outbox.project_id — syncRow plumbing', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('carries project_id from a project-scoped row into the outbox', () => {
    setTeamSyncEnabled(true);

    syncRow('spores', { id: 'spore_x', project_id: 'proj_y', created_at: 1 });

    const pending = listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].row_id).toBe('spore_x');
    expect(pending[0].project_id).toBe('proj_y');
  });

  it('leaves project_id null for a machine-scoped row (no project_id)', () => {
    setTeamSyncEnabled(true);

    // team_members is machine-scoped — it has no project_id column.
    syncRow('team_members', { id: 'tm', created_at: 1 });

    const pending = listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].row_id).toBe('tm');
    expect(pending[0].project_id).toBeNull();
  });
});

describe('team_outbox.project_id — v53 schema + delete trigger', () => {
  it('SCHEMA_VERSION is at least 53', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(53);
  });

  it('fresh schema has project_id on team_outbox', () => {
    const db = new Database(':memory:');
    createSchema(db);
    const cols = (db.prepare(`PRAGMA table_info(team_outbox)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('project_id');
    db.close();
  });

  it('the AFTER DELETE trigger captures OLD.project_id', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = OFF'); // FK-free fixture insert
    createSchema(db);
    setTeamSyncEnabled(true, db);

    // Insert a project-scoped spore, then delete it. The recreated team-sync
    // delete trigger must journal a 'delete' row into team_outbox carrying the
    // source row's project_id.
    db.prepare(`
      INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id)
      VALUES ('sp_del', 'proj_del', 'agent-x', 'note', 'bye', 1000, 'local')
    `).run();

    db.prepare(`DELETE FROM spores WHERE id = 'sp_del'`).run();

    const row = db.prepare(
      `SELECT operation, row_id, project_id, machine_id
         FROM team_outbox WHERE table_name = 'spores' AND row_id = 'sp_del'`,
    ).get() as { operation: string; row_id: string; project_id: string | null; machine_id: string };

    expect(row).toBeDefined();
    expect(row.operation).toBe('delete');
    expect(row.project_id).toBe('proj_del');
    expect(row.machine_id).toBe('local');
    db.close();
  });

  it('migrating a v52 DB adds project_id and recreates the project-capturing trigger', () => {
    // Build a full schema, then stamp back to v52 so the next createSchema()
    // runs only the v53 migration (mirrors migration-v52.test.ts's makeV51Db).
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = OFF');
    createSchema(db); // lands at current SCHEMA_VERSION

    // Simulate the pre-v53 shape: drop the project_id column is not possible
    // without a table rebuild, so instead we drop+recreate team_outbox without
    // project_id and recreate the OLD (project-less) triggers, then stamp v52.
    db.exec('DROP TABLE team_outbox');
    db.exec(`
      CREATE TABLE team_outbox (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name  TEXT NOT NULL,
        row_id      TEXT NOT NULL,
        operation   TEXT NOT NULL DEFAULT 'upsert',
        payload     TEXT NOT NULL,
        machine_id  TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        sent_at     INTEGER,
        retry_count    INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER
      )`);
    db.exec('DROP TRIGGER IF EXISTS spores_team_ad');
    db.exec(`
      CREATE TRIGGER spores_team_ad
      AFTER DELETE ON spores
      WHEN (SELECT enabled FROM team_sync_state) = 1
      BEGIN
        INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, created_at)
        VALUES ('spores', CAST(OLD.id AS TEXT), 'delete',
                json_object('id', OLD.id, 'machine_id', OLD.machine_id),
                OLD.machine_id, CAST(strftime('%s','now') AS INTEGER));
      END`);
    db.prepare(`DELETE FROM schema_version WHERE version = ${SCHEMA_VERSION}`).run();
    db.prepare(
      `INSERT INTO schema_version (version, applied_at) VALUES (52, 0) ON CONFLICT (version) DO NOTHING`,
    ).run();

    // Pre-condition: no project_id column on the v52-shape table.
    const colsBefore = (db.prepare(`PRAGMA table_info(team_outbox)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(colsBefore).not.toContain('project_id');

    // Run the v53 migration.
    createSchema(db);

    // (a) project_id column added.
    const colsAfter = (db.prepare(`PRAGMA table_info(team_outbox)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(colsAfter).toContain('project_id');

    // (b) the trigger now captures project_id through a real delete.
    setTeamSyncEnabled(true, db);
    db.prepare(`
      INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id)
      VALUES ('sp_mig', 'proj_mig', 'agent-x', 'note', 'gone', 1000, 'local')
    `).run();
    db.prepare(`DELETE FROM spores WHERE id = 'sp_mig'`).run();

    const row = db.prepare(
      `SELECT operation, project_id FROM team_outbox WHERE row_id = 'sp_mig'`,
    ).get() as { operation: string; project_id: string | null };
    expect(row.operation).toBe('delete');
    expect(row.project_id).toBe('proj_mig');

    // (c) schema_version advanced to current.
    const ver = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number };
    expect(ver.v).toBe(SCHEMA_VERSION);
    db.close();
  });
});
