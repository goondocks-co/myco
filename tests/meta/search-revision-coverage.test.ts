/**
 * Architecture gate: every table and column a ranked search page's membership or order rests on fences that search's
 * cursor, in effect and not only by name.
 *
 * The dependencies are derived from the ranked statements themselves, not declared: each statement a search issues
 * (every type, each filter, each reach, first page and continuation) is cut to its two leading CTEs, which decide which
 * records a page lists and in what order, and SQLite's own bytecode for that cut names every table it opens and every
 * column it reads, including the key columns of each index it seeks.
 *
 * Each search is grouped by the fence it reads (the full-text marks and revision kinds it asks for). For every
 * dependency of a group the gate then changes a real row, in both directions, and deletes and restores it, with a live
 * cursor of that group's search open: the search's next page must refuse as stale each time. A trigger that is missing,
 * can never fire, or advances a revision this search does not read leaves the cursor continuing, and fails here.
 */
import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { searchAcross, searchProject, StaleSearch } from '@myco-server-worker/read/search.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { SearchOptions } from '@goondocks/myco-shared/search-types';

type Captured = { sql: string; params: unknown[] };

function migrated(): Database {
  const db = new Database(':memory:');
  for (const step of SCHEMA_STEPS) for (const sql of step.statements) db.exec(sql);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`INSERT INTO projects (project_id, name, created_at) VALUES ('p', 'p', 1), ('q', 'q', 1);
    INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('a', 'a', 'built-in', 1, 0);
    INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, title)
      VALUES ('p', 's1', 'm', 't', 1, 1, 'codex', 'fix', 'cobalt one'), ('p', 's2', 'm', 't', 2, 2, 'codex', 'fix', 'cobalt two'), ('p', 's3', 'm', 't', 3, 3, 'codex', 'fix', 'cobalt three'), ('p', 's4', 'm', 't', 4, 4, 'codex', 'fix', 'cobalt four');
    INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, created_at)
      VALUES ('p', 'sp1', 'a', 's1', 'decision', 'active', 'cobalt one', 1), ('p', 'sp2', 'a', 's2', 'decision', 'active', 'cobalt two', 2), ('p', 'sp3', 'a', 's2', 'decision', 'active', 'cobalt three', 3), ('p', 'sp4', 'a', 's2', 'decision', 'active', 'cobalt four', 4);
    INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, content_hash, status, created_at, updated_at, token_id, received_at)
      VALUES ('p', 'k1', 's1', 'e1', 'm', 'cobalt one', 'x', 'h', 'active', 1, 1, 't', 1), ('p', 'k2', 's2', 'e2', 'm', 'cobalt two', 'x', 'h', 'active', 2, 2, 't', 1), ('p', 'k3', 's2', 'e3', 'm', 'cobalt three', 'x', 'h', 'active', 3, 3, 't', 1), ('p', 'k4', 's2', 'e4', 'm', 'cobalt four', 'x', 'h', 'active', 4, 4, 't', 1);
    INSERT INTO turn_cards (project_id, session_id, turn_key, state, card, created_at)
      VALUES ('p', 's1', 't1', 'carded', 'cobalt one', 1), ('p', 's2', 't2', 'carded', 'cobalt two', 2), ('p', 's2', 't3', 'carded', 'cobalt three', 3), ('p', 's2', 't4', 'carded', 'cobalt four', 4);
    INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES ('q', 'gone', 'x', 1, 'm');
    INSERT INTO processed_resources (project_id, kind, resource_id, blob_key, source_token_id, event_id) VALUES ('p', 'plan', 'k1', 'blob1', 't', 'e1');
    INSERT INTO search_blob_chunks (project_id, blob_key, offset, text) VALUES ('p', 'blob1', 0, 'unrelated chunk');`);
  const release = db.query(`INSERT INTO knowledge_release_state (project_id, id, identity_key, namespace, record_id, state, confidence, checked_at, created_at) VALUES ('p', ?, ?, ?, ?, 'released', 'high', 1, 1)`);
  for (const [namespace, prefix] of [['spores', 'sp'], ['plans', 'k'], ['sessions', 's'], ['prompt_batches', 't'], ['responses', 't']] as const) {
    for (const n of [1, 2, 3, 4]) release.run(`${namespace}_${n}`, `key_${namespace}_${n}`, namespace, `${prefix}${n}`);
  }
  return db;
}

