/**
 * The query plans behind the Today reads: the three lists across Projects, Myco's work, capture recency and Needs you.
 *
 * Each statement is captured from the code, never restated here, and explained against a migrated empty store: a plan
 * is a property of the schema, not of the rows. Every index step 57 adds is shown in use by the read it exists for,
 * and no read scans a table that grows with capture.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import { encodeCursor, MAX_NAMED_PROJECTS, type ProjectSet } from '@myco-server-worker/read/scope.js';
import { listSessionsAcross } from '@myco-server-worker/read/sessions.js';
import { countSporesAcross, listSporesAcross, sporeFacets } from '@myco-server-worker/core/spores.js';
import { pagePlansAcross } from '@myco-server-worker/read/plans.js';
import { capabilityHolds, failingOutcomes, readWork, runsAwaitingWorker } from '@myco-server-worker/read/work.js';
import { captureRecency } from '@myco-server-worker/read/capture.js';
import { stoppedTranscripts } from '@myco-server-worker/ingest/parse.js';
import { grantsExpiringBy } from '@myco-server-worker/auth/grants.js';

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

/** The store to plan against, every step applied, or all but the named indexes. */
function migrated(without: readonly string[] = []): Database {
  const db = new Database(':memory:');
  for (const statement of SCHEMA_DDL) db.run(statement);
  for (const name of without) db.run(`DROP INDEX ${name}`);
  return db;
}

const planOf = (db: Database, { sql, params }: Statement): string =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params as never[]) as Array<{ detail: string }>).map((r) => r.detail).join('\n');

/** Every statement `read` issues, explained. */
async function plans(read: (db: RelationalStore) => Promise<unknown>, without: readonly string[] = []): Promise<Array<{ sql: string; plan: string }>> {
  const { db, statements } = recordingStore();
  await read(db);
  const store = migrated(without);
  try {
    return statements.map((s) => ({ sql: s.sql.replace(/\s+/g, ' ').slice(0, 80), plan: planOf(store, s) }));
  } finally {
    store.close();
  }
}

/** The tables a plan scans whole: a SCAN step with no index, or through an index it reads from end to end without a bound. */
const unboundedScans = (plan: string): string[] => plan.split('\n').filter((step) => /\bSCAN\b/.test(step) && !/\bprojects\b/.test(step)).map((s) => s.trim());

const ALL: ProjectSet = { all: true };
const NAMED: ProjectSet = { all: false, projectIds: ['proj_1', 'proj_2'] };

