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
import { recordRunReads } from '@myco-server-worker/core/runs.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { analyzedStore, PROFILES } from './helpers/planner-stats.js';

type Statement = { sql: string; params: unknown[] };

/**
 * A store that answers from `db` and remembers every statement it ran, with the values bound to it. With `writes:
 * false` a batch is remembered and answered as changing nothing, so a write's statements are captured without
 * moving the store the other reads are planned on.
 */
function recording(db: Database, options: { writes: boolean } = { writes: true }): { store: RelationalStore; statements: Statement[] } {
  const inner = sqliteRelationalStore(db);
  const statements: Statement[] = [];
  const wrap = (sql: string, statement: PreparedStatement, record: Statement): PreparedStatement => ({
    ...statement,
    bind: (...values: unknown[]) => { record.params = values; return wrap(sql, statement.bind(...values), record); },
  });
  return {
    store: {
      prepare: (sql: string) => { const record = { sql, params: [] as unknown[] }; statements.push(record); return wrap(sql, inner.prepare(sql), record); },
      batch: (batched) => (options.writes ? inner.batch(batched) : Promise.resolve(batched.map(() => ({ results: [], meta: { changes: 0 } })))),
    },
    statements,
  };
}

/**
 * The statements that write `run_reads`: a run's record of a page's sessions, and a session's deletion. They are
 * captured off the stale store, whose reads the deletion runs, and explained on every store like the rest.
 */
let recordAndDelete: Promise<Statement[]> | null = null;
const writes = (): Promise<Statement[]> => (recordAndDelete ??= captureWrites());
async function captureWrites(): Promise<Statement[]> {
  const { store, statements: seen } = recording(STORES.stale, { writes: false });
  const scope = { projectId: 'proj_0' };
  const read = STORES.stale.query(`SELECT rr.run_id AS runId, rr.session_id AS sessionId FROM run_reads rr
    JOIN sessions s ON s.project_id = rr.project_id AND s.session_id = rr.session_id WHERE rr.project_id = 'proj_0' LIMIT 1`).all()[0] as { runId: string; sessionId: string };
  await recordRunReads(store, scope, { runId: read.runId, tokenId: 'mt_run', sessionIds: [read.sessionId, 's1'], receivedAt: 1 });
  await tombstoneSession({ db: store }, scope, read.sessionId, 'mem_0', 1);
  const written = seen.filter((s) => /^\s*(INSERT INTO|DELETE FROM) run_reads\b/.test(s.sql));
  expect(written.map((s) => s.sql.trim().slice(0, 22))).toEqual(['INSERT INTO run_reads ', 'INSERT INTO run_reads ', 'DELETE FROM run_reads ']);
  return written;
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
let reads: Promise<Statement[]> | null = null;
/** The reads' statements, captured once: the store is read the same way by every test. */
const statements = (): Promise<Statement[]> => (reads ??= capture());
async function capture(): Promise<Statement[]> {
  const { store, statements: seen } = recording(STORES.current);
  const scope = { projectId: 'proj_0' };
  const read = STORES.current.query(`SELECT run_id AS runId, session_id AS sessionId FROM run_reads WHERE project_id = 'proj_0' LIMIT 1`).all()[0] as { runId: string; sessionId: string };
  const unread = STORES.current.query(`SELECT sp.author AS runId FROM spores sp WHERE sp.project_id = 'proj_0' AND sp.author LIKE 'run_%'
    AND NOT EXISTS (SELECT 1 FROM run_reads rr WHERE rr.project_id = sp.project_id AND rr.run_id = sp.author) LIMIT 1`).all()[0] as { runId: string };
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

  it('finds the runs dispatched on a session by the run-context index', async () => {
    const [runs] = (await statements()).filter((s) => /AS target/.test(s.sql));
    for (const [store, db] of Object.entries(STORES)) {
      expect({ store, plan: planOf(db, runs!) }).toEqual({ store, plan: expect.stringMatching(/SEARCH agent_runs USING (?:COVERING )?INDEX idx_agent_runs_session \(project_id=\? AND <expr>=\?\)/) });
    }
  });

  it('records a read and removes a deleted session\'s reads by key, scanning no table, on every store', async () => {
    const written = await writes();
    for (const [store, db] of Object.entries(STORES)) {
      for (const statement of written) {
        const plan = planOf(db, statement);
        expect({ store, sql: statement.sql.replace(/\s+/g, ' ').slice(0, 60), scans: tableScans(plan), plan })
          .toEqual({ store, sql: statement.sql.replace(/\s+/g, ' ').slice(0, 60), scans: [], plan });
      }
      expect({ store, plan: planOf(db, written[2]!) }).toEqual({ store, plan: expect.stringMatching(/SEARCH run_reads USING (?:COVERING )?INDEX idx_run_reads_session \(project_id=\? AND session_id=\?\)/) });
    }
  });

  it('binds at most the store\'s 100 values in any statement', async () => {
    for (const statement of [...await statements(), ...await writes()]) expect(statement.params.length).toBeLessThanOrEqual(100);
  });
});
