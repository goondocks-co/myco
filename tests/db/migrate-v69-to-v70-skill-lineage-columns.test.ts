/**
 * Tests for the v69 -> v70 migration: guard for the v67 skill_lineage
 * sync-column gap.
 *
 * migrateV66ToV67 guards its skill_lineage machine_id/synced_at ALTERs with
 * getTableColumnSet(), but that guard only runs for a vault MIGRATING
 * THROUGH v67 — the migration loop skips a step once
 * `currentVersion >= step.version` (see createSchema() in schema.ts). A
 * vault already stamped schema_version=67 whose skill_lineage table lacks
 * these columns (e.g. one that ran an earlier iteration of the v67 body
 * before the column guard was authored) skips migrateV66ToV67 on every
 * later boot, and reapplyCurrentSchemaDdl() does not backfill column drift
 * (it only replays CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS DDL).
 *
 * Builds a v67-shaped vault with the pre-guard skill_lineage shape (drop the
 * two columns, drop the delete trigger that references OLD.machine_id,
 * rewind schema_version to exactly 67), re-runs createSchema to apply
 * migrateV69ToV70, and asserts the delta in isolation.
 */

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { setTeamSyncEnabled } from '@myco/db/queries/team-sync-state.js';

const now = 1_782_000_000;
const PROJECT = 'proj_test1';

