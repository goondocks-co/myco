/**
 * Tests for the v56 -> v57 migration: unify spore retirement on `obsolete`.
 *
 * Seeds v56-shaped rows (the legacy `archived` status + `archive` resolution
 * action, plus rows that must be left untouched), rewinds schema_version to 56,
 * re-runs createSchema to apply migrateV56ToV57, and asserts the rename.
 */

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

const now = 1_780_600_000;
const LOCAL = 'test-machine';
const PROJECT = 'proj_test1';

function seedAgent(db: Database, id = 'agent-1'): void {
  db.prepare(`INSERT OR IGNORE INTO agents (id, name, created_at) VALUES (?, 'Agent', ?)`).run(id, now);
}

function seedSpore(db: Database, id: string, status: string): void {
  db.prepare(
    `INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at, machine_id)
     VALUES (?, ?, 'agent-1', 'gotcha', ?, 'seed', ?, ?)`,
  ).run(id, PROJECT, status, now, LOCAL);
}

function seedResolutionEvent(db: Database, id: string, sporeId: string, action: string): void {
  db.prepare(
    `INSERT INTO resolution_events (id, project_id, agent_id, spore_id, action, created_at, machine_id)
     VALUES (?, ?, 'agent-1', ?, ?, ?, ?)`,
  ).run(id, PROJECT, sporeId, action, now, LOCAL);
}

function statusOf(db: Database, id: string): string {
  return (db.prepare(`SELECT status FROM spores WHERE id = ?`).get(id) as { status: string }).status;
}

function actionOf(db: Database, id: string): string {
  return (db.prepare(`SELECT action FROM resolution_events WHERE id = ?`).get(id) as { action: string }).action;
}

/** Build a v56 DB with the full schema, legacy data seeded, version rewound to 56. */
function seedV56Db(): Database {
  const db = new Database(':memory:');
  createSchema(db, LOCAL); // builds tables + runs all migrations (version -> 57)
  seedAgent(db);

  // Legacy rows that MUST be renamed.
  seedSpore(db, 'spore-archived', 'archived');
  seedResolutionEvent(db, 'res-archive', 'spore-archived', 'archive');

  // Rows that MUST be left untouched.
  seedSpore(db, 'spore-active', 'active');
  seedSpore(db, 'spore-superseded', 'superseded');
  seedSpore(db, 'spore-consolidated', 'consolidated');
  seedSpore(db, 'spore-obsolete', 'obsolete');
  seedResolutionEvent(db, 'res-supersede', 'spore-superseded', 'supersede');
  seedResolutionEvent(db, 'res-consolidate', 'spore-consolidated', 'consolidate');

  // Rewind so re-running createSchema applies only migrateV56ToV57.
  db.prepare('DELETE FROM schema_version').run();
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (56, ?)').run(now);
  return db;
}

describe('migration v56 -> v57: unify spore retirement on obsolete', () => {
  it('renames archived spores to obsolete and leaves other statuses untouched', () => {
    const db = seedV56Db();
    createSchema(db, LOCAL); // applies migrateV56ToV57

    expect(statusOf(db, 'spore-archived')).toBe('obsolete');
    expect(statusOf(db, 'spore-active')).toBe('active');
    expect(statusOf(db, 'spore-superseded')).toBe('superseded');
    expect(statusOf(db, 'spore-consolidated')).toBe('consolidated');
    expect(statusOf(db, 'spore-obsolete')).toBe('obsolete');
    db.close();
  });

  it('renames archive resolution events to obsolete and leaves other actions untouched', () => {
    const db = seedV56Db();
    createSchema(db, LOCAL);

    expect(actionOf(db, 'res-archive')).toBe('obsolete');
    expect(actionOf(db, 'res-supersede')).toBe('supersede');
    expect(actionOf(db, 'res-consolidate')).toBe('consolidate');
    db.close();
  });

  it('advances schema_version to the current SCHEMA_VERSION', () => {
    const db = seedV56Db();
    createSchema(db, LOCAL);

    const { version } = db.prepare(`SELECT MAX(version) AS version FROM schema_version`).get() as { version: number };
    expect(version).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('is idempotent — re-running leaves the renamed rows obsolete', () => {
    const db = seedV56Db();
    createSchema(db, LOCAL); // first application
    createSchema(db, LOCAL); // no-op (already at 57)

    expect(statusOf(db, 'spore-archived')).toBe('obsolete');
    expect(actionOf(db, 'res-archive')).toBe('obsolete');
    // No stray 'archived' rows remain.
    const archivedCount = (db.prepare(`SELECT COUNT(*) AS n FROM spores WHERE status = 'archived'`).get() as { n: number }).n;
    expect(archivedCount).toBe(0);
    db.close();
  });
});
