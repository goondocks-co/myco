/**
 * The reads and writes of a session working now (#1531) and an actor's entries (#1537), under the statistics a
 * Deployment plans from: every statement seeks by key or through the index step 60 adds, on a store never analyzed, one
 * analyzed before the step, and one analyzed with it.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { endTurnStatement, startTurnStatement } from '@myco-server-worker/ingest/turns.js';
import { listSessions, listSessionsAcross } from '@myco-server-worker/read/sessions.js';
import { deploymentLastTaskEntryAt, deploymentTaskCeilingWindow, deploymentTaskEntriesSince, deploymentTaskRunTally, recordQueued } from '@myco-server-worker/core/runs.js';
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

const STORES = { unanalyzed: emptyStore(), stale: analyzedStore(PROFILES.stale), current: analyzedStore(PROFILES.current) };
afterAll(() => { for (const store of Object.values(STORES)) store.close(); });

const planOf = (db: Database, { sql, params }: Statement): string =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params as never[]) as Array<{ detail: string }>).map((r) => r.detail).join('\n');

async function plans(act: (db: RelationalStore) => Promise<unknown>): Promise<Array<{ store: string; sql: string; plan: string }>> {
  const { db, statements } = recordingStore();
  await act(db);
  return Object.entries(STORES).flatMap(([store, sqlite]) => statements.map((s) => ({ store, sql: s.sql.replace(/\s+/g, ' '), plan: planOf(sqlite, s) })));
}

const NOW = 1_790_000_000_000;

const scans = (plan: string): string[] => plan.split('\n').filter((step) => /\bSCAN\b/.test(step) && !/SCAN (?:CONSTANT ROW|\(subquery)/.test(step)).map((step) => step.trim());
const SESSION_KEY = 'SEARCH sessions USING INDEX sqlite_autoindex_sessions_1 (project_id=? AND session_id=?)';

describe('a session working now, under the statistics a Deployment plans from', () => {
  it('opens a turn and closes it by the session\'s key, and reads the stored event by its key', async () => {
    const opened = await plans((db) => startTurnStatement(db, { projectId: 'proj_0', sessionId: 's1', machineId: 'machine_0', at: NOW }).run());
    for (const { store, plan } of opened) expect({ store, plan }).toEqual({ store, plan: SESSION_KEY });
    const closed = await plans((db) => endTurnStatement(db, { projectId: 'proj_0', sessionId: 's1', eventId: 'e1', endedAt: NOW, nonce: 'n' }).run());
    for (const { store, plan } of closed) {
      expect({ store, plan }).toEqual({ store, plan: expect.stringContaining(SESSION_KEY) });
      expect({ store, plan }).toEqual({ store, plan: expect.stringContaining('SEARCH events USING INDEX sqlite_autoindex_events_1 (project_id=? AND event_id=?)') });
      expect({ store, scans: scans(plan) }).toEqual({ store, scans: [] });
    }
  });

  it('reads the sessions working now through the index holding open turns alone, beside the live window, in one Project and across them', async () => {
    const window = { window: 'activity' as const, since: NOW - 900_000, now: NOW, state: 'open' as const, fidelity: 'any' as const };
    const read = await plans(async (db) => {
      await listSessions(db, { projectId: 'proj_0' }, window);
      await listSessionsAcross(db, { all: true }, window);
    });
    const working = read.filter(({ sql }) => /s\.working_since IS NOT NULL/.test(sql));
    const received = read.filter(({ sql }) => !/s\.working_since IS NOT NULL/.test(sql));
    expect({ working: working.length, received: received.length }).toEqual({ working: 6, received: 6 });
    for (const { store, plan } of working) expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/^SEARCH s USING INDEX idx_sessions_working \(working_since>\?\)/) });
    for (const { store, plan } of received) expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/^SEARCH s USING INDEX idx_sessions_capture \(last_received_at>\?\)/) });
    // A read judged at no instant reads no working set.
    const unjudged = await plans((db) => listSessions(db, { projectId: 'proj_0' }, { ...window, now: undefined }));
    expect(unjudged.filter(({ sql }) => /working_since IS NOT NULL/.test(sql))).toEqual([]);
  });
});

describe('an actor\'s entries of a task (#1537), under the statistics a Deployment plans from', () => {
  it('counts, windows, dates and tallies one actor\'s entries by a seek of the actor-entry index, and so does the ceiling inside the write', async () => {
    const read = await plans(async (db) => {
      await deploymentTaskEntriesSince(db, 'extract-curate', NOW - 86_400_000, 'mem_1');
      await deploymentTaskCeilingWindow(db, 'extract-curate', NOW - 86_400_000, 'mem_1', 5);
      await deploymentLastTaskEntryAt(db, 'extract-curate', 'mem_1');
      await deploymentTaskRunTally(db, 'extract-curate', NOW - 86_400_000, 'mem_1');
      await recordQueued(db, { projectId: 'proj_0' }, { id: 'run_x', agentId: 'agent', task: 'extract-curate', provider: null, model: null, heldBy: 'worker', queuedAt: NOW, dispatchSpec: '{"actor":"mem_1"}' },
        { ceiling: { actor: 'mem_1', task: 'extract-curate', perDay: 5, sinceMs: NOW - 86_400_000 } });
    });
    expect(read.length).toBe(15);
    for (const { store, sql, plan } of read) {
      expect({ store, sql: sql.slice(0, 60), seeks: plan.includes('SEARCH agent_runs USING INDEX idx_agent_runs_actor_entry (task=? AND <expr>=?') }).toEqual({ store, sql: sql.slice(0, 60), seeks: true });
      expect({ store, sql: sql.slice(0, 60), scans: scans(plan) }).toEqual({ store, sql: sql.slice(0, 60), scans: [] });
    }
  });
});