function columnNames(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function stampedVersion(db: Database): number {
  return (db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v;
}

/**
 * Build a v67-shaped vault with the PRE-GUARD skill_lineage shape: full
 * current schema minus the machine_id/synced_at columns on skill_lineage
 * and minus the delete trigger that depends on them, stamped at exactly 67
 * (not the incremental per-version history a real upgrade leaves — a fresh
 * install only stamps one row at SCHEMA_VERSION, so the row set is rebuilt
 * here to simulate "ran some historical v67 body, got stamped 67, never
 * came back").
 */
function seedV67WithoutLineageColumnsDb(): Database {
  const db = new Database(':memory:');
  createSchema(db);
  db.exec('DROP TRIGGER IF EXISTS skill_lineage_team_ad');
  db.exec('ALTER TABLE skill_lineage DROP COLUMN machine_id');
  db.exec('ALTER TABLE skill_lineage DROP COLUMN synced_at');
  db.prepare('DELETE FROM schema_version').run();
  db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (67, ?)`).run(now);
  return db;
}

/** Same, but the post-guard shape (columns already present) stamped at 67 — the covered case. */
function seedV67WithLineageColumnsDb(): Database {
  const db = new Database(':memory:');
  createSchema(db);
  db.prepare('DELETE FROM schema_version').run();
  db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (67, ?)`).run(now);
  return db;
}

function seedAgent(db: Database, id = 'agent-1'): void {
  db.prepare(`INSERT OR IGNORE INTO agents (id, name, created_at) VALUES (?, 'Agent', ?)`).run(id, now);
}

function seedSkillRecord(db: Database, id: string, machineId: string): void {
  db.prepare(
    `INSERT INTO skill_records (id, project_id, agent_id, name, display_name, description, status, generation, path, created_at, updated_at, machine_id)
     VALUES (?, ?, 'agent-1', ?, ?, 'A test skill', 'active', 1, ?, ?, ?, ?)`,
  ).run(id, PROJECT, id, id, `.myco/skills/${id}.md`, now, now, machineId);
}

/** Insert a skill_lineage row WITHOUT machine_id/synced_at (pre-guard column set). */
function seedLineageRowNoSyncCols(db: Database, id: string, skillId: string): void {
  db.prepare(
    `INSERT INTO skill_lineage (id, project_id, skill_id, generation, action, rationale, source_ids_added, content_snapshot, created_at)
     VALUES (?, ?, ?, 1, 'create', 'initial', '[]', '# content', ?)`,
  ).run(id, PROJECT, skillId, now);
}

describe('migrateV69ToV70 — skill_lineage sync-column guard', () => {
  it('SCHEMA_VERSION includes this migration', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(70);
  });

  it('fresh install already has both columns (this migration is a pure existing-vault guard)', () => {
    const db = new Database(':memory:');
    createSchema(db);
    expect(columnNames(db, 'skill_lineage')).toContain('machine_id');
    expect(columnNames(db, 'skill_lineage')).toContain('synced_at');
    db.close();
  });

  it('a v67-stamped vault missing skill_lineage.machine_id/synced_at gets them added, stamping v70', () => {
    const db = seedV67WithoutLineageColumnsDb();
    expect(columnNames(db, 'skill_lineage')).not.toContain('machine_id');
    expect(columnNames(db, 'skill_lineage')).not.toContain('synced_at');

    createSchema(db);

    const cols = columnNames(db, 'skill_lineage');
    expect(cols).toContain('machine_id');
    expect(cols).toContain('synced_at');
    expect(stampedVersion(db)).toBe(SCHEMA_VERSION);

    db.close();
  });

  it('backfills machine_id from the parent skill_records row for pre-existing lineage rows', () => {
    const db = seedV67WithoutLineageColumnsDb();
    seedAgent(db);
    seedSkillRecord(db, 'skill-1', 'dogfood-machine-42');
    seedLineageRowNoSyncCols(db, 'lin-1', 'skill-1');

    createSchema(db);

    const row = db.prepare(`SELECT machine_id, synced_at FROM skill_lineage WHERE id = 'lin-1'`).get() as
      | { machine_id: string; synced_at: number | null }
      | undefined;
    expect(row?.machine_id).toBe('dogfood-machine-42');
    expect(row?.synced_at).toBeNull();

    db.close();
  });

  it('falls back to "local" for a lineage row whose skill_id has no matching skill_records row', () => {
    const db = seedV67WithoutLineageColumnsDb();
    seedLineageRowNoSyncCols(db, 'lin-orphan', 'skill-does-not-exist');

    createSchema(db);

    const row = db.prepare(`SELECT machine_id FROM skill_lineage WHERE id = 'lin-orphan'`).get() as { machine_id: string };
    expect(row.machine_id).toBe('local');

    db.close();
  });

  it('unrelated rows survive the migration untouched', () => {
    const db = seedV67WithoutLineageColumnsDb();
    seedAgent(db);
    db.prepare(
      `INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at, machine_id)
       VALUES ('spore-1', ?, 'agent-1', 'gotcha', 'active', 'unrelated content survives', ?, 'local')`,
    ).run(PROJECT, now);

    createSchema(db);

    const spore = db.prepare(`SELECT content FROM spores WHERE id = 'spore-1'`).get() as { content: string } | undefined;
    expect(spore?.content).toBe('unrelated content survives');

    db.close();
  });

  it('re-running createSchema on an already-migrated vault is idempotent', () => {
    const db = seedV67WithoutLineageColumnsDb();
    seedAgent(db);
    seedSkillRecord(db, 'skill-1', 'm1');
    seedLineageRowNoSyncCols(db, 'lin-1', 'skill-1');

    createSchema(db);
    createSchema(db); // second boot

    const n = (db.prepare(`SELECT COUNT(*) AS n FROM skill_lineage`).get() as { n: number }).n;
    expect(n).toBe(1);
    const row = db.prepare(`SELECT machine_id FROM skill_lineage WHERE id = 'lin-1'`).get() as { machine_id: string };
    expect(row.machine_id).toBe('m1');
    expect(stampedVersion(db)).toBe(SCHEMA_VERSION);

    db.close();
  });

  it('is a no-op on a v67 vault that already has the columns (post-guard) — no duplicate-column error, data untouched', () => {
    const db = seedV67WithLineageColumnsDb();
    seedAgent(db);
    seedSkillRecord(db, 'skill-1', 'm1');
    db.prepare(
      `INSERT INTO skill_lineage (id, project_id, skill_id, generation, action, rationale, source_ids_added, content_snapshot, created_at, machine_id, synced_at)
       VALUES ('lin-1', ?, 'skill-1', 1, 'create', 'initial', '[]', '# content', ?, 'm1', NULL)`,
    ).run(PROJECT, now);

    expect(() => createSchema(db)).not.toThrow();

    expect(stampedVersion(db)).toBe(SCHEMA_VERSION);
    const row = db.prepare(`SELECT machine_id, synced_at FROM skill_lineage WHERE id = 'lin-1'`).get() as
      | { machine_id: string; synced_at: number | null };
    expect(row.machine_id).toBe('m1');
    expect(row.synced_at).toBeNull();

    db.close();
  });

  it('converges the skill_lineage delete trigger so it can resolve OLD.machine_id after the migration', () => {
    const db = seedV67WithoutLineageColumnsDb();
    db.exec('PRAGMA foreign_keys = OFF');
    setTeamSyncEnabled(true, db);
    db.prepare('INSERT OR IGNORE INTO team_sync_membership (project_id, team_id) VALUES (?, ?)').run(PROJECT, 'team_test');
    seedAgent(db);
    seedSkillRecord(db, 'skill-1', 'm1');
    seedLineageRowNoSyncCols(db, 'lin-1', 'skill-1');

    createSchema(db); // applies migrateV69ToV70, converts the pre-guard row + trigger

    db.prepare(`DELETE FROM skill_lineage WHERE id = 'lin-1'`).run();

    const outboxRow = db.prepare(
      `SELECT row_id, machine_id, payload FROM team_outbox WHERE table_name = 'skill_lineage' AND operation = 'delete'`,
    ).get() as { row_id: string; machine_id: string; payload: string } | undefined;

    expect(outboxRow?.row_id).toBe('lin-1');
    expect(outboxRow?.machine_id).toBe('m1');
    expect(JSON.parse(outboxRow!.payload)).toEqual({ id: 'lin-1', machine_id: 'm1' });

    db.close();
  });
});