/** One search: how to run it, the fence statements it reads, and the ranked statements it issues. */
interface Shape { name: string; options: SearchOptions; read: (options: SearchOptions) => Promise<{ cursor: string | null }>; fence: Captured[]; ranked: Captured[] }

const FENCE_READ = /FROM search_revisions WHERE kind|_data WHERE id = 1/;

/** Every search shape, run on the store: each type, filter and reach, first page and the page its cursor continues to. */
async function searchShapes(db: Database): Promise<Shape[]> {
  const inner = sqliteRelationalStore(db);
  let ranked: Captured[] = [];
  let fences: Captured[] = [];
  const wrap = (statement: PreparedStatement, record: Captured): PreparedStatement => ({
    ...statement, bind: (...values: unknown[]) => { record.params = values; return wrap(statement.bind(...values), record); },
  });
  const store: RelationalStore = {
    prepare: (sql: string) => {
      const record = { sql, params: [] as unknown[] };
      if (/^\s*WITH candidates AS MATERIALIZED/.test(sql)) ranked.push(record);
      else if (FENCE_READ.test(sql)) fences.push(record);
      return wrap(inner.prepare(sql), record);
    },
    batch: (statements) => inner.batch(statements),
  };
  const filters: Partial<SearchOptions>[] = [{}, { status: 'active' }, { session_id: 's1' }, { observation_type: 'decision' }, { since: 0, until: 9 },
    { release_state: 'released' }, { release_confidence: 'high' }, { agent: 'codex' }, { branch: 'fix' }];
  const reaches: [string, Shape['read']][] = [
    ['project', (options) => searchProject(store, { projectId: 'p' }, options)],
    ['all', (options) => searchAcross(store, { all: true }, options)],
    ['named', (options) => searchAcross(store, { all: false, projectIds: ['p', 'q'] }, options)],
  ];
  const shapes: Shape[] = [];
  for (const type of ['spore', 'plan', 'session', 'prompt', 'response', 'all']) for (const filter of filters) for (const [reach, read] of reaches) {
    const options: SearchOptions = { query: 'cobalt', type, mode: 'fts', limit: 1, ...filter };
    ranked = []; fences = [];
    const first = await read(options);
    if (first.cursor !== null) await read({ ...options, cursor: first.cursor });
    shapes.push({ name: `${type} ${JSON.stringify(filter)} ${reach}`, options, read, fence: fences, ranked });
  }
  ranked = []; fences = [];
  return shapes;
}

/** The statement cut to its leading CTEs, selecting what they keep, with the values those CTEs bind. */
function membership({ sql, params }: Captured): Captured {
  let depth = 0;
  for (let i = sql.indexOf('candidates'); i < sql.length; i += 1) {
    const c = sql[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === "'") i = sql.indexOf("'", i + 1);
    else if (depth === 0 && /^\s*SELECT\b/i.test(sql.slice(i, i + 12)) && /\)\s*$/.test(sql.slice(0, i))) {
      const prefix = sql.slice(0, i);
      return { sql: `${prefix} SELECT * FROM kept`, params: params.slice(0, (prefix.match(/\?/g) ?? []).length) };
    }
  }
  throw new Error(`no final select after the CTEs of: ${sql.slice(0, 120)}`);
}

