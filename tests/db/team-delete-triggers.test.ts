import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema } from '@myco/db/schema.js';
import { setTeamSyncEnabled } from '@myco/db/queries/team-sync-state.js';
import { setupTestDb, teardownTestDb, cleanTestDb } from '../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { deleteSessionCascade } from '@myco/db/queries/sessions.js';
import { TEAM_SYNC_OBSERVED_TABLES } from '@myco/db/queries/team-outbox.js';
import { TEAM_DELETE_TRIGGER_TABLES } from '@myco/db/schema-ddl.js';
// Relative import of the dependency-free worker module (not index.ts, which
// transitively pulls in the Workers-only `cloudflare:email`). Scope is the
// single source of truth for which synced tables are machine-scoped.
import {
  SYNCED_TABLES as WORKER_SYNCED_TABLES,
  SYNCED_TABLE_SCOPE,
} from '../../packages/myco-team/worker/src/synced-tables.ts';

// Import the real list rather than a hand-copy: the copy was itself a drift
// risk (a new trigger table added to schema-ddl.ts would not be exercised
// here). Cross-list parity is enforced in synced-table-parity.test.ts.
const TRIGGER_TABLES = TEAM_DELETE_TRIGGER_TABLES;

function newDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = OFF'); // isolate trigger behavior from FK cascades
  createSchema(db, 'local');
  return db;
}

describe('team delete triggers', () => {
  it('a spore delete with sync enabled journals exactly one delete outbox row', () => {
    const db = newDb();
    setTeamSyncEnabled(true, db);
    db.prepare(
      `INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at, machine_id)
       VALUES ('sp1', 'proj_x', 'user', 'decision', 'active', 'c', 1, 'local')`,
    ).run();
    db.prepare(`DELETE FROM spores WHERE id = 'sp1'`).run();

    const rows = db.prepare(
      `SELECT table_name, row_id, operation, payload, machine_id FROM team_outbox
        WHERE table_name = 'spores' AND operation = 'delete'`,
    ).all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].row_id).toBe('sp1');
    expect(rows[0].machine_id).toBe('local');
    expect(JSON.parse(rows[0].payload as string)).toEqual({ id: 'sp1', machine_id: 'local' });
  });

  it('an INTEGER-PK delete journals row_id as the decimal string of the id', () => {
    const db = newDb();
    setTeamSyncEnabled(true, db);
    db.prepare(
      `INSERT INTO prompt_batches (id, session_id, project_id, created_at, machine_id)
       VALUES (101, 's1', 'proj_x', 1, 'local')`,
    ).run();
    db.prepare(`DELETE FROM prompt_batches WHERE id = 101`).run();
    const row = db.prepare(
      `SELECT row_id, payload FROM team_outbox WHERE table_name='prompt_batches' AND operation='delete'`,
    ).get() as { row_id: string; payload: string };
    expect(row.row_id).toBe('101');
    expect(JSON.parse(row.payload).id).toBe(101);
  });

  it('deletes do NOT journal when sync is disabled (default)', () => {
    const db = newDb();
    db.prepare(
      `INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at, machine_id)
       VALUES ('sp2', 'proj_x', 'user', 'decision', 'active', 'c', 1, 'local')`,
    ).run();
    db.prepare(`DELETE FROM spores WHERE id = 'sp2'`).run();
    const n = db.prepare(`SELECT COUNT(*) AS n FROM team_outbox WHERE operation='delete'`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('every synced table has a delete trigger installed', () => {
    const db = newDb();
    const triggers = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as Array<{ name: string }>)
        .map((r) => r.name),
    );
    for (const table of TRIGGER_TABLES) {
      expect(triggers.has(`${table}_team_ad`)).toBe(true);
    }
  });
});

