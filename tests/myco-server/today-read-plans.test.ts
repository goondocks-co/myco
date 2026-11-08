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
import { listSessions, listSessionsAcross, type SessionFilters } from '@myco-server-worker/read/sessions.js';
import { listSporePageAcross } from '@myco-server-worker/core/spores.js';
import { encodeProjectCursor } from '@myco-server-worker/read/project-cursor.js';
import { pagePlansAcross, planTotals } from '@myco-server-worker/read/plans.js';
import { capabilityHolds, failingOutcomes, readWork, runsAwaitingWorker } from '@myco-server-worker/read/work.js';
import { captureRecency } from '@myco-server-worker/read/capture.js';
import { listMachines, machinesOf } from '@myco-server-worker/read/machines.js';
import { renameMachine } from '@myco-server-worker/auth/enrollment.js';
import { ownMachineNames } from '@myco-server-worker/read/capture.js';
import { grantsExpiringBy } from '@myco-server-worker/auth/grants.js';
import { analyzedStore, PROFILES } from './helpers/planner-stats.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { createProject } from '@myco-server-worker/read/sessions.js';

type Statement = { sql: string; params: unknown[] };

/** A store that answers no rows and remembers every statement, with the values bound to it, batched or not. */
function recordingStore(machineClaim = false): { db: RelationalStore; statements: Statement[] } {
  const statements: Statement[] = [];
  const db: RelationalStore = {
    prepare(sql: string): PreparedStatement {
      const record = { sql, params: [] as unknown[] };
      statements.push(record);
      const statement: PreparedStatement = {
        bind(...values: unknown[]) { record.params = values; return statement; },
        first: async () => null,
        all: async <T = Record<string, unknown>>() => ({ results: (machineClaim && /FROM machine_claims mc\b/.test(sql)
          ? [{ machine_id: 'm_1', member_id: 'mem_1', claimed_at: 1, label: null, member_label: null, member_revoked_at: null }] : []) as T[] }),
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

type PlanRow={id:number;parent:number;detail:string};
const planOf = (db: Database, {sql,params}: Statement): PlanRow[] => db.query('EXPLAIN QUERY PLAN '+sql).all(...params as never[]) as PlanRow[];
const planText=(db:Database,statement:Statement):string=>planOf(db,statement).map(row=>row.detail).join('\n');

/** The statements `read` issues. */
async function captured(read: (db: RelationalStore) => Promise<unknown>, machineClaim = false): Promise<Statement[]> {
  const { db, statements } = recordingStore(machineClaim);
  await read(db);
  return statements;
}

/** Every statement `read` issues, explained on each store. */
async function plans(read: (db: RelationalStore) => Promise<unknown>, machineClaim = false): Promise<Array<{ store: string; sql: string; plan: string }>> {
  const statements = await captured(read, machineClaim);
  return Object.entries(STORES).flatMap(([store, db]) => statements.map((s) => ({ store, sql: s.sql.replace(/\s+/g, ' '), plan: planText(db, s) })));
}

/** The statements of `read` that read `table`, never none: a filter that matched nothing would assert nothing. */
function reading<T extends { sql: string }>(read: readonly T[], table: string): T[] {
  const matched = read.filter(({ sql }) => new RegExp(`FROM ${table}\\b`).test(sql));
  expect({ table, matched: matched.length > 0 }).toEqual({ table, matched: true });
  return matched;
}

/** Steps that read a table whole: a SCAN of anything but the handful of Projects, by name or by the `p` a Project filter reads it as. */
const tableScans = (plan: string): string[] => plan.split('\n').filter((step) => /\bSCAN\b/.test(step) && !/\bSCAN (?:projects|p)\b/.test(step)).map((s) => s.trim());
const CAPTURE_HEAD_POINT_READ = /(?:SCAN h\b|SEARCH h USING PRIMARY KEY \(machine_id=\?\))[\s\S]*SEARCH s USING INDEX sqlite_autoindex_sessions_1 \(project_id=\? AND session_id=\?\)/;

const sortsRows = (plan: string): boolean => /TEMP B-TREE FOR (?:RIGHT PART OF |LAST TERM OF )?ORDER BY/.test(plan);

const ALL: ProjectSet = { all: true };
const NAMED: ProjectSet = { all: false, projectIds: ['proj_0', 'proj_1'] };
const CURSOR = encodeCursor(1_789_000_000_000, 'k');

const SESSION_SHAPES: Record<string, SessionFilters & { cursor?: string }> = {
  plain: {}, cursor: { cursor: CURSOR }, since: { since: 1_789_000_000_000 }, until: { until: 1_789_500_000_000 },
  window: { since: 1_789_000_000_000, until: 1_789_086_400_000 }, agent: { agent: 'codex' }, branch: { branch: 'main' },
  member: { memberLabel: 'member 1' }, open: { state: 'open' }, ended: { state: 'ended' },
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
    // A cursor, a start or an end seeks the walk: it never reads from the newest session on, and a window is one range.
    for (const opts of [{ cursor: CURSOR }, { since: 1_789_000_000_000 }, { until: 1_789_500_000_000 }]) {
      for (const { store, plan } of await plans((db) => listSessionsAcross(db, ALL, { limit: 50, fidelity: 'any', ...opts }))) {
        expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/SEARCH s USING INDEX idx_sessions_occurred_deployment \(<expr>[<>]\?\)/) });
      }
    }
    for (const { store, plan } of await plans((db) => listSessionsAcross(db, ALL, { limit: 50, fidelity: 'any', since: 1_789_000_000_000, until: 1_789_086_400_000 }))) {
      expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/SEARCH s USING INDEX idx_sessions_occurred_deployment \(<expr>>\? AND <expr><\?\)/) });
    }
  });

  it('reads an activity window as one range of the capture index, across Projects and within one, scanning nothing', async () => {
    // The window seeks the sessions received from its start on, however long ago they started, and sorts that set alone.
    const shapes: Record<string, SessionFilters & { cursor?: string }> = {
      since: { since: 1_789_000_000_000 }, window: { since: 1_789_000_000_000, until: 1_789_086_400_000 },
      cursor: { since: 1_789_000_000_000, cursor: CURSOR }, agent: { since: 1_789_000_000_000, agent: 'codex' },
      open: { since: 1_789_000_000_000, state: 'open' },
    };
    const reads: Record<string, (db: RelationalStore, opts: SessionFilters & { cursor?: string }) => Promise<unknown>> = {
      all: (db, opts) => listSessionsAcross(db, ALL, { limit: 50, fidelity: 'any', window: 'activity', ...opts }),
      named: (db, opts) => listSessionsAcross(db, NAMED, { limit: 50, fidelity: 'any', window: 'activity', ...opts }),
      project: (db, opts) => listSessions(db, { projectId: 'proj_0' }, { limit: 50, fidelity: 'any', window: 'activity', ...opts }),
    };
    for (const [reach, read] of Object.entries(reads)) {
      for (const [shape, opts] of Object.entries(shapes)) {
        for (const { store, sql, plan } of await plans((db) => read(db, opts))) {
          expect({ reach, shape, store, sql, sql_names: / INDEXED BY idx_sessions_capture /.test(sql), seeks: /SEARCH s USING INDEX idx_sessions_capture \(last_received_at>\?\)/.test(plan), scans: tableScans(plan), plan })
            .toEqual({ reach, shape, store, sql, sql_names: true, seeks: true, scans: [], plan });
        }
      }
    }
  });

  it('reads one Project\'s sessions in a window as one range of the Project\'s ordered index, with no sort', async () => {
    for (const opts of [{ since: 1_789_000_000_000 }, { until: 1_789_500_000_000 }, { since: 1_789_000_000_000, until: 1_789_086_400_000 }]) {
      for (const { store, plan } of await plans((db) => listSessions(db, { projectId: 'proj_0' }, { limit: 50, fidelity: 'any', ...opts }))) {
        expect({ store, opts, walks: /\bs USING INDEX idx_sessions_occurred \(project_id=\? AND <expr>[<>]\?(?: AND <expr><\?)?\)/.test(plan), sorts: sortsRows(plan), plan })
          .toEqual({ store, opts, walks: true, sorts: false, plan });
      }
    }
  });

  it('pages plans across Projects down their Deployment-wide index, with no sort', async () => {
    for (const set of [ALL, NAMED]) {
      const listed = await plans(async (db) => {
        await pagePlansAcross(db, set, { limit: 50 });
        await pagePlansAcross(db, set, { status: 'active', since: 1, limit: 50, cursor: CURSOR });
        await pagePlansAcross(db, set, { status: 'active', limit: 50, cursor: CURSOR });
      });
      for (const { store, sql, plan } of reading(listed, 'plans')) {
        expect({ set: set.all, store, sql, walks: /plans USING INDEX idx_plans_updated_deployment/.test(plan), sorts: sortsRows(plan), plan })
          .toEqual({ set: set.all, store, sql, walks: true, sorts: false, plan });
      }
    }
  });

  it('hydrates canonical receipt-minute heads through session primary keys', async () => {
    const read = await plans((db) => captureRecency(db, 1_790_000_000_000, 'mem_1'));
    for (const { store, plan } of reading(read, 'machine_capture_heads')) {
      expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(CAPTURE_HEAD_POINT_READ) });
    }
    // Machine names come from live credentials alone, read off the partial index that holds only them.
    for (const { store, plan } of reading(read, 'member_credentials')) {
      expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/member_credentials USING INDEX idx_member_credentials_live_successor/) });
    }
  });

  it('reads the machines from their claims and the worker reports, seeking every run, session and credential, every store alike', async () => {
    for (const scope of [{ all: true as const }, { all: false as const, memberId: 'mem_1' }]) {
      const read = await plans((db) => listMachines(db, 1_790_000_000_000, scope), true);
      for (const { store, sql, plan } of read) {
        const walks = /^SCAN (?:mc(?: USING INDEX idx_machine_claims_claimed)?|machine_claims|w USING INDEX idx_worker_contacts_seen|json_each VIRTUAL TABLE INDEX 1:)$/;
        const boundedWindow = sql.includes('ROW_NUMBER() OVER (PARTITION BY c.machine_id, c.lineage_root');
        const allowed = (step: string) => walks.test(step) || (sql.includes('AS last_event_at') && /^SCAN h$/.test(step)) || (boundedWindow && /^SCAN (?:c|\(subquery-\d+\))$/.test(step));
        expect({ store, sql, scans: tableScans(plan) }).toEqual({ store, sql, scans: tableScans(plan).filter(allowed) });
      }
      for (const { store, plan } of reading(read, 'machine_capture_heads')) {
        expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(CAPTURE_HEAD_POINT_READ) });
      }
      for (const { store, plan } of reading(read, 'member_credentials')) {
        expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/SEARCH c USING INDEX idx_member_credentials_machine \(machine_id=\?\)/) });
      }
      const summary = read.find(({ sql }) => sql.includes('AS credential_count'));
      expect(summary?.sql).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY c\.machine_id, c\.lineage_root ORDER BY c\.issued_at DESC, c\.id DESC\)/);
      expect(summary?.sql).not.toContain('INDEXED BY idx_member_credentials_lineage');
      expect(summary?.plan).not.toContain('idx_member_credentials_lineage');
      for (const { store, plan } of reading(read, 'worker_contacts')) {
        expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/SEARCH c USING INDEX sqlite_autoindex_member_credentials_1 \(id=\?\)[\s\S]*SEARCH r USING (?:COVERING )?INDEX idx_agent_runs_worker_started \(leased_by=\?\)/) });
      }
    }
    const own = await plans((db) => machinesOf(db, 'mem_1'));
    for (const { store, plan } of reading(own, 'machine_claims')) expect({ store, plan }).toEqual({ store, plan: 'SEARCH machine_claims USING INDEX idx_machine_claims_member (member_id=?)' });
  });

  it('renames a machine in one write to its claim, sought by key', async () => {
    const rename = await plans(async (db) => { await renameMachine(db, { memberId: 'mem_1' }, 'm_1', 'x'); });
    expect(rename.length).toBe(3);
    for (const { plan } of rename) {
      expect(plan).toContain('SEARCH machine_claims USING INDEX sqlite_autoindex_machine_claims_1 (machine_id=?)');
      expect(plan).toContain('SEARCH write_actor USING INDEX sqlite_autoindex_members_1 (id=?)');
      expect(plan).toContain('SEARCH o USING INTEGER PRIMARY KEY (rowid=?)');
      expect(plan).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/);
    }
  });

  it('names a viewer\'s own machines from the viewer\'s claims and live credentials alone, by member', async () => {
    const read = await plans((db) => ownMachineNames(db, 'mem_1', 1_790_000_000_000));
    for (const { store, plan } of reading(read, 'machine_claims')) {
      expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/SEARCH mc USING INDEX idx_machine_claims_member \(member_id=\?\)/) });
    }
    for (const { store, plan } of reading(read, 'member_credentials')) {
      expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/SEARCH c USING INDEX idx_member_credentials_machine \(machine_id=\?\)/) });
    }
  });

  it('reads Needs you run and grant inputs through existing indexes', async () => {
    const read = await plans(async (db) => {
      await failingOutcomes(db, ['extract-curate', 'canopy-map'], 0);
      await capabilityHolds(db, ['repository-checkout'], 0);
      await runsAwaitingWorker(db, ['embedding-reconcile']);
      await grantsExpiringBy(db, 0, 1);
    });
    expect(read).toHaveLength(4 * 3);
    for (const { store, sql, plan } of read) {
      const scans=tableScans(plan).filter(scan=>!scan.startsWith('SCAN json_each'));
      expect({ store, sql, scans, plan }).toEqual({ store, sql, scans: [], plan });
    }
  });

  it('needs the capture index named for an activity window: unnamed, the planner walks every session by its start', async () => {
    const unnamed = (st: Statement): Statement => ({ ...st, sql: st.sql.replace(/ INDEXED BY \w+/g, '') });
    const [across] = await captured((db) => listSessionsAcross(db, ALL, { limit: 50, fidelity: 'any', window: 'activity', since: 1_789_000_000_000, agent: 'codex' }));
    const [one] = await captured((db) => listSessions(db, { projectId: 'proj_0' }, { limit: 50, fidelity: 'any', window: 'activity', since: 1_789_000_000_000 }));
    expect(planText(STORES.current, unnamed(across!))).toMatch(/SCAN s USING INDEX idx_sessions_occurred_deployment/);
    expect(planText(STORES.current, unnamed(one!))).toMatch(/SEARCH s USING INDEX idx_sessions_occurred \(project_id=\?\)\n/);
  });

  it('needs the index named in the session and plan lists: under stale statistics the planner reads every row and sorts without it', async () => {
    const unnamed = (s: Statement): Statement => ({ ...s, sql: s.sql.replace(/ INDEXED BY \w+/g, '') });
    const [sessions] = await captured((db) => listSessionsAcross(db, ALL, { limit: 50, agent: 'codex', fidelity: 'any' }));
    const [plansPage] = await captured((db) => pagePlansAcross(db, ALL, { limit: 50 }));
    for (const s of [sessions!, plansPage!]) {
      expect(s.sql).toMatch(/ INDEXED BY /);
      expect(sortsRows(planText(STORES.stale, unnamed(s)))).toBe(true);
    }
  });

  it('answers every across-Projects read naming the most Projects a read may and every filter it takes, on both stores', async () => {
    const most: ProjectSet = { all: false, projectIds: Array.from({ length: MAX_NAMED_PROJECTS }, (_, i) => `proj_${i}`) };
    await withDocumentStores(async (db, target) => {
      for (const projectId of most.projectIds) await createProject(db, projectId, projectId, 1);
      await db.prepare("INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('a', 'a', 'built-in', 1, 0)").run();
      await db.prepare(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) VALUES ('proj_63', 'sp_last', 'a', 't', 's', 'x', 10)`).run();
      const reads = await Promise.all([
        listSessionsAcross(db, most, { limit: 50, cursor: CURSOR, since: 1, until: 2, branch: 'b', agent: 'a', memberLabel: 'm', sessionId: 's', state: 'open', fidelity: 'full' }),
        listSessionsAcross(db, most, { limit: 50, cursor: CURSOR, since: 1, until: 2, window: 'activity', branch: 'b', agent: 'a', memberLabel: 'm', sessionId: 's', state: 'open', fidelity: 'full' }),
        listSporePageAcross(db, most, { observationType: 't', status: 's', sessionId: 's', createdFrom: 1, createdTo: 2, limit: 50, cursor: encodeProjectCursor({ createdAt: 1, projectId: 'proj_0', id: 'k' }) }),
        listSporePageAcross(db, most, { observationType: 't', status: 's', createdFrom: 0, createdTo: 86_400_000, limit: 50 }),
        pagePlansAcross(db, most, { status: 'active', since: 1, limit: 50, cursor: CURSOR }),
        planTotals(db, most),
        readWork(db, most, 0, 86_400_000, undefined, 1),
      ]);
      const spores = reads[3] as Awaited<ReturnType<typeof listSporePageAcross>>;
      expect({ target, ids: spores?.rows.map((row) => row.id), total: spores?.total, facets: spores?.facets?.project })
        .toEqual({ target, ids: ['sp_last'], total: 1, facets: { proj_63: 1 } });
      expect({ target, plans: reads[5] }).toEqual({ target, plans: { state: 'ready', value: {} } });
    });
  });
});
