/**
 * The query plans behind the Today reads: the three lists across Projects, Myco's work, capture recency and Needs you.
 *
 * Each statement is captured from the code, never restated here, and explained under the statistics a Deployment's
 * store plans from: none (a store never analyzed), `stale` (analyzed while small, before step 57's indexes existed)
 * and `current` (analyzed in use, every index present). A plan that holds only on an empty store is the plan of a
 * store that never ran `ANALYZE`; the hosted store has run it.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import { encodeCursor, MAX_NAMED_PROJECTS, type ProjectSet } from '@myco-server-worker/read/scope.js';
import { listSessionsAcross, type SessionFilters } from '@myco-server-worker/read/sessions.js';
import { countSporesAcross, listSporesAcross, sporeFacets } from '@myco-server-worker/core/spores.js';
import { pagePlansAcross } from '@myco-server-worker/read/plans.js';
import { capabilityHolds, failingOutcomes, readWork, runsAwaitingWorker } from '@myco-server-worker/read/work.js';
import { captureRecency } from '@myco-server-worker/read/capture.js';
import { stoppedTranscripts } from '@myco-server-worker/ingest/parse.js';
import { grantsExpiringBy } from '@myco-server-worker/auth/grants.js';
import { analyzedStore, PROFILES } from './helpers/planner-stats.js';

type Statement = { sql: string; params: unknown[] };

/** A store that answers no rows and remembers every statement, with the values bound to it, batched or not. */
function recordingStore(): { db: RelationalStore; statements: Statement[] } {
  const statements: Statement[] = [];
  const db: RelationalStore = {
    prepare(sql: string): PreparedStatement {
      const record = { sql, params: [] as unknown[] };
      statements.push(record);
      const statement: PreparedStatement = {
        bind(...values: unknown[]) { record.params = values; return statement; },
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ results: [], meta: { changes: 0 } }),
      };
      return statement;
    },
    batch: async (batched) => batched.map(() => ({ results: [], meta: { changes: 0 } })),
  };
  return { db, statements };
}

function emptyStore(): Database {
  const db = new Database(':memory:');
  for (const statement of SCHEMA_DDL) db.run(statement);
  return db;
}

/** The three stores a plan must hold on. */
const STORES = { unanalyzed: emptyStore(), stale: analyzedStore(PROFILES.stale), current: analyzedStore(PROFILES.current) };
afterAll(() => { for (const store of Object.values(STORES)) store.close(); });

const planOf = (db: Database, { sql, params }: Statement): string =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params as never[]) as Array<{ detail: string }>).map((r) => r.detail).join('\n');

/** The statements `read` issues. */
async function captured(read: (db: RelationalStore) => Promise<unknown>): Promise<Statement[]> {
  const { db, statements } = recordingStore();
  await read(db);
  return statements;
}

/** Every statement `read` issues, explained on each store. */
async function plans(read: (db: RelationalStore) => Promise<unknown>): Promise<Array<{ store: string; sql: string; plan: string }>> {
  const statements = await captured(read);
  return Object.entries(STORES).flatMap(([store, db]) => statements.map((s) => ({ store, sql: s.sql.replace(/\s+/g, ' '), plan: planOf(db, s) })));
}

/** The statements of `read` that read `table`, never none: a filter that matched nothing would assert nothing. */
function reading<T extends { sql: string }>(read: readonly T[], table: string): T[] {
  const matched = read.filter(({ sql }) => new RegExp(`FROM ${table}\\b`).test(sql));
  expect({ table, matched: matched.length > 0 }).toEqual({ table, matched: true });
  return matched;
}

/** Steps that read a table whole: a SCAN of anything but the handful of Projects. */
const tableScans = (plan: string): string[] => plan.split('\n').filter((step) => /\bSCAN\b/.test(step) && !/\bprojects\b/.test(step)).map((s) => s.trim());
const sortsRows = (plan: string): boolean => /TEMP B-TREE FOR (?:RIGHT PART OF |LAST TERM OF )?ORDER BY/.test(plan);

const ALL: ProjectSet = { all: true };
const NAMED: ProjectSet = { all: false, projectIds: ['proj_0', 'proj_1'] };
const CURSOR = encodeCursor(1_789_000_000_000, 'k');

const SESSION_SHAPES: Record<string, SessionFilters & { cursor?: string }> = {
  plain: {}, cursor: { cursor: CURSOR }, since: { since: 1_789_000_000_000 }, agent: { agent: 'codex' }, branch: { branch: 'main' },
  member: { memberLabel: 'member 1' }, open: { state: 'open' }, ended: { state: 'ended' }, text: { q: 'fix' },
};

