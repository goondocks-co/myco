/**
 * The query plans behind search: a Project's search and the search across Projects.
 *
 * Each statement is captured from the code and explained under the statistics a Deployment's store plans from: none,
 * `stale` and `current` (see `helpers/planner-stats.ts`). A search is driven by the full-text match: the index finds
 * the matching rows, the outer read walks those candidates alone, and no Project's rows are ever read whole.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import { MAX_NAMED_PROJECTS, type ProjectSet } from '@myco-server-worker/read/scope.js';
import { searchAcross, searchProject, type SearchOptions } from '@myco-server-worker/read/search.js';
import { getReleaseStatesAcross } from '@myco-server-worker/core/provenance.js';
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

async function captured(read: (db: RelationalStore) => Promise<unknown>): Promise<Statement[]> {
  const { db, statements } = recordingStore();
  await read(db);
  return statements;
}

async function plans(read: (db: RelationalStore) => Promise<unknown>): Promise<Array<{ store: string; sql: string; plan: string }>> {
  const statements = await captured(read);
  return Object.entries(STORES).flatMap(([store, db]) => statements.map((s) => ({ store, sql: s.sql.replace(/\s+/g, ' '), plan: planOf(db, s) })));
}

/** Steps that read a table whole. A full-text index's own search, the candidates and the named set's JSON are not tables. */
const tableScans = (plan: string): string[] => plan.split('\n')
  .filter((step) => /\bSCAN\b/.test(step) && !/\b(?:\w+_fts|candidates|json_each)\b/.test(step)).map((s) => s.trim());

const ALL: ProjectSet = { all: true };
const NAMED: ProjectSet = { all: false, projectIds: ['proj_0', 'proj_1'] };
const REACHES: Record<string, (db: RelationalStore, opts: SearchOptions) => Promise<unknown>> = {
  project: (db, opts) => searchProject(db, { projectId: 'proj_0' }, opts),
  all: (db, opts) => searchAcross(db, ALL, opts),
  named: (db, opts) => searchAcross(db, NAMED, opts),
};
const SHAPES: Record<string, SearchOptions> = {
  one: { query: 'title' },
  terms: { query: 'title two three' },
  filtered: { query: 'title two', status: 'active', observation_type: 'gotcha', since: 1, until: 2_000_000_000 },
  session: { query: 'title', session_id: 's1' },
  released: { query: 'title', release_state: 'released', release_confidence: 'high' },
};

describe('search under the statistics a Deployment plans from', () => {
  it('drives every type from its full-text match and joins back only the candidates, in each reach and store', async () => {
    for (const [reach, search] of Object.entries(REACHES)) {
      for (const [shape, opts] of Object.entries(SHAPES)) {
        const read = (await plans((db) => search(db, opts))).filter(({ sql }) => /WITH candidates/.test(sql));
        expect({ reach, shape, statements: read.length > 0 }).toEqual({ reach, shape, statements: true });
        for (const { store, sql, plan } of read) {
          expect({
            reach, shape, store, sql,
            byMatch: /^MATERIALIZE candidates\n(?:COMPOUND QUERY\nLEFT-MOST SUBQUERY\n)?SCAN \w+_fts VIRTUAL TABLE INDEX \d+:M/.test(plan),
            walksCandidates: /\nSCAN candidates\nSEARCH d USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(plan),
            byProject: /SEARCH d USING (?:COVERING )?INDEX \w+ \(project_id=\?\)/.test(plan),
            scans: tableScans(plan),
            plan,
          }).toEqual({ reach, shape, store, sql, byMatch: true, walksCandidates: true, byProject: false, scans: [], plan });
        }
      }
    }
  });

  it('counts the search backlog from the pending-blob index, and reads release states by Project', async () => {
    for (const [reach, search] of Object.entries(REACHES)) {
      const read = (await plans((db) => search(db, SHAPES.one!))).filter(({ sql }) => /FROM search_blob_queue/.test(sql));
      expect(read).toHaveLength(3);
      for (const { store, plan } of read) {
        expect({ reach, store, plan }).toEqual({ reach, store, plan: expect.stringMatching(/^SEARCH q USING COVERING INDEX idx_search_blob_pending \(complete=\?\)/) });
        expect({ reach, store, scans: tableScans(plan) }).toEqual({ reach, store, scans: [] });
      }
    }
    const release = await plans((db) => getReleaseStatesAcross(db, [{ projectId: 'proj_0', namespace: 'spore', recordIds: ['a'] }, { projectId: 'proj_1', namespace: 'plan', recordIds: ['b'] }]));
    expect(release).toHaveLength(2 * 3);
    for (const { store, plan } of release) expect({ store, plan }).toEqual({ store, plan: expect.stringMatching(/SEARCH knowledge_release_state USING INDEX \w+ \(project_id=\?\)/) });
  });

  it('needs the candidates to drive the join: under stale statistics a plain join walks the whole table', async () => {
    const [statement] = (await captured((db) => searchAcross(db, ALL, { query: 'title two', type: 'spore' }))).filter(({ sql }) => /WITH candidates/.test(sql));
    expect(statement!.sql).toMatch(/FROM spores_fts CROSS JOIN spores d[\s\S]*FROM candidates CROSS JOIN spores d/);
    const plain = { ...statement!, sql: statement!.sql.replace('FROM candidates CROSS JOIN', 'FROM candidates JOIN') };
    expect(tableScans(planOf(STORES.stale, plain))).toEqual(['SCAN d']);
  });

  it('binds at most the store\'s 100 values and holds at most two compound terms, with the most Projects and terms and every filter', async () => {
    const most: ProjectSet = { all: false, projectIds: Array.from({ length: MAX_NAMED_PROJECTS }, (_, i) => `proj_${i}`) };
    const opts: SearchOptions = {
      query: Array.from({ length: 16 }, (_, i) => `term${i}`).join(' '), status: 'active', session_id: 's', observation_type: 'gotcha',
      since: 1, until: 2, release_state: 'released', release_confidence: 'high', limit: 100,
    };
    const statements = await captured(async (db) => { await searchAcross(db, most, opts); await searchAcross(db, ALL, opts); await searchProject(db, { projectId: 'proj_0' }, opts); });
    expect(statements.filter(({ sql }) => /WITH candidates/.test(sql)).length).toBeGreaterThanOrEqual(3);
    const over = statements.filter((s) => s.params.length > 100).map((s) => `${s.params.length}: ${s.sql.replace(/\s+/g, ' ').slice(0, 60)}`);
    expect(over).toEqual([]);
    // D1 refuses a compound SELECT of more than five terms; a search is its match and, for a spilled body, one more.
    for (const { sql } of statements) expect((sql.match(/\bUNION\b|\bINTERSECT\b|\bEXCEPT\b/g) ?? []).length).toBeLessThanOrEqual(1);
  });
});
