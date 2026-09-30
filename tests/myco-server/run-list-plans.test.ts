/**
 * The query plans behind the run list, a run's detail, and the spores one run wrote.
 *
 * Each statement is captured from the code as it reads a store shaped like a Deployment's, and explained under the
 * statistics a Deployment plans from: none, `stale` and `current` (see `helpers/planner-stats.ts`). What a page of runs
 * came to is read by the page's run ids through Project-led keys: `run_reads` by its key, spores by their author, runs
 * by their key. A machine's name is read off the live credentials alone. No statement reads a table whole.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { getRunDetail, listRuns } from '@myco-server-worker/read/runs.js';
import { runReads } from '@myco-server-worker/read/run-reads.js';
import { countSpores, listSpores } from '@myco-server-worker/core/spores.js';
import { MAX_PAGE } from '@myco-server-worker/read/scope.js';
import { analyzedStore, PROFILES } from './helpers/planner-stats.js';

type Statement = { sql: string; params: unknown[] };

function emptyStore(): Database {
  const db = new Database(':memory:');
  for (const statement of SCHEMA_DDL) db.run(statement);
  return db;
}

const STORES = { unanalyzed: emptyStore(), stale: analyzedStore(PROFILES.stale), current: analyzedStore(PROFILES.current) };
afterAll(() => { for (const store of Object.values(STORES)) store.close(); });

/** A store that answers from `db` and remembers every statement, with the values bound to it, batched or not. */
function recording(db: Database): { store: RelationalStore; statements: Statement[] } {
  const inner = sqliteRelationalStore(db);
  const statements: Statement[] = [];
  const wrap = (statement: PreparedStatement, record: Statement): PreparedStatement => ({
    ...statement,
    bind: (...values: unknown[]) => { record.params = values; return wrap(statement.bind(...values), record); },
  });
  return {
    store: { prepare: (sql: string) => { const record = { sql, params: [] as unknown[] }; statements.push(record); return wrap(inner.prepare(sql), record); }, batch: (b) => inner.batch(b) },
    statements,
  };
}