describe('session cascade journals child deletes via triggers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('deleting a session enqueues delete rows for the session and its synced children', () => {
    const db = getDatabase();
    setTeamSyncEnabled(true, db);
    db.prepare(
      `INSERT INTO sessions (id, agent, started_at, created_at, machine_id)
       VALUES ('s1', 'claude-code', 1, 1, 'local')`,
    ).run();
    db.prepare(
      `INSERT INTO prompt_batches (id, session_id, project_id, created_at, machine_id)
       VALUES (101, 's1', 'proj_x', 1, 'local')`,
    ).run();
    db.prepare(`INSERT INTO agents (id, name, created_at) VALUES ('a1', 'agent-1', 1)`).run();
    db.prepare(
      `INSERT INTO spores (id, agent_id, session_id, observation_type, content, created_at, machine_id)
       VALUES ('sp_c1', 'a1', 's1', 'decision', 'c', 1, 'local')`,
    ).run();
    deleteSessionCascade('s1');
    const deletes = db.prepare(
      `SELECT DISTINCT table_name FROM team_outbox WHERE operation='delete'`,
    ).all() as Array<{ table_name: string }>;
    const tables = new Set(deletes.map((d) => d.table_name));
    expect(tables.has('sessions')).toBe(true);
    expect(tables.has('prompt_batches')).toBe(true);
    expect(tables.has('spores')).toBe(true);
  });

  it('no duplicate outbox rows — each child table appears exactly once', () => {
    const db = getDatabase();
    setTeamSyncEnabled(true, db);
    db.prepare(
      `INSERT INTO sessions (id, agent, started_at, created_at, machine_id)
       VALUES ('s2', 'claude-code', 1, 1, 'local')`,
    ).run();
    db.prepare(
      `INSERT INTO prompt_batches (id, session_id, project_id, created_at, machine_id)
       VALUES (201, 's2', 'proj_x', 1, 'local')`,
    ).run();
    db.prepare(`INSERT INTO agents (id, name, created_at) VALUES ('a2', 'agent-2', 1)`).run();
    db.prepare(
      `INSERT INTO spores (id, agent_id, session_id, observation_type, content, created_at, machine_id)
       VALUES ('sp_c2', 'a2', 's2', 'decision', 'c', 1, 'local')`,
    ).run();
    deleteSessionCascade('s2');
    const sessRows = db.prepare(
      `SELECT COUNT(*) AS n FROM team_outbox WHERE table_name='sessions' AND operation='delete'`,
    ).get() as { n: number };
    const batchRows = db.prepare(
      `SELECT COUNT(*) AS n FROM team_outbox WHERE table_name='prompt_batches' AND operation='delete'`,
    ).get() as { n: number };
    const sporeRows = db.prepare(
      `SELECT COUNT(*) AS n FROM team_outbox WHERE table_name='spores' AND operation='delete'`,
    ).get() as { n: number };
    expect(sessRows.n).toBe(1);
    expect(batchRows.n).toBe(1);
    expect(sporeRows.n).toBe(1);
  });
});

describe('structural guard: every synced table has a delete trigger', () => {
  // Two DISTINCT reasons a synced table is intentionally trigger-less:
  //   - machine-scoped (e.g. team_members): no `project_id` column for the
  //     ${table}_team_ad trigger to journal — derived from SYNCED_TABLE_SCOPE.
  //   - no single `id` column (entity_mentions): the trigger journals OLD.id —
  //     a separate reason, still project-scoped.
  // Cross-list parity for these exclusions is enforced in
  // synced-table-parity.test.ts (NO_SINGLE_ID_TABLES / NO_DELETE_TRIGGER_TABLES).
  const machineScoped = WORKER_SYNCED_TABLES.filter((t) => SYNCED_TABLE_SCOPE[t] === 'machine');
  const NO_TRIGGER = new Set<string>([...machineScoped, 'entity_mentions']);
  it('covers all observed tables except the trigger-less exclusions', () => {
    const db = newDb();
    const triggers = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as Array<{ name: string }>)
        .map((r) => r.name),
    );
    const expected = TEAM_SYNC_OBSERVED_TABLES.filter((t) => !NO_TRIGGER.has(t));
    const missing = expected.filter((t) => !triggers.has(`${t}_team_ad`));
    expect(missing).toEqual([]);
  });
});

describe('write gate is per-Grove (no singleton bleed)', () => {
  it('enabled in Grove A, disabled in Grove B → deletes journal only in A', () => {
    const a = newDb();
    const b = newDb();
    setTeamSyncEnabled(true, a);
    setTeamSyncEnabled(false, b);

    for (const [db, id] of [[a, 'spA'], [b, 'spB']] as const) {
      db.prepare(
        `INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at, machine_id)
         VALUES (?, 'proj_x', 'user', 'decision', 'active', 'c', 1, 'local')`,
      ).run(id);
      db.prepare(`DELETE FROM spores WHERE id = ?`).run(id);
    }

    const aDeletes = a.prepare(`SELECT COUNT(*) AS n FROM team_outbox WHERE operation='delete'`).get() as { n: number };
    const bDeletes = b.prepare(`SELECT COUNT(*) AS n FROM team_outbox WHERE operation='delete'`).get() as { n: number };
    expect(aDeletes.n).toBe(1);
    expect(bDeletes.n).toBe(0);
  });
});
