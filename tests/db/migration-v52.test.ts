import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

/**
 * Simulate a vault that has been upgraded to v51 (full schema in place, but
 * only v51 stamped in schema_version). This is the starting state for the
 * v51→v52 migration.
 *
 * We call createSchema() to get all tables, then replace the schema_version
 * stamp with just `51`. That makes createSchema() on the next call see
 * getCurrentVersion()=51 and run only the v52 migration.
 */
function makeV51Db(machineId: string = 'local'): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = OFF'); // allow FK-free inserts for test fixtures
  createSchema(db, machineId);         // lands at v52 (current SCHEMA_VERSION)
  // Stamp back to v51: delete the current version entry and insert v51.
  db.prepare(`DELETE FROM schema_version WHERE version = ${SCHEMA_VERSION}`).run();
  db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (51, 0) ON CONFLICT (version) DO NOTHING`).run();
  return db;
}

describe('migration v51 -> v52', () => {
  it('SCHEMA_VERSION is 52', () => {
    expect(SCHEMA_VERSION).toBe(52);
  });

  it('upgrades a v51 DB and converts machine_id="local" rows to the real id', () => {
    const db = makeV51Db('local');

    // Insert rows under machine_id='local' into tables that migrateV6ToV7 missed.
    // Set synced_at non-null where the column exists, to confirm it gets reset.

    // knowledge_release_state (missed by v7, has machine_id + synced_at)
    db.prepare(`
      INSERT INTO knowledge_release_state
        (id, machine_id, identity_key, namespace, record_id, state, confidence, checked_at, created_at, synced_at)
      VALUES (101, 'local', 'ik-krs-1', 'ns', 'rec-1', 'released', 'high', 1000, 1000, 999)
    `).run();

    // knowledge_git_provenance (missed by v7, no synced_at column)
    db.prepare(`
      INSERT INTO knowledge_git_provenance
        (id, machine_id, identity_key, capture_point, captured_at, status_hash, created_at)
      VALUES (201, 'local', 'ik-kgp-1', 'test', 1000, 'sha123', 1000)
    `).run();

    // skill_usage (missed by v7, no synced_at column)
    db.prepare(`
      INSERT INTO skill_usage
        (id, machine_id, skill_id, session_id, detected_at)
      VALUES ('su-1', 'local', 'sk-1', 'sess-1', 1000)
    `).run();

    // Confirm rows are currently 'local'
    const krsLocalBefore = db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_release_state WHERE machine_id='local'`,
    ).get() as { n: number };
    expect(krsLocalBefore.n).toBe(1);

    const kgpLocalBefore = db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_git_provenance WHERE machine_id='local'`,
    ).get() as { n: number };
    expect(kgpLocalBefore.n).toBe(1);

    const suLocalBefore = db.prepare(
      `SELECT COUNT(*) AS n FROM skill_usage WHERE machine_id='local'`,
    ).get() as { n: number };
    expect(suLocalBefore.n).toBe(1);

    // Run the v52 migration
    createSchema(db, 'real_machine_xyz');

    // (a) No machine_id='local' rows remain in the affected tables
    const krsLocalAfter = db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_release_state WHERE machine_id='local'`,
    ).get() as { n: number };
    expect(krsLocalAfter.n).toBe(0);

    const kgpLocalAfter = db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_git_provenance WHERE machine_id='local'`,
    ).get() as { n: number };
    expect(kgpLocalAfter.n).toBe(0);

    const suLocalAfter = db.prepare(
      `SELECT COUNT(*) AS n FROM skill_usage WHERE machine_id='local'`,
    ).get() as { n: number };
    expect(suLocalAfter.n).toBe(0);

    // (b) Rows now carry the real machine_id
    const krsRow = db.prepare(
      `SELECT machine_id, synced_at FROM knowledge_release_state WHERE id = 101`,
    ).get() as { machine_id: string; synced_at: number | null };
    expect(krsRow.machine_id).toBe('real_machine_xyz');

    const kgpRow = db.prepare(
      `SELECT machine_id FROM knowledge_git_provenance WHERE id = 201`,
    ).get() as { machine_id: string };
    expect(kgpRow.machine_id).toBe('real_machine_xyz');

    const suRow = db.prepare(
      `SELECT machine_id FROM skill_usage WHERE id = 'su-1'`,
    ).get() as { machine_id: string };
    expect(suRow.machine_id).toBe('real_machine_xyz');

    // (c) synced_at reset to NULL on tables that have the column
    expect(krsRow.synced_at).toBeNull();

    // (d) schema_version MAX is 52
    const ver = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number };
    expect(ver.v).toBe(52);
  });

  it('is idempotent: running createSchema twice produces no error and zero "local" rows', () => {
    const db = makeV51Db('local');

    // Insert a 'local' row before the first migration run
    db.prepare(`
      INSERT INTO knowledge_release_state
        (id, machine_id, identity_key, namespace, record_id, state, confidence, checked_at, created_at)
      VALUES (102, 'local', 'ik-krs-2', 'ns', 'rec-2', 'released', 'high', 1000, 1000)
    `).run();

    // First run — migrates to v52
    createSchema(db, 'real_machine_xyz');

    // Second run — version already stamped, migration skipped
    createSchema(db, 'real_machine_xyz');

    const localCount = db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_release_state WHERE machine_id='local'`,
    ).get() as { n: number };
    expect(localCount.n).toBe(0);

    const ver = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number };
    expect(ver.v).toBe(52);
  });

  it('is a no-op for all tables when machineId is "local" (guards against breaking identity)', () => {
    const db = makeV51Db('local');

    // Insert a 'local' row
    db.prepare(`
      INSERT INTO knowledge_release_state
        (id, machine_id, identity_key, namespace, record_id, state, confidence, checked_at, created_at)
      VALUES (103, 'local', 'ik-krs-3', 'ns', 'rec-3', 'released', 'high', 1000, 1000)
    `).run();

    // Run with machineId='local' — should stamp v52 but not corrupt data
    createSchema(db, 'local');

    // Row should still have machine_id='local' (migration skips when machineId==='local')
    const row = db.prepare(
      `SELECT machine_id FROM knowledge_release_state WHERE id = 103`,
    ).get() as { machine_id: string };
    expect(row.machine_id).toBe('local');

    // Version still advances to 52
    const ver = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number };
    expect(ver.v).toBe(52);
  });
});