/** Every table a statement opens and every column it reads, by SQLite's bytecode; rowids and FTS internals aside. */
function reads(db: Database, statement: Captured, out: Map<string, Set<string>>): void {
  const objects = db.query("SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master WHERE rootpage > 0").all() as { type: string; name: string; tbl_name: string; rootpage: number; sql: string | null }[];
  const byRoot = new Map(objects.map((o) => [o.rootpage, o]));
  const columnsOf = (o: (typeof objects)[number]): string[] => {
    if (o.type === 'index') return (db.query(`PRAGMA index_xinfo("${o.name}")`).all() as { cid: number; name: string | null }[]).map((r) => r.cid === -1 ? 'rowid' : r.name ?? '');
    if (/WITHOUT ROWID/i.test(o.sql ?? '')) {
      const key = objects.find((x) => x.type === 'index' && x.tbl_name === o.name && x.name.startsWith('sqlite_autoindex_'));
      const pk = key === undefined ? [] : (db.query(`PRAGMA index_info("${key.name}")`).all() as { name: string }[]).map((r) => r.name);
      const all = (db.query(`PRAGMA table_info("${o.name}")`).all() as { name: string }[]).map((r) => r.name);
      return [...pk, ...all.filter((c) => !pk.includes(c))];
    }
    return (db.query(`PRAGMA table_xinfo("${o.name}")`).all() as { name: string }[]).map((r) => r.name);
  };
  const ops = db.query(`EXPLAIN ${statement.sql}`).all(...statement.params as never[]) as { opcode: string; p1: number; p2: number }[];
  const cursors = new Map<number, (typeof objects)[number]>();
  const add = (table: string, column: string) => {
    if (/_fts(_|$)/.test(table) || column === 'rowid' || column === '') return;
    if (!out.has(table)) out.set(table, new Set());
    out.get(table)!.add(column);
  };
  for (const op of ops) {
    if (op.opcode !== 'OpenRead' && op.opcode !== 'ReopenIdx') continue;
    const o = byRoot.get(op.p2);
    if (o === undefined) continue;
    cursors.set(op.p1, o);
    if (!/_fts(_|$)/.test(o.tbl_name) && !out.has(o.tbl_name)) out.set(o.tbl_name, new Set());
    // An index sought by key decides membership by every key column, whether or not a column is read from it.
    if (o.type === 'index') for (const column of columnsOf(o)) add(o.tbl_name, column);
  }
  for (const op of ops) {
    if (op.opcode !== 'Column') continue;
    const o = cursors.get(op.p1);
    if (o !== undefined) add(o.tbl_name, columnsOf(o)[op.p2] ?? '');
  }
}

/** A value that differs from `value` and that the column admits. */
const OTHER_VALUES: Readonly<Record<string, readonly [string, string]>> = { 'processed_resources.kind': ['plan', 'prompt'], 'processed_resources.classification': ['processed', 'raw'] };
function another(table: string, column: string, value: unknown, declared: string): unknown {
  const pair = OTHER_VALUES[`${table}.${column}`];
  if (pair !== undefined) return value === pair[0] ? pair[1] : pair[0];
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'string') return `${value}_m`;
  return /INT/i.test(declared) ? 7 : 'm';
}

/** The row of a table each change targets: one whose loss leaves the seeded search a next page and no other row removed. */
const ROW_OF: Readonly<Record<string, string>> = { processed_resources: "kind = 'plan'", projects: "project_id = 'q'", plans: "plan_key = 'k4'", sessions: "session_id = 's4'" };

