import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { createGroveId } from '@myco/grove/ids.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { getMachineId, resetMachineIdCache } from '@myco/machine-id.js';
import { TEAM_SYNC_OBSERVED_TABLES } from '@myco/db/queries/team-outbox.js';

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
  it('SCHEMA_VERSION is at least 52', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(52);
  });

  it('converts machine_id="local" rows in synced tables, but skips local-only tables', () => {
    const db = makeV51Db('local');

    // Insert rows under machine_id='local'. v52 is scoped to the SYNCED table set
    // (TEAM_SYNC_OBSERVED_TABLES). knowledge_release_state and skill_usage are
    // synced and must be converted; knowledge_git_provenance is LOCAL-ONLY and
    // must NOT be touched (it carries local branch names / patch evidence and is
    // never pushed to the team — see LOCAL_ONLY_OUTBOX_TABLES).

    // knowledge_release_state (synced, has machine_id + synced_at)
    db.prepare(`
      INSERT INTO knowledge_release_state
        (id, machine_id, identity_key, namespace, record_id, state, confidence, checked_at, created_at, synced_at)
      VALUES (101, 'local', 'ik-krs-1', 'ns', 'rec-1', 'released', 'high', 1000, 1000, 999)
    `).run();

    // knowledge_git_provenance (LOCAL-ONLY, has machine_id, no synced_at column)
    db.prepare(`
      INSERT INTO knowledge_git_provenance
        (id, machine_id, identity_key, capture_point, captured_at, status_hash, created_at)
      VALUES (201, 'local', 'ik-kgp-1', 'test', 1000, 'sha123', 1000)
    `).run();

    // skill_usage (synced, no synced_at column)
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

    // (a) No machine_id='local' rows remain in the SYNCED tables
    const krsLocalAfter = db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_release_state WHERE machine_id='local'`,
    ).get() as { n: number };
    expect(krsLocalAfter.n).toBe(0);

    const suLocalAfter = db.prepare(
      `SELECT COUNT(*) AS n FROM skill_usage WHERE machine_id='local'`,
    ).get() as { n: number };
    expect(suLocalAfter.n).toBe(0);

    // (a') the LOCAL-ONLY table is intentionally left untouched
    const kgpLocalAfter = db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_git_provenance WHERE machine_id='local'`,
    ).get() as { n: number };
    expect(kgpLocalAfter.n).toBe(1);

    // (b) synced rows now carry the real machine_id; the local-only row stays 'local'
    const krsRow = db.prepare(
      `SELECT machine_id, synced_at FROM knowledge_release_state WHERE id = 101`,
    ).get() as { machine_id: string; synced_at: number | null };
    expect(krsRow.machine_id).toBe('real_machine_xyz');

    const kgpRow = db.prepare(
      `SELECT machine_id FROM knowledge_git_provenance WHERE id = 201`,
    ).get() as { machine_id: string };
    expect(kgpRow.machine_id).toBe('local');

    const suRow = db.prepare(
      `SELECT machine_id FROM skill_usage WHERE id = 'su-1'`,
    ).get() as { machine_id: string };
    expect(suRow.machine_id).toBe('real_machine_xyz');

    // (c) synced_at reset to NULL on tables that have the column
    expect(krsRow.synced_at).toBeNull();

    // (d) schema_version MAX advanced to the current version (chain runs v52+).
    const ver = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number };
    expect(ver.v).toBe(SCHEMA_VERSION);
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
    expect(ver.v).toBe(SCHEMA_VERSION);
  });

  it('converts synced-table rows but leaves team_outbox (column AND payload) untouched', () => {
    const db = makeV51Db('local');

    // Synced-table rows under 'local' (spores has machine_id + synced_at; plans too).
    db.prepare(`
      INSERT INTO spores (id, agent_id, observation_type, content, created_at, machine_id, synced_at)
      VALUES ('sp-1', 'agent-x', 'note', 'hello', 1000, 'local', 999)
    `).run();
    db.prepare(`
      INSERT INTO plans (id, logical_key, content, created_at, machine_id, synced_at)
      VALUES ('pl-1', 'lk-1', 'plan body', 1000, 'local', 999)
    `).run();

    // An already-sent outbox row queued under 'local', with the routing identity also
    // embedded in the payload JSON. v52 must NOT rewrite either, or the column/payload
    // desync (worker upsert lets the payload machine_id win). Seeded as sent
    // (sent_at NOT NULL), not pending, so it survives the terminal quiesce
    // migration (v72) later in this same chain run — that step purges only
    // pending (sent_at IS NULL) rows, and v52's untouched-ness is orthogonal
    // to sent/pending status either way.
    const payloadLocal = JSON.stringify({ id: 'sp-1', machine_id: 'local', content: 'hello' });
    db.prepare(`
      INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, created_at, sent_at)
      VALUES ('spores', 'sp-1', 'upsert', ?, 'local', 1000, 1500)
    `).run(payloadLocal);

    createSchema(db, 'real_machine_xyz');

    // (a) synced-table rows converted to the real id, synced_at reset where present
    const sp = db.prepare(`SELECT machine_id, synced_at FROM spores WHERE id = 'sp-1'`).get() as {
      machine_id: string;
      synced_at: number | null;
    };
    expect(sp.machine_id).toBe('real_machine_xyz');
    expect(sp.synced_at).toBeNull();

    const pl = db.prepare(`SELECT machine_id, synced_at FROM plans WHERE id = 'pl-1'`).get() as {
      machine_id: string;
      synced_at: number | null;
    };
    expect(pl.machine_id).toBe('real_machine_xyz');
    expect(pl.synced_at).toBeNull();

    // (b) team_outbox row untouched: both the column AND the payload still 'local'
    const ob = db.prepare(`SELECT machine_id, payload FROM team_outbox WHERE row_id = 'sp-1'`).get() as {
      machine_id: string;
      payload: string;
    };
    expect(ob.machine_id).toBe('local');
    expect(ob.payload).toBe(payloadLocal);
    expect((JSON.parse(ob.payload) as { machine_id: string }).machine_id).toBe('local');

    // (c) re-run is a no-op: no synced 'local' rows remain, outbox still intact
    createSchema(db, 'real_machine_xyz');
    const spLocal = db.prepare(`SELECT COUNT(*) AS n FROM spores WHERE machine_id='local'`).get() as { n: number };
    expect(spLocal.n).toBe(0);
    const obAfter = db.prepare(`SELECT machine_id, payload FROM team_outbox WHERE row_id = 'sp-1'`).get() as {
      machine_id: string;
      payload: string;
    };
    expect(obAfter.machine_id).toBe('local');
    expect(obAfter.payload).toBe(payloadLocal);
  });

  it('warns (but still stamps v52) when the local-machineId path sees unconverted synced rows', () => {
    const db = makeV51Db('local');
    db.prepare(`
      INSERT INTO spores (id, agent_id, observation_type, content, created_at, machine_id)
      VALUES ('sp-warn', 'agent-x', 'note', 'orphan', 1000, 'local')
    `).run();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      // machineId='local' would otherwise be a silent no-op skip — the warning makes
      // the dead-conversion (a Grove-open call site not passing getMachineId()) visible.
      createSchema(db, 'local');
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.some((w) => w.includes('v52 skipped machine_id conversion'))).toBe(true);
    // Row left as-is (we don't have a real id to convert to), but version still advances.
    const row = db.prepare(`SELECT machine_id FROM spores WHERE id = 'sp-warn'`).get() as { machine_id: string };
    expect(row.machine_id).toBe('local');
    const ver = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number };
    expect(ver.v).toBe(SCHEMA_VERSION);
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

    // Version still advances to the current version (chain runs v52+).
    const ver = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number };
    expect(ver.v).toBe(SCHEMA_VERSION);
  });
});