describe('the Today reads under the statistics a Deployment plans from', () => {
  it('pages sessions across Projects down the Deployment-wide index, every filter shape and store alike, with no sort', async () => {
    for (const set of [ALL, NAMED]) {
      for (const [shape, opts] of Object.entries(SESSION_SHAPES)) {
        for (const { store, plan } of await plans((db) => listSessionsAcross(db, set, { limit: 50, fidelity: 'any', ...opts }))) {
          expect({ set: set.all, shape, store, walks: /\bs USING (?:COVERING )?INDEX idx_sessions_occurred_deployment\b/.test(plan), sorts: sortsRows(plan), scans: tableScans(plan).filter((s) => !/idx_sessions_occurred_deployment/.test(s)), plan })
            .toEqual({ set: set.all, shape, store, walks: true, sorts: false, scans: [], plan });
        }
      }
    }
    // A cursor or a start seeks the walk: it never reads from the newest session on.
    for (const opts of [{ cursor: CURSOR }, { since: 1_789_000_000_000 }]) {
      for (const { store, plan } of await plans((db) => listSessionsAcross(db, ALL, { limit: 50, fidelity: 'any', ...opts }))) {
        expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/SEARCH s USING INDEX idx_sessions_occurred_deployment \(<expr>[<>]\?\)/) });
      }
    }
  });

  it('pages spores and plans across Projects down their Deployment-wide indexes, with no sort', async () => {
    for (const set of [ALL, NAMED]) {
      const spores = await plans(async (db) => {
        await listSporesAcross(db, set, { limit: 50 });
        await listSporesAcross(db, set, { observationType: 'gotcha', status: 'active', limit: 50, offset: 50 });
        await listSporesAcross(db, set, { createdFrom: 1_789_000_000_000, search: 'x', limit: 50 });
      });
      for (const { store, sql, plan } of spores) {
        expect({ set: set.all, store, sql, walks: /USING INDEX idx_spores_created_deployment/.test(plan), sorts: sortsRows(plan), plan })
          .toEqual({ set: set.all, store, sql, walks: true, sorts: false, plan });
      }
      const listed = await plans(async (db) => {
        await pagePlansAcross(db, set, { limit: 50 });
        await pagePlansAcross(db, set, { status: 'active', since: 1, limit: 50, cursor: CURSOR });
      });
      for (const { store, sql, plan } of reading(listed, 'plans')) {
        expect({ set: set.all, store, sql, walks: /plans USING INDEX idx_plans_updated_deployment/.test(plan), sorts: sortsRows(plan), plan })
          .toEqual({ set: set.all, store, sql, walks: true, sorts: false, plan });
      }
    }
  });

  it('counts spores for the total and the facets through Project-led indexes, and scans only to match text across every Project', async () => {
    for (const set of [ALL, NAMED]) {
      for (const { store, sql, plan } of await plans(async (db) => { await countSporesAcross(db, set, { status: 'active' }); await sporeFacets(db, set, { observationType: 'gotcha' }); })) {
        expect({ set: set.all, store, sql, scans: tableScans(plan), plan }).toEqual({ set: set.all, store, sql, scans: [], plan });
      }
    }
    // A total or a facet with a text filter reads the content of every spore it counts. Across named Projects that is
    // their spores; across every Project it is every spore, whichever way the planner reaches them, and it never
    // sorts them.
    for (const { store, sql, plan } of await plans(async (db) => { await countSporesAcross(db, NAMED, { search: 'x' }); await sporeFacets(db, NAMED, { search: 'x' }); })) {
      expect({ store, sql, scans: tableScans(plan), plan }).toEqual({ store, sql, scans: [], plan });
    }
    for (const { store, sql, plan } of await plans(async (db) => { await countSporesAcross(db, ALL, { search: 'x' }); await sporeFacets(db, ALL, { search: 'x' }); })) {
      expect({ store, sql, sorts: sortsRows(plan), plan }).toEqual({ store, sql, sorts: false, plan });
    }
  });

  it('reads Myco\'s work through the runs-by-task index and finds what a run wrote by its author, scanning nothing', async () => {
    const read = await plans((db) => readWork(db, ALL, 1_789_000_000_000, 1_790_000_000_000));
    expect(read).toHaveLength(6 * 3);
    for (const { store, sql, plan } of read) expect({ store, sql, scans: tableScans(plan), plan }).toEqual({ store, sql, scans: [], plan });
    const byRuns = read.filter(({ plan }) => /\br USING/.test(plan));
    expect(byRuns.length).toBeGreaterThanOrEqual(4 * 3);
    for (const { store, sql, plan } of byRuns) {
      expect({ store, sql, byTask: /\br USING (?:COVERING )?INDEX idx_agent_runs_task/.test(plan), plan }).toEqual({ store, sql, byTask: true, plan });
    }
    const authored = read.filter(({ plan }) => /\bsp\b/.test(plan));
    expect(authored.length).toBeGreaterThanOrEqual(9);
    for (const { store, sql, plan } of authored) {
      expect({ store, sql, author: /SEARCH sp USING (?:COVERING )?INDEX idx_spores_author \(project_id=\? AND author=\?\)/.test(plan), plan })
        .toEqual({ store, sql, author: true, plan });
    }
  });

  it('reads capture recency over the window alone, from the capture index and no session row', async () => {
    const read = await plans((db) => captureRecency(db, 1_790_000_000_000));
    for (const { store, plan } of reading(read, 'sessions')) {
      expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/SEARCH sessions USING COVERING INDEX idx_sessions_capture \(last_received_at>\?\)/) });
    }
    // Machine names come from live credentials alone, read off the partial index that holds only them.
    for (const { store, plan } of reading(read, 'member_credentials')) {
      expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/member_credentials USING INDEX idx_member_credentials_live_successor/) });
    }
  });

  it('reads what Needs you composes through existing indexes, scanning only the parse backlog', async () => {
    const read = await plans(async (db) => {
      await failingOutcomes(db, ['extract-curate', 'canopy-map'], 0);
      await capabilityHolds(db, ['repository-checkout'], 0);
      await runsAwaitingWorker(db, ['embedding-reconcile']);
      await stoppedTranscripts(db);
      await grantsExpiringBy(db, 0, 1);
    });
    expect(read).toHaveLength(5 * 3);
    // Every stopped transcript still has bytes past its cursor, so the read walks the backlog's partial index and never
    // the transcripts already read.
    for (const { store, plan } of reading(read, 'transcripts')) {
      expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/SCAN transcripts USING INDEX idx_transcripts_backlog/) });
    }
    for (const { store, sql, plan } of read.filter(({ sql }) => !/FROM transcripts\b/.test(sql))) {
      expect({ store, sql, scans: tableScans(plan), plan }).toEqual({ store, sql, scans: [], plan });
    }
  });

  it('needs the index named in the session and plan lists: under stale statistics the planner reads every row and sorts without it', async () => {
    const unnamed = (s: Statement): Statement => ({ ...s, sql: s.sql.replace(/ INDEXED BY \w+/g, '') });
    const [sessions] = await captured((db) => listSessionsAcross(db, ALL, { limit: 50, agent: 'codex', fidelity: 'any' }));
    const [plansPage] = await captured((db) => pagePlansAcross(db, ALL, { limit: 50 }));
    for (const s of [sessions!, plansPage!]) {
      expect(s.sql).toMatch(/ INDEXED BY /);
      expect(sortsRows(planOf(STORES.stale, unnamed(s)))).toBe(true);
    }
  });

  it('binds at most the store\'s 100 values in any statement, with the most Projects a read may name and every filter it takes', async () => {
    const most: ProjectSet = { all: false, projectIds: Array.from({ length: MAX_NAMED_PROJECTS }, (_, i) => `proj_${i}`) };
    const statements = await captured(async (db) => {
      await listSessionsAcross(db, most, { limit: 50, cursor: CURSOR, since: 1, branch: 'b', agent: 'a', memberLabel: 'm', sessionId: 's', q: 'q', state: 'open', fidelity: 'full' });
      await listSporesAcross(db, most, { observationType: 't', status: 's', sessionId: 's', search: 'q', createdFrom: 1, limit: 50, offset: 50 });
      await countSporesAcross(db, most, { observationType: 't', status: 's', sessionId: 's', search: 'q', createdFrom: 1 });
      await sporeFacets(db, most, { observationType: 't', status: 's', sessionId: 's', search: 'q', createdFrom: 1 });
      await pagePlansAcross(db, most, { status: 'active', since: 1, limit: 50, cursor: CURSOR });
      await readWork(db, most, 0, 1);
    });
    expect(statements.length).toBeGreaterThanOrEqual(11);
    const over = statements.filter((s) => s.params.length > 100).map((s) => `${s.params.length}: ${s.sql.replace(/\s+/g, ' ').slice(0, 60)}`);
    expect(over).toEqual([]);
    expect(Math.max(...statements.map((s) => s.params.length))).toBeGreaterThan(MAX_NAMED_PROJECTS);
  });
});