const planOf = (db: Database, { sql, params }: Statement): string =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params as never[]) as Array<{ detail: string }>).map((r) => r.detail).join('\n');
/** Steps that read a table whole. The page's ids, a derived table and the live credentials' partial index are not tables. */
const tableScans = (plan: string): string[] => plan.split('\n')
  .filter((step) => /\bSCAN\b/.test(step) && !/\bSCAN (?:json_each|x\b|\(subquery|CONSTANT ROW|member_credentials USING INDEX idx_member_credentials_live_successor)/.test(step)).map((s) => s.trim());

/** Every statement a full page of runs, one run's detail, and one run's spores issue against the current store. */
let captured: Promise<Statement[]> | null = null;
const statements = (): Promise<Statement[]> => (captured ??= capture());
async function capture(): Promise<Statement[]> {
  const { store, statements: seen } = recording(STORES.current);
  const scope = { projectId: 'proj_0' };
  const page = await listRuns(store, scope, Date.now(), 'mem_1', { limit: MAX_PAGE });
  // The page holds runs with spores, with recorded reads, and with neither, so each count is read over real rows.
  expect({ full: page.rows.length, wrote: page.rows.some((r) => r.outcome.spores > 0), read: page.rows.some((r) => r.outcome.readsRecorded), unread: page.rows.some((r) => !r.outcome.readsRecorded) })
    .toEqual({ full: MAX_PAGE, wrote: true, read: true, unread: true });
  const author = STORES.current.query(`SELECT author FROM spores WHERE project_id = 'proj_0' AND author LIKE 'run_%' LIMIT 1`).get() as { author: string };
  await getRunDetail(store, scope, author.author, Date.now(), 'mem_1');
  await runReads(store, scope, author.author);
  await listSpores(store, scope, { author: author.author, limit: 50 });
  await countSpores(store, scope, { author: author.author });
  return seen;
}

describe('the run list, a run\'s detail and a run\'s spores, under the statistics a Deployment plans from', () => {
  it('reads every statement through an index, scanning no table, on every store', async () => {
    for (const [store, db] of Object.entries(STORES)) {
      for (const statement of await statements()) {
        const plan = planOf(db, statement);
        const sql = statement.sql.replace(/\s+/g, ' ').slice(0, 90);
        expect({ store, sql, scans: tableScans(plan), plan }).toEqual({ store, sql, scans: [], plan });
      }
    }
  });

  it('counts what a page of runs came to by the page\'s ids: reads by their key, spores by their author', async () => {
    const all = await statements();
    const reads = all.filter((s) => /FROM run_reads rr/.test(s.sql) && /json_each/.test(s.sql));
    const written = all.filter((s) => /SELECT author AS runId, COUNT\(\*\) AS n FROM spores/.test(s.sql) && /json_each/.test(s.sql));
    const worked = all.filter((s) => /COUNT\(DISTINCT x\.sessionId\)/.test(s.sql) && /json_each/.test(s.sql));
    expect({ reads: reads.length, written: written.length, worked: worked.length }).toEqual({ reads: 1, written: 1, worked: 1 });
    for (const [store, db] of Object.entries(STORES)) {
      expect({ store, plan: planOf(db, reads[0]!) }).toEqual({ store, plan: expect.stringMatching(/SEARCH rr USING COVERING INDEX sqlite_autoindex_run_reads_1 \(project_id=\? AND run_id=\?\)/) });
      expect({ store, plan: planOf(db, written[0]!) }).toEqual({ store, plan: expect.stringMatching(/SEARCH spores USING COVERING INDEX idx_spores_author \(project_id=\? AND author=\?\)/) });
      // The spores a run worked from are found by their author, never by walking the Project's spores by session.
      expect({ store, plan: planOf(db, worked[0]!) }).toEqual({ store, plan: expect.stringMatching(/SEARCH spores USING INDEX idx_spores_author \(project_id=\? AND author=\?\)/) });
      expect({ store, bySession: /idx_spores_session/.test(planOf(db, worked[0]!)) }).toEqual({ store, bySession: false });
      // The spores and the dispatch drive, and each session is looked up by its key after them: never a walk of the
      // Project's sessions with the spores looked up per session.
      const steps = planOf(db, worked[0]!).split('\n');
      const spores = steps.findIndex((step) => /SEARCH spores USING INDEX idx_spores_author/.test(step));
      const sessions = steps.findIndex((step) => /SEARCH s USING (?:COVERING )?INDEX sqlite_autoindex_sessions_1 \(project_id=\? AND session_id=\?\)/.test(step));
      expect({ store, spores: spores >= 0, sessionsByKey: sessions >= 0, order: sessions > spores, sessionWalk: steps.some((step) => /SEARCH s USING (?:COVERING )?INDEX \w+ \(project_id=\?\)$/.test(step.trim())) })
        .toEqual({ store, spores: true, sessionsByKey: true, order: true, sessionWalk: false });
    }
  });

  it('lists and counts one run\'s spores by the author index', async () => {
    const byAuthor = (await statements()).filter((s) => /FROM spores WHERE project_id = \? AND author = \?/.test(s.sql));
    expect(byAuthor.length).toBeGreaterThanOrEqual(2);
    for (const [store, db] of Object.entries(STORES)) {
      for (const statement of byAuthor) {
        expect({ store, plan: planOf(db, statement) }).toEqual({ store, plan: expect.stringMatching(/SEARCH spores USING (?:COVERING )?INDEX idx_spores_author \(project_id=\? AND author=\?\)/) });
      }
    }
  });

  it('binds at most the store\'s 100 values in any statement: a page\'s ids travel as one value', async () => {
    for (const statement of await statements()) expect(statement.params.length).toBeLessThanOrEqual(100);
  });
});