/**
 * Regression guard for Issue #1: the runtime Grove-DB-open path must pass the
 * REAL machine id to createSchema so the v52 conversion actually runs. Before
 * the fix, ensureGroveDatabase called createSchema(db) (defaulting to 'local'),
 * so a v51 Grove DB with machine_id='local' rows was stamped v52 with the
 * conversion permanently skipped.
 */
describe('migration v52 — runtime Grove-open path passes the real machineId', () => {
  let tmpHome: string;

  afterEach(() => {
    delete process.env.MYCO_HOME;
    resetMachineIdCache();
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('ensureGroveDatabase converts machine_id="local" synced rows in a v51 Grove DB', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-v52-'));
    process.env.MYCO_HOME = tmpHome;
    resetMachineIdCache();
    // Seed a deterministic machine id so getMachineId() doesn't shell out to gh.
    fs.writeFileSync(path.join(tmpHome, 'machine_id'), 'runtime_real_id', 'utf-8');
    expect(getMachineId()).toBe('runtime_real_id');

    const groveId = createGroveId();
    const dbPath = resolveGroveDbPath(groveId, tmpHome);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Build a v51-stamped Grove DB on disk with a 'local' synced row.
    {
      const seed = new Database(dbPath);
      seed.exec('PRAGMA foreign_keys = OFF');
      createSchema(seed, 'local'); // full schema, lands at current version
      seed.prepare(`DELETE FROM schema_version WHERE version = ${SCHEMA_VERSION}`).run();
      seed.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (51, 0) ON CONFLICT (version) DO NOTHING`).run();
      seed.prepare(`
        INSERT INTO spores (id, agent_id, observation_type, content, created_at, machine_id)
        VALUES ('rt-sp', 'agent-x', 'note', 'runtime', 1000, 'local')
      `).run();
      seed.close();
    }

    // Open through the runtime choke point — internally uses getMachineId().
    const result = ensureGroveDatabase(groveId, tmpHome);
    expect(result.schemaVersion).toBe(SCHEMA_VERSION);

    // Re-open and assert the v52 conversion ran via the real id.
    const check = new Database(dbPath);
    try {
      let leftoverLocal = 0;
      for (const table of TEAM_SYNC_OBSERVED_TABLES) {
        const cols = new Set(
          (check.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
        );
        if (!cols.has('machine_id')) continue;
        const row = check.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE machine_id='local'`).get() as { n: number };
        leftoverLocal += row.n;
      }
      expect(leftoverLocal).toBe(0);

      const sp = check.prepare(`SELECT machine_id FROM spores WHERE id = 'rt-sp'`).get() as { machine_id: string };
      expect(sp.machine_id).toBe('runtime_real_id');
    } finally {
      check.close();
    }
  });
});
