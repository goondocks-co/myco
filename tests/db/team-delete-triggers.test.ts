import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema } from '@myco/db/schema.js';
import { setTeamSyncEnabled } from '@myco/db/queries/team-sync-state.js';
import { setupTestDb, teardownTestDb, cleanTestDb } from '../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { deleteSessionCascade } from '@myco/db/queries/sessions.js';

const TRIGGER_TABLES = [
  'sessions', 'prompt_batches', 'spores', 'entities', 'graph_edges',
  'resolution_events', 'plans', 'artifacts', 'digest_extracts',
  'skill_candidates', 'skill_records', 'skill_usage', 'knowledge_release_state',
] as const;

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
