import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

describe('migration v50 -> v51', () => {
  it('current SCHEMA_VERSION is at least 51', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(51);
  });

  it('upgrading a v50 DB installs team_sync_state and the delete triggers', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    createSchema(db, 'local'); // fresh install lands at SCHEMA_VERSION
    // Mimic a pre-v51 vault: drop the new objects and stamp version back to 50.
    db.exec(`DROP TRIGGER IF EXISTS spores_team_ad`);
    db.exec(`DROP TABLE IF EXISTS team_sync_state`);
    db.prepare(`DELETE FROM schema_version`).run();
    db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (50, 0)`).run();

    createSchema(db, 'local'); // should run migrateV50ToV51 then reapply

    const tbl = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='team_sync_state'`,
    ).get();
    expect(tbl).toBeTruthy();
    const trg = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND name='spores_team_ad'`,
    ).get();
    expect(trg).toBeTruthy();
    const ver = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number };
    expect(ver.v).toBeGreaterThanOrEqual(51);
  });
});