describe('the Today reads', () => {
  it('pages every Project\'s sessions newest first down the Deployment-wide index, with no sort step, first page, since and cursor alike', async () => {
    for (const opts of [{ limit: 50 }, { limit: 50, since: 1 }, { limit: 50, cursor: encodeCursor(1_700_000_000_000, 's') }]) {
      const [page] = await plans((db) => listSessionsAcross(db, ALL, { ...opts, fidelity: 'any' }));
      expect({ opts, index: /USING (?:COVERING )?INDEX idx_sessions_occurred_deployment/.test(page!.plan), sorted: /TEMP B-TREE/.test(page!.plan), plan: page!.plan })
        .toEqual({ opts, index: true, sorted: false, plan: page!.plan });
    }
    // A cursor or a start bounds the walk: the index is sought to it, never read from the newest session on.
    for (const opts of [{ limit: 50, since: 1 }, { limit: 50, cursor: encodeCursor(1_700_000_000_000, 's') }]) {
      const [page] = await plans((db) => listSessionsAcross(db, ALL, { ...opts, fidelity: 'any' }));
      expect(page!.plan).toMatch(/SEARCH s USING INDEX idx_sessions_occurred_deployment \(<expr>[<>]\?\)/);
    }
    // Without the index the same read sorts every session the Deployment holds.
    const [bare] = await plans((db) => listSessionsAcross(db, ALL, { limit: 50, fidelity: 'any' }), ['idx_sessions_occurred_deployment']);
    expect(bare!.plan).toMatch(/TEMP B-TREE/);
  });

  it('reads named Projects\' sessions through each Project\'s own index', async () => {
    const [page] = await plans((db) => listSessionsAcross(db, NAMED, { limit: 50, since: 1, fidelity: 'any' }));
    expect({ scans: unboundedScans(page!.plan), plan: page!.plan }).toEqual({ scans: [], plan: page!.plan });
    expect(page!.plan).toMatch(/idx_sessions_occurred \(project_id=\?/);
  });

  it('reads spores and plans across Projects through their Project-led indexes, and scans neither', async () => {
    for (const set of [ALL, NAMED]) {
      const read = await plans(async (db) => {
        await listSporesAcross(db, set, { observationType: 'gotcha', limit: 50 });
        await listSporesAcross(db, set, { limit: 50 });
        await countSporesAcross(db, set, {});
        await sporeFacets(db, set, { search: 'x' });
        await pagePlansAcross(db, set, { limit: 50, since: 1 });
      });
      expect(read.length).toBeGreaterThanOrEqual(5);
      for (const { sql, plan } of read) expect({ set, sql, scans: unboundedScans(plan), plan }).toEqual({ set, sql, scans: [], plan });
    }
  });

  it('counts what a run wrote through the spores-by-author index, in every statement of Myco\'s work', async () => {
    const read = await plans((db) => readWork(db, ALL, 0, 1));
    expect(read).toHaveLength(6);
    for (const { sql, plan } of read) expect({ sql, scans: unboundedScans(plan), plan }).toEqual({ sql, scans: [], plan });
    const authored = read.filter(({ plan }) => /\bsp\b/.test(plan));
    expect(authored.length).toBeGreaterThanOrEqual(3);
    for (const { sql, plan } of authored) {
      expect({ sql, author: /SEARCH sp USING (?:COVERING )?INDEX idx_spores_author \(project_id=\? AND author=\?\)/.test(plan), plan })
        .toEqual({ sql, author: true, plan });
    }
    // Without it, the spores a run wrote are found by reading every spore of its Project.
    const bare = await plans((db) => readWork(db, ALL, 0, 1), ['idx_spores_author']);
    expect(bare.some(({ plan }) => /SEARCH sp USING (?:COVERING )?INDEX idx_spores_author/.test(plan))).toBe(false);
  });

  it('reads capture recency over the window alone, from the capture index and no session row', async () => {
    const [recent] = await plans((db) => captureRecency(db, 1_700_000_000_000));
    expect(recent!.plan).toMatch(/SEARCH sessions USING COVERING INDEX idx_sessions_capture \(last_received_at>\?\)/);
    const [bare] = await plans((db) => captureRecency(db, 1_700_000_000_000), ['idx_sessions_capture']);
    expect(bare!.plan).toMatch(/SCAN sessions/);
  });

  it('binds at most the store\'s 100 values in any statement, with the most Projects a read may name and every filter it takes', async () => {
    const most: ProjectSet = { all: false, projectIds: Array.from({ length: MAX_NAMED_PROJECTS }, (_, i) => `proj_${i}`) };
    const { db, statements } = recordingStore();
    const cursor = encodeCursor(1_700_000_000_000, 'k');
    await listSessionsAcross(db, most, { limit: 50, cursor, since: 1, branch: 'b', agent: 'a', memberLabel: 'm', sessionId: 's', q: 'q', state: 'open', fidelity: 'full' });
    await listSporesAcross(db, most, { observationType: 't', status: 's', sessionId: 's', search: 'q', createdFrom: 1, limit: 50, offset: 50 });
    await countSporesAcross(db, most, { observationType: 't', status: 's', sessionId: 's', search: 'q', createdFrom: 1 });
    await sporeFacets(db, most, { observationType: 't', status: 's', sessionId: 's', search: 'q', createdFrom: 1 });
    await pagePlansAcross(db, most, { status: 'active', since: 1, limit: 50, cursor });
    await readWork(db, most, 0, 1);
    expect(statements.length).toBeGreaterThanOrEqual(11);
    const over = statements.filter((s) => s.params.length > 100).map((s) => `${s.params.length}: ${s.sql.replace(/\s+/g, ' ').slice(0, 60)}`);
    expect(over).toEqual([]);
    expect(Math.max(...statements.map((s) => s.params.length))).toBeGreaterThan(MAX_NAMED_PROJECTS);
  });

  it('reads what Needs you composes through existing indexes, scanning nothing that grows with capture', async () => {
    const read = await plans(async (db) => {
      await failingOutcomes(db, ['extract-curate', 'canopy-map'], 0);
      await capabilityHolds(db, ['repository.checkout'], 0);
      await runsAwaitingWorker(db, ['embedding-reconcile']);
      await stoppedTranscripts(db);
      await grantsExpiringBy(db, 0, 1);
    });
    expect(read).toHaveLength(5);
    // Stopped transcripts are read off the parse backlog's partial index: every stopped transcript still has bytes
    // past its cursor, so the read walks the backlog and never the transcripts already read.
    const stopped = read.find(({ sql }) => /FROM transcripts/.test(sql))!;
    expect(stopped.plan).toMatch(/SCAN transcripts USING INDEX idx_transcripts_backlog/);
    for (const { sql, plan } of read.filter((r) => r !== stopped)) expect({ sql, scans: unboundedScans(plan), plan }).toEqual({ sql, scans: [], plan });
  });
});
