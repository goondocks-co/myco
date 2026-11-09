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
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { explainReadPlan } from './helpers/prepared.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import { encodeCursor } from '@myco-server-worker/read/scope.js';
import {
  sessions_listSessions as listSessions,
} from '@myco-server-worker/read/catalog/sessions.js';
import { children_listPlans as listPlans } from '@myco-server-worker/read/catalog/children.js';
import { heldTranscriptsFor } from '@myco-server-worker/read/transcript.js';

import { sessionCommits } from '@myco-server-worker/read/session-commits.js';
import { listSessionArtifacts } from '@myco-server-worker/read/session-artifacts.js';

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
    batch: async (batched) => batched.map(() => ({ results: [], meta: { changes: 0 } })) as never,
  };
  return { db, statements };
}

/** A migrated, empty store to plan against. A plan is a property of the schema, not of the rows. */
function migrated(): Database {
  const db = new Database(':memory:');
  for (const statement of SCHEMA_DDL) db.run(statement);
  return db;
}

const planOf = async (db: Database, sql: string, params: readonly unknown[]): Promise<string> =>
  (await explainReadPlan(sqliteRelationalStore(db), { sql, binds: params })).map((r) => r.detail).join('\n');

/** The page's ordering runs outside scalar source selections. */
async function sessionPagePlan(db: Database, sql: string, params: readonly unknown[]) {
  const rows = await explainReadPlan(sqliteRelationalStore(db), { sql, binds: params });
  return {
    sort: rows.some((row) => row.parent === 0 && /TEMP B-TREE/.test(row.detail)),
    scan: rows.some((row) => /SCAN sessions/.test(row.detail)),
    plan: rows.map((row) => row.detail).join('\n'),
  };
}

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
    const plan = await sessionPagePlan(db, sql, params);
    db.close();
    // Page ordering and the Project filter both use indexes.
    expect(plan).toEqual({ sort: false, scan: false, plan: plan.plan });
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
        const plan = await planOf(db, read.sql, read.params);
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

  it('pages a session\'s plans narrowed by status through every match once, oldest edit first, and none from elsewhere', async () => {
    const sqlite = migrated();
    try {
      sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'p', 1), ('proj_2', 'q', 1)`);
      for (const [project, session] of [['proj_1', 's1'], ['proj_1', 's2'], ['proj_2', 's1']]) {
        sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES (?, ?, 'm', 't', 1, 1)`, [project, session]);
      }
      const plan = (project: string, session: string, key: string, status: string, at: number) => sqlite.run(`INSERT INTO plans
        (project_id, plan_key, session_id, event_id, machine_id, content_hash, status, title, content, created_at, updated_at, token_id, received_at)
        VALUES (?, ?, ?, ?, 'm', 'h', ?, ?, '- [ ] a', ?, ?, 't', ?)`, [project, key, session, `e_${project}_${key}`, status, key, at, at, at]);
      // Pairs of plans share an edit instant, so the key breaks the tie across page boundaries.
      for (let i = 0; i < 90; i += 1) plan('proj_1', 's1', `k${String(i).padStart(3, '0')}`, ['active', 'completed', 'in_progress'][i % 3]!, 1_000 + Math.floor(i / 2));
      plan('proj_1', 's2', 'k_elsewhere', 'active', 5_000);
      plan('proj_2', 's1', 'k_other_project', 'active', 5_000);
      const db = sqliteRelationalStore(sqlite);
      const expected = (sqlite.query(`SELECT plan_key FROM plans WHERE project_id = 'proj_1' AND session_id = 's1' AND status = 'active' ORDER BY updated_at, plan_key`).all() as { plan_key: string }[]).map((r) => r.plan_key);
      const walked: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const listed = await listPlans(db, { projectId: 'proj_1' }, 's1', { limit: 7, status: 'active', ...(cursor === undefined ? {} : { cursor }) });
        walked.push(...listed.rows.map((row) => row.planKey));
        if (listed.cursor === null) break;
        cursor = listed.cursor;
      }
      expect({ n: walked.length, walked }).toEqual({ n: 30, walked: expected });
    } finally {
      sqlite.close();
    }
  });

  it('reads a session\'s commit observations and its release state over indexes, with no scan', async () => {
    const { db: recorder, statements } = recordingStore();
    await sessionCommits(recorder, { projectId: 'proj_1' }, 's1');
    expect(statements).toHaveLength(2);
    const db = migrated();
    try {
      const [observed, release] = await Promise.all(statements.map((s) => planOf(db, s.sql, s.params)));
      expect({ index: /SEARCH g USING INDEX idx_fk_knowledge_git_provenance_project_id_session_id \(project_id=\? AND session_id=\?\)/.test(observed), scan: /\bSCAN\b/.test(observed), observed })
        .toEqual({ index: true, scan: false, observed });
      expect({ index: /SEARCH knowledge_release_state USING INDEX idx_knowledge_release_embedding/.test(release), scan: /\bSCAN\b/.test(release), release })
        .toEqual({ index: true, scan: false, release });
    } finally {
      db.close();
    }
  });

  it('pages a session\'s reported artifacts over their session index in its own order, with no sort step and no scan', async () => {
    const { db: recorder, statements } = recordingStore();
    await listSessionArtifacts(recorder, { projectId: 'proj_1' }, 's1', { limit: 2 });
    await listSessionArtifacts(recorder, { projectId: 'proj_1' }, 's1', { limit: 2, cursor: encodeCursor(5, 'a') });
    expect(statements).toHaveLength(2);
    const db = migrated();
    try {
      for (const statement of statements) {
        const plan = await planOf(db, statement.sql, statement.params);
        expect({ index: /SEARCH session_artifacts USING INDEX idx_session_artifacts_session \(project_id=\? AND session_id=\?/.test(plan), scan: /\bSCAN\b/.test(plan), sort: /TEMP B-TREE/.test(plan), plan })
          .toEqual({ index: true, scan: false, sort: false, plan });
      }
    } finally {
      db.close();
    }
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
    const plan = await sessionPagePlan(db, sql, params);
    db.close();
    expect(plan).toEqual({ sort: false, scan: false, plan: plan.plan });
  });
});
