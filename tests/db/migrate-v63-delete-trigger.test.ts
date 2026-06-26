import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { TEAM_DELETE_TRIGGER_TABLES } from '@myco/db/schema-ddl.js';

/**
 * v62 -> v63 drops the volatile `team_sync_state.enabled` gate from the
 * per-table delete triggers, re-gating them on the stable `team_sync_membership`
 * projection alone so a paused/transition window can never silently lose a
 * member project's delete tombstone (decision-893ef22a).
 */

function triggerSql(db: Database, name: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
    .get(name) as { sql: string } | undefined;
  return row?.sql ?? '';
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** Rebuild the pre-v63 (v62) trigger shape: enabled AND membership gated. */
function installV62Trigger(db: Database, table: string): void {
  db.exec(`DROP TRIGGER IF EXISTS ${table}_team_ad`);
  db.exec(`
    CREATE TRIGGER ${table}_team_ad
    AFTER DELETE ON ${table}
    WHEN (SELECT enabled FROM team_sync_state) = 1
      AND OLD.project_id IN (SELECT project_id FROM team_sync_membership)
    BEGIN
      INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, project_id, created_at)
      VALUES ('${table}', CAST(OLD.id AS TEXT), 'delete',
              json_object('id', OLD.id, 'machine_id', OLD.machine_id),
              OLD.machine_id, OLD.project_id, CAST(strftime('%s','now') AS INTEGER));
    END`);
}

describe('migrate v62 -> v63: drop the enabled gate from delete triggers', () => {
  it('SCHEMA_VERSION includes this migration', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(63);
  });

  it('a fresh vault installs membership-only triggers (no enabled gate)', () => {
    const db = new Database(':memory:');
    createSchema(db, 'local');
    for (const table of TEAM_DELETE_TRIGGER_TABLES) {
      const sql = triggerSql(db, `${table}_team_ad`);
      expect(sql).toContain('OLD.project_id IN (SELECT project_id FROM team_sync_membership)');
      expect(sql).toContain('team_id');
      expect(sql).not.toContain('team_sync_state');
    }
  });

  it('an existing v62 vault is migrated: triggers lose the enabled gate and converge on the fresh shape', () => {
    const fresh = new Database(':memory:');
    createSchema(fresh, 'local');

    const db = new Database(':memory:');
    createSchema(db, 'local');
    // Roll the vault back to the v62 shape: old-gate triggers + stamp 62.
    for (const table of TEAM_DELETE_TRIGGER_TABLES) installV62Trigger(db, table);
    db.exec('DELETE FROM schema_version');
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (62, 0)').run();

    createSchema(db, 'local');

    const stamped = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(stamped).toBe(SCHEMA_VERSION);

    for (const table of TEAM_DELETE_TRIGGER_TABLES) {
      const migrated = triggerSql(db, `${table}_team_ad`);
      expect(migrated).not.toContain('team_sync_state'); // enabled gate gone
      expect(migrated).toContain('OLD.project_id IN (SELECT project_id FROM team_sync_membership)');
      // Fresh-install DDL and the migrated trigger must be identical.
      expect(normalize(migrated)).toBe(normalize(triggerSql(fresh, `${table}_team_ad`)));
    }
  });

  it('a member delete journals with enabled = 0 after migration', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = OFF');
    createSchema(db, 'local');
    for (const table of TEAM_DELETE_TRIGGER_TABLES) installV62Trigger(db, table);
    db.exec('DELETE FROM schema_version');
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (62, 0)').run();
    createSchema(db, 'local');

    // enabled stays 0; only membership marks the project as a participant.
    db.prepare(
      `INSERT INTO team_sync_state (rowid_guard, enabled) VALUES (1, 0)
       ON CONFLICT (rowid_guard) DO UPDATE SET enabled = 0`,
    ).run();
    db.prepare(`INSERT OR IGNORE INTO team_sync_membership (project_id, team_id) VALUES ('proj_x', 'team-x')`).run();
    db.prepare(
      `INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at, machine_id)
       VALUES ('sp_mig', 'proj_x', 'user', 'decision', 'active', 'c', 1, 'local')`,
    ).run();
    db.prepare(`DELETE FROM spores WHERE id = 'sp_mig'`).run();

    const row = db.prepare(
      `SELECT team_id FROM team_outbox WHERE table_name='spores' AND operation='delete'`,
    ).get() as { team_id: string | null };
    expect(row).toBeDefined();
    expect(row.team_id).toBe('team-x');
  });

  it('is idempotent: re-running createSchema leaves the trigger unchanged', () => {
    const db = new Database(':memory:');
    createSchema(db, 'local');
    const before = TEAM_DELETE_TRIGGER_TABLES.map((t) => triggerSql(db, `${t}_team_ad`));
    createSchema(db, 'local');
    createSchema(db, 'local');
    const after = TEAM_DELETE_TRIGGER_TABLES.map((t) => triggerSql(db, `${t}_team_ad`));
    expect(after).toEqual(before);
    const stamped = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(stamped).toBe(SCHEMA_VERSION);
  });
});