/** Every way a dependency can change, each paired with the change that undoes it. */
function changes(db: Database, table: string, columns: ReadonlySet<string>): { name: string; apply: () => void; undo: () => void }[] {
  const info = db.query(`PRAGMA table_info("${table}")`).all() as { name: string; type: string; pk: number }[];
  const withoutRowid = /WITHOUT ROWID/i.test((db.query('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string }).sql);
  const keyColumns = withoutRowid ? info.filter((c) => c.pk > 0).map((c) => c.name) : ['rowid'];
  const row = db.query(`SELECT ${withoutRowid ? '' : 'rowid AS rowid, '}* FROM "${table}" WHERE ${ROW_OF[table] ?? '1'} LIMIT 1`).get() as Record<string, unknown> | null;
  if (row === null) throw new Error(`the gate seeds no row of ${table}, which a ranked search reads`);
  const where = (values: Record<string, unknown>) => ({ sql: keyColumns.map((k) => `"${k}" IS ?`).join(' AND '), params: keyColumns.map((k) => values[k]) });
  const set = (column: string, from: unknown, to: unknown) => {
    const key = where({ ...row, [column]: from });
    db.query(`UPDATE "${table}" SET "${column}" = ? WHERE ${key.sql}`).run(...[to, ...key.params] as never[]);
  };
  const out = [...columns].map((column) => {
    const declared = info.find((c) => c.name === column)?.type ?? '';
    const from = row[column];
    const to = another(table, column, from, declared);
    return { name: `${table}.${column}`, apply: () => set(column, from, to), undo: () => set(column, to, from) };
  });
  const all = Object.keys(row);
  const key = where(row);
  out.push({ name: `${table} row`, apply: () => { db.query(`DELETE FROM "${table}" WHERE ${key.sql}`).run(...key.params as never[]); },
    undo: () => { db.query(`INSERT INTO "${table}" (${all.map((c) => `"${c}"`).join(', ')}) VALUES (${all.map(() => '?').join(', ')})`).run(...all.map((c) => row[c]) as never[]); } });
  return out;
}

/** What a ranked search reads whose change leaves that search's cursor continuing: empty when every dependency fences. */
async function unfencedSearchDependencies(db: Database): Promise<string[]> {
  const shapes = await searchShapes(db);
  const groups = new Map<string, Shape[]>();
  for (const shape of shapes.filter((s) => s.ranked.length > 0)) {
    const signature = JSON.stringify([...new Set(shape.fence.map(({ sql, params }) => JSON.stringify([sql, params])))].sort());
    groups.set(signature, [...(groups.get(signature) ?? []), shape]);
  }
  const missing: string[] = [];
  for (const group of groups.values()) {
    const derived = new Map<string, Set<string>>();
    for (const shape of group) for (const statement of shape.ranked) reads(db, membership(statement), derived);
    const candidates = await Promise.all(group.map(async (shape) => ({ shape, first: await shape.read(shape.options) })));
    const live = candidates.find(({ first }) => first.cursor !== null);
    if (live === undefined) { missing.push(`no search of ${group[0]!.name} and its fence has a next page: seed more matches`); continue; }
    const { shape } = live;
    const refused = async (change: () => void) => {
      const first = await shape.read(shape.options);
      if (first.cursor === null) throw new Error(`${shape.name} has no next page to fence: seed more matches`);
      change();
      return shape.read({ ...shape.options, cursor: first.cursor }).then(() => false, (error: unknown) => {
        if (error instanceof StaleSearch) return true;
        throw error;
      });
    };
    for (const [table, columns] of [...derived].sort()) for (const { name, apply, undo } of changes(db, table, columns)) {
      // A column the schema's own guard refuses to change cannot move a search.
      try { apply(); undo(); } catch (error) {
        if (error instanceof Error && /is immutable/.test(error.message)) continue;
        throw error;
      }
      if (!await refused(apply)) missing.push(`${name}: changing it leaves the cursor of ${shape.name} continuing`);
      if (!await refused(undo)) missing.push(`${name}: restoring it leaves the cursor of ${shape.name} continuing`);
    }
  }
  return missing.sort();
}

/** A migrated store with the named trigger rewritten by `rewrite`, or dropped when it answers null. */
function withTrigger(name: string, rewrite: (sql: string) => string | null): Database {
  const db = migrated();
  const { sql } = db.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string };
  db.exec(`DROP TRIGGER ${name}`);
  const next = rewrite(sql);
  if (next !== null) db.exec(next);
  return db;
}

it('derives the joined filters and reach of the ranked searches, and every one of them refuses a live cursor when it changes', async () => {
  const db = migrated();
  try {
    const shapes = await searchShapes(db);
    // Each type, filter and reach issues its ranked statements, and every continuation issues its own.
    expect(shapes.flatMap((shape) => shape.ranked).length).toBeGreaterThan(100);
    const derived = new Map<string, Set<string>>();
    for (const statement of shapes.flatMap((shape) => shape.ranked)) reads(db, membership(statement), derived);
    // The derivation reaches past the source tables into every joined filter and reach.
    for (const table of ['spores', 'plans', 'sessions', 'turn_cards', 'knowledge_release_state', 'projects', 'session_tombstones', 'processed_resources']) {
      expect({ table, read: derived.has(table) }).toEqual({ table, read: true });
    }
    expect(await unfencedSearchDependencies(db)).toEqual([]);
  } finally { db.close(); }
}, 120_000);

it('catches a dependency whose trigger is removed, can never fire, or advances a revision the search does not read', async () => {
  const name = 'search_revision_release_knowledge_release_state_update';
  const controls: [string, (sql: string) => string | null][] = [
    ['removed', () => null],
    ['disabled', (sql) => sql.replace(/\bWHEN\b/, 'WHEN 0 AND')],
    ['wrong revision', (sql) => sql.replace("kind = 'release'", "kind = 'plan'")],
  ];
  for (const [control, rewrite] of controls) {
    const db = withTrigger(name, rewrite);
    try {
      expect({ control, reported: (await unfencedSearchDependencies(db)).filter((line) => line.startsWith('knowledge_release_state.state')).length > 0 }).toEqual({ control, reported: true });
    } finally { db.close(); }
  }
}, 120_000);
