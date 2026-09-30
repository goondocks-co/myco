/**
 * The query plans behind what a run read and what came of a session.
 *
 * Each statement is captured from the code as it reads a store shaped like a Deployment's, never restated here, and
 * explained under the statistics a Deployment's store plans from: none (a store never analyzed), `stale` (analyzed
 * before step 58 existed) and `current` (analyzed in use). Every read walks a Project-led index to the one session or
 * run it names; none reads a table whole.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { runReads, sessionOutcome } from '@myco-server-worker/read/run-reads.js';
import { analyzedStore, PROFILES } from './helpers/planner-stats.js';

type Statement = { sql: string; params: unknown[] };

/** A store that answers from `db` and remembers every statement it ran, with the values bound to it. */
function recording(db: Database): { store: RelationalStore; statements: Statement[] } {
  const inner = sqliteRelationalStore(db);
  const statements: Statement[] = [];
  const wrap = (sql: string, statement: PreparedStatement, record: Statement): PreparedStatement => ({
    ...statement,
    bind: (...values: unknown[]) => { record.params = values; return wrap(sql, statement.bind(...values), record); },
  });
  return {
    store: {
      prepare: (sql: string) => { const record = { sql, params: [] as unknown[] }; statements.push(record); return wrap(sql, inner.prepare(sql), record); },
      batch: (batched) => inner.batch(batched),
    },
    statements,
  };
}

function emptyStore(): Database {
  const db = new Database(':memory:');
  for (const statement of SCHEMA_DDL) db.run(statement);
  return db;
}

const STORES = { unanalyzed: emptyStore(), stale: analyzedStore(PROFILES.stale), current: analyzedStore(PROFILES.current) };
afterAll(() => { for (const store of Object.values(STORES)) store.close(); });

const planOf = (db: Database, { sql, params }: Statement): string =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params as never[]) as Array<{ detail: string }>).map((r) => r.detail).join('\n');
/** Steps that read a table whole. */
const tableScans = (plan: string): string[] => plan.split('\n').filter((step) => /\bSCAN\b/.test(step) && !/\bSCAN (?:x|\(subquery|CONSTANT ROW)/.test(step)).map((s) => s.trim());

/** Every statement the reads issue against the current store: a session a run read, a run with recorded reads, and a run known only by what it wrote. */
async function statements(): Promise<Statement[]> {
  const { store, statements: seen } = recording(STORES.current);
  const scope = { projectId: 'proj_0' };
  const read = STORES.current.query(`SELECT run_id AS runId, session_id AS sessionId FROM run_reads WHERE project_id = 'proj_0' LIMIT 1`).get() as { runId: string; sessionId: string };
  const unread = STORES.current.query(`SELECT sp.author AS runId FROM spores sp WHERE sp.project_id = 'proj_0' AND sp.author LIKE 'run_%'
    AND NOT EXISTS (SELECT 1 FROM run_reads rr WHERE rr.project_id = sp.project_id AND rr.run_id = sp.author) LIMIT 1`).get() as { runId: string };
  await sessionOutcome(store, scope, read.sessionId);
  expect((await runReads(store, scope, read.runId)).read.recorded).toBe(true);
  const fallback = await runReads(store, scope, unread.runId);
  expect({ recorded: fallback.read.recorded, spores: fallback.produced.spores.total > 0 }).toEqual({ recorded: false, spores: true });
  return seen;
}

describe('what a run read and what came of a session, under the statistics a Deployment plans from', () => {
  it('reads every statement through a Project-led index, scanning no table, on every store', async () => {
    const captured = await statements();
    expect(captured.length).toBe(3 + 4 + 4 + 2);
    for (const [store, db] of Object.entries(STORES)) {
      for (const statement of captured) {
        const plan = planOf(db, statement);
        expect({ store, sql: statement.sql.replace(/\s+/g, ' ').slice(0, 90), scans: tableScans(plan), plan })
          .toEqual({ store, sql: statement.sql.replace(/\s+/g, ' ').slice(0, 90), scans: [], plan });
      }
    }
  });

  it('finds the runs that read a session by the session index, and the spores written from it by the session\'s spore index', async () => {
    const captured = await statements();
    const bySession = captured.filter((s) => /FROM run_reads WHERE project_id = \? AND session_id = \?/.test(s.sql));
    const fromSession = captured.filter((s) => /FROM spores sp WHERE sp\.project_id = \? AND sp\.session_id = \?/.test(s.sql));
    expect({ bySession: bySession.length, fromSession: fromSession.length }).toEqual({ bySession: 1, fromSession: 1 });
    for (const [store, db] of Object.entries(STORES)) {
      expect({ store, plan: planOf(db, bySession[0]!) }).toEqual({ store, plan: expect.stringMatching(/SEARCH run_reads USING (?:COVERING )?INDEX idx_run_reads_session \(project_id=\? AND session_id=\?\)/) });
      expect({ store, plan: planOf(db, fromSession[0]!) }).toEqual({ store, plan: expect.stringMatching(/SEARCH sp USING INDEX idx_spores_session \(project_id=\? AND session_id=\?\)/) });
    }
  });

  it('binds at most the store\'s 100 values in any statement', async () => {
    for (const statement of await statements()) expect(statement.params.length).toBeLessThanOrEqual(100);
  });
});
