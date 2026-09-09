/**
 * The query plans behind the reads a person waits on.
 *
 * A read regression is invisible to every other kind of test: the rows are
 * right, the assertions pass, and the only symptom is that a page takes
 * milliseconds instead of microseconds on a store nobody has locally. The
 * session list is the one that matters most — it is the first thing a dashboard
 * asks for, it is a keyset page, and its ordering expression and its index have
 * to move together or the index stops applying and the sort silently becomes a
 * temp b-tree.
 *
 * **The statement is captured from the code, never restated here.** A copy of
 * the SQL in a test file is a second source that drifts, and a plan asserted
 * over a copy proves the copy is fast. `listSessions` is driven against a store
 * that records what it prepares and answers nothing, so what is explained is
 * the statement the read layer actually issues.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import { encodeCursor } from '@myco-server-worker/read/scope.js';
import { listSessions } from '@myco-server-worker/read/sessions.js';
import { heldTranscriptsFor } from '@myco-server-worker/read/transcript.js';

/** A store that answers no rows and remembers every statement, with the values bound to it. */
function recordingStore(): { db: RelationalStore; statements: Array<{ sql: string; params: unknown[] }> } {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db: RelationalStore = {
    prepare(sql: string): PreparedStatement {
      const record = { sql, params: [] as unknown[] };
      statements.push(record);
      const statement: PreparedStatement = {
        bind(...values: unknown[]) { record.params = values; return statement; },
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, meta: { changes: 0 } }) as never,
      };
      return statement;
    },
    batch: async () => [],
  };
  return { db, statements };
}

/** A migrated, empty store to plan against. A plan is a property of the schema, not of the rows. */
function migrated(): Database {
  const db = new Database(':memory:');
  for (const statement of SCHEMA_DDL) db.run(statement);
  return db;
}

const planOf = (db: Database, sql: string, params: readonly unknown[]): string =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params as never[]) as Array<{ detail: string }>).map((r) => r.detail).join('\n');

/** The statement `listSessions` issues for one page, and the values it binds. */
async function sessionPage(opts: Parameters<typeof listSessions>[2]): Promise<{ sql: string; params: unknown[] }> {
  const { db, statements } = recordingStore();
  await listSessions(db, { projectId: 'proj_1' }, opts);
  const page = statements.find((s) => /FROM sessions/i.test(s.sql) && /ORDER BY/i.test(s.sql));
  expect(page).toBeDefined();
  return page!;
}

/** The statements one import plan issues, in the shape `heldTranscriptsFor` builds them. */
async function heldReads(sessionIds: string[], transcriptIds: string[]): Promise<Array<{ sql: string; params: unknown[] }>> {
  const { db, statements } = recordingStore();
  await heldTranscriptsFor(db, { projectId: 'proj_1' }, sessionIds, transcriptIds);
  return statements.filter((s) => /FROM transcripts/i.test(s.sql));
}

describe('the reads a person waits on', () => {
  it('pages a project\'s sessions over an index, with no sort step and no table scan', async () => {
    const { sql, params } = await sessionPage({ limit: 50, fidelity: 'any' });
    const db = migrated();
    const plan = planOf(db, sql, params);
    db.close();
    // Both halves. A temp b-tree means the ordering expression has no index;
    // a SCAN means the project filter has none. Either is the regression.
    expect({ sort: /TEMP B-TREE/.test(plan), scan: /SCAN sessions/.test(plan), plan })
      .toEqual({ sort: false, scan: false, plan });
  });

  it('looks a transcript up by each key on its own, so both halves are index lookups', async () => {
    // One statement with `session_id IN (…) OR transcript_id IN (…)` leaves the
    // planner a single equality and it falls back to scanning the table. Two
    // statements each get their own lookup. The shape is what the plan is
    // asserted over, so a revert to the single OR fails here.
    const reads = await heldReads(['s1', 's2'], ['tx_a']);
    expect(reads).toHaveLength(2);

    const db = migrated();
    try {
      for (const read of reads) {
        const plan = planOf(db, read.sql, read.params);
        expect({ sql: read.sql.slice(0, 40), scan: /SCAN transcripts/.test(plan), plan }).toEqual({ sql: read.sql.slice(0, 40), scan: false, plan });
      }
    } finally {
      db.close();
    }
  });

  it('asks nothing when it is given nothing to look up', async () => {
    // An empty list builds `IN ()`, which is a syntax error rather than an
    // empty answer, so each half is skipped rather than emitted empty.
    expect(await heldReads([], [])).toEqual([]);
    expect(await heldReads(['s1'], [])).toHaveLength(1);
    expect(await heldReads([], ['tx_a'])).toHaveLength(1);
  });

  it('keeps the same plan when a cursor narrows the page', async () => {
    // The keyset predicate is where the ordering expression appears a second
    // and third time. A cursor built over a different expression than the sort
    // does not fail an ordering assertion — it drops and repeats rows across a
    // page boundary — and it also costs the index, which this catches.
    // Minted by the read layer's own encoder, so a change to the cursor format
    // does not quietly turn this into a page-one test.
    const { sql, params } = await sessionPage({ limit: 50, cursor: encodeCursor(1_700_000_000_000, 's'), fidelity: 'any' });
    expect(/WHERE/i.test(sql) && params.length > 1).toBe(true);

    const db = migrated();
    const plan = planOf(db, sql, params);
    db.close();
    expect({ sort: /TEMP B-TREE/.test(plan), scan: /SCAN sessions/.test(plan), plan })
      .toEqual({ sort: false, scan: false, plan });
  });
});
