/**
 * The reads and writes of auto-join (#1547) under the statistics a Deployment plans from: every statement seeks by key
 * or through an index step 61 adds, on a store never analyzed, one analyzed before the step, and one analyzed with it.
 * The one read that walks an index rather than seeking it is an administrator's list, in index order and bounded by its
 * limit; the project count a creation checks walks the projects, which `MAX_PROJECTS` bounds, as every creation does.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { getUncaptured, listUncaptured, UNCAPTURED_LIST_LIMIT } from '@myco-server-worker/read/uncaptured.js';
import { clearMemberUncapturedStatement, clearUncapturedStatement, heldUncapturedStatement, pruneUncaptured, recordUncapturedStatement } from '@myco-server-worker/ingest/uncaptured.js';
import { resolveRepository } from '@myco-server-worker/core/remotes.js';
import { connectedRoot, connectMachineRoot } from '@myco-server-worker/core/machine-settings.js';
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

const scans = (plan: string): string[] => plan.split('\n').filter((step) => /\bSCAN\b/.test(step) && !/SCAN (?:CONSTANT ROW|\(subquery)/.test(step)).map((step) => step.trim());
const ROW_KEY = 'SEARCH u USING INDEX sqlite_autoindex_uncaptured_roots_1 (machine_id=? AND root_key=?)';
const MEMBER_KEY = 'SEARCH m USING INDEX sqlite_autoindex_members_1 (id=?)';
const KEY = 'a'.repeat(16);

describe('auto-join, under the statistics a Deployment plans from', () => {
  it('reads a member\'s repositories by member, an administrator\'s in index order to the limit, and one by its key', async () => {
    const [all, mine, one] = await Promise.all([
      plans((db) => listUncaptured(db, { all: true })),
      plans((db) => listUncaptured(db, { all: false, memberId: 'mem_1' })),
      plans((db) => getUncaptured(db, 'machine_1', KEY)),
    ]);
    for (const { store, sql, plan } of all) {
      expect({ store, plan }).toEqual({ store, plan: `SCAN u USING INDEX idx_uncaptured_roots_seen\n${MEMBER_KEY}` });
      expect(sql).toContain('LIMIT ?');
    }
    for (const { store, plan } of mine) expect({ store, plan }).toEqual({ store, plan: `SEARCH u USING INDEX idx_uncaptured_roots_member (member_id=?)\n${MEMBER_KEY}` });
    for (const { store, plan } of one) expect({ store, plan }).toEqual({ store, plan: `${ROW_KEY}\n${MEMBER_KEY}` });
    expect(UNCAPTURED_LIST_LIMIT).toBe(100);
  });

  it('records and forgets a repository by its key', async () => {
    const written = await plans(async (db) => {
      await recordUncapturedStatement(db, { machineId: 'machine_1', memberId: 'mem_1', rootKey: KEY, label: 'widget', remote: null, reason: 'no_remote', held: 'held', sessions: 1, now: 1 }).run();
      await clearUncapturedStatement(db, 'machine_1', KEY).run();
    });
    for (const { store, plan } of written) expect({ store, scans: scans(plan) }).toEqual({ store, scans: [] });
    expect(written.filter(({ sql }) => sql.startsWith('DELETE')).map(({ plan }) => plan)).toEqual(Array(3).fill(ROW_KEY.replace('SEARCH u', 'SEARCH uncaptured_roots')));
  });

  it('marks one by its key, forgets a revoked member\'s by member, and the stale ones in index order to the batch', async () => {
    const written = await plans(async (db) => {
      await heldUncapturedStatement(db, 'machine_1', KEY, 'full').run();
      await clearMemberUncapturedStatement(db, 'mem_1', 'mem_admin', 1).run();
      await pruneUncaptured(db, 1_800_000_000_000, 100);
    });
    for (const { store, sql, plan } of written) {
      expect({ store, sql: sql.slice(0, 60), scans: scans(plan) }).toEqual({ store, sql: sql.slice(0, 60), scans: [] });
      if (sql.startsWith('UPDATE')) expect({ store, plan }).toEqual({ store, plan: ROW_KEY.replace('SEARCH u', 'SEARCH uncaptured_roots') });
      if (sql.includes('member_id = ?')) expect({ store, plan }).toEqual({ store, plan: expect.stringContaining('idx_uncaptured_roots_member (member_id=?)') });
      if (sql.includes('last_seen_at < ?')) expect({ store, plan }).toEqual({ store, plan: expect.stringContaining('idx_uncaptured_roots_seen (last_seen_at<?)') });
    }
  });

  it('resolves a repository by its remote\'s key, and reads what a machine is told by the machine\'s key', async () => {
    const resolved = await plans(async (db) => {
      await resolveRepository(db, { remote: 'github.com/acme/widget', name: 'widget', allowCreate: true, projectId: 'proj_new', now: 1, maxProjects: 1_000 });
      await resolveRepository(db, { remote: null, name: 'notes', allowCreate: true, projectId: 'proj_new', now: 1, maxProjects: 1_000 });
      await connectedRoot(db, 'machine_1', KEY);
      await connectMachineRoot(db, 'machine_1', KEY, '', 'mem_1', 1);
    });
    for (const { store, sql, plan } of resolved) {
      // The project count a creation is admitted on walks the projects, as every project creation's does.
      const walked = scans(plan).filter((step) => step !== 'SCAN projects' || !/COUNT\(\*\) FROM projects WHERE archived_at IS NULL/.test(sql));
      expect({ store, sql: sql.slice(0, 70), scans: walked }).toEqual({ store, sql: sql.slice(0, 70), scans: [] });
    }
    const held = resolved.filter(({ sql }) => sql.startsWith('SELECT p.project_id'));
    for (const { store, plan } of held) {
      expect({ store, plan }).toEqual({ store, plan: expect.stringContaining('SEARCH p USING INDEX sqlite_autoindex_projects_1 (project_id=?)') });
      expect({ store, plan }).toEqual({ store, plan: expect.stringContaining('SEARCH r USING INDEX sqlite_autoindex_project_remotes_1 (remote=?)') });
    }
  });
});
