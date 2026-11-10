import { afterEach, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { read, write, assertion, commit, readSet, MAX_SQL_BYTES } from '@myco-server-worker/db/index.js';
import { bindSlots } from '@myco-server-worker/db/kernel/limits.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { RELATIONAL_CONTEXT, type RelationalStore } from '@myco-server-worker/core/adapters.js';
import { writeGuardStore } from '@myco-server-worker/core/write-guard-store.js';
import { measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { excludeDeletedRestoreRows } from '@myco-server-worker/core/restore-rows.js';
import { containsPattern } from '@myco-server-worker/read/scope.js';
import { classify } from '@myco-server-worker/telemetry.js';
import { schemaSqlite } from './helpers/schema-template.js';

interface Item { id: string; n: number }
const insert = write<[id: string, n: number], Item>({ name: 'kernelTest.insert', sql: 'INSERT INTO items(id,n) VALUES(?,?) RETURNING id,n' });
const update = write<[id: string, n: number]>({ name: 'kernelTest.update', sql: 'UPDATE items SET n=?2 WHERE id=?1' });
const rows = read<[], Item>({ name: 'kernelTest.rows', sql: 'SELECT id,n FROM items ORDER BY id' });
const count = read<[], { n: number }>({ name: 'kernelTest.count', sql: 'SELECT COUNT(*) AS n FROM items' });
const revision = assertion<[id: string, n: number]>({ name: 'kernelTest.revision', sql: `SELECT CASE WHEN EXISTS(SELECT 1 FROM items WHERE id=? AND n=?) THEN 1 ELSE json_extract('[]','$[assertion_refused]') END AS admitted` });
const pattern = read<[pattern: string], Item>({ name: 'kernelTest.pattern', sql: `SELECT id,n FROM items WHERE id LIKE ? ESCAPE '\'`, like: [1] });

const handles: Database[] = [];
/** A store holding one generic table; `schema` puts it beside the current schema. */
function fixture(options: { schema?: boolean } = {}) {
  const sqlite = options.schema === true ? schemaSqlite() : new Database(':memory:');
  handles.push(sqlite);
  sqlite.run('CREATE TABLE items(id TEXT PRIMARY KEY,n INTEGER NOT NULL)');
  sqlite.run("INSERT INTO items VALUES('a',1)");
  return { sqlite, db: sqliteRelationalStore(sqlite) };
}
afterEach(() => { for (const sqlite of handles.splice(0)) sqlite.close(); });

it('rolls back companion writes when an in-batch assertion fails and retains result positions', async () => {
  const { db } = fixture();
  await expect(commit(db, insert.bind('b', 2), revision.bind('a', 99))).rejects.toThrow('JSON');
  expect(await readSet(db, rows.bind())).toEqual([[{ id: 'a', n: 1 }]]);
  const result = await commit(db, revision.bind('a', 1), insert.bind('b', 2), update.bind('a', 3));
  const returned: Item[] = result[1].results;
  expect(returned).toEqual([{ id: 'b', n: 2 }]);
  expect(result[1].meta.changes).toBe(0);
  expect(result[2].meta.changes).toBe(1);
});

it('readSet returns a typed tuple in one batch, with no I/O for empty sets', async () => {
  const { db } = fixture();
  const batch = spyOn(db, 'batch');
  const result: [Item[], { n: number }[]] = await readSet(db, rows.bind(), count.bind());
  expect(result).toEqual([[{ id: 'a', n: 1 }], [{ n: 1 }]]);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(await readSet(db)).toEqual([]);
  expect(await commit(db)).toEqual([]);
  expect(batch).toHaveBeenCalledTimes(1);
  if (false) {
    // @ts-expect-error A write cannot enter a read set.
    void readSet(db, insert.bind('bad', 0));
  }
  await expect(Reflect.apply(readSet, undefined, [db, insert.bind('bad', 0)])).rejects.toThrow('only read');
});

it('prepares a reusable Bound through the supplied guards and content meter at execution', async () => {
  const { db } = fixture();
  const context = { marker: 'request' };
  Object.assign(db, { [RELATIONAL_CONTEXT]: context });
  const bound = insert.bind('b', 2);
  let assertions = 0;
  const guarded = writeGuardStore(db, () => {
    assertions++;
    return db.prepare('SELECT 1');
  }, error => { throw error; }, { assertAfter: true });
  const nested = writeGuardStore(guarded, () => guarded.prepare('SELECT 1'), error => { throw error; });
  expect(Reflect.get(nested, RELATIONAL_CONTEXT)).toBe(context);
  expect((await commit(nested, bound))[0].results).toEqual([{ id: 'b', n: 2 }]);
  expect(assertions).toBe(2);
  const measured = measuredContentEnv({ db: guarded }, { statements: 2, blobCalls: 0 });
  const direct = await measured.env.db.prepare('SELECT id,n FROM items ORDER BY id').all<Item>();
  const [throughKernel] = await readSet(measured.env.db, rows.bind());
  expect(throughKernel).toEqual(direct.results);
  expect(measured.usage).toMatchObject({ statements: 2, roundTrips: 2 });
  await expect(commit(measured.env.db, insert.bind('refused', 0))).rejects.toThrow('content_statement_budget_exhausted');
  const other = fixture();
  expect((await commit(measuredContentEnv({ db: other.db }).env.db, bound))[0].results).toEqual([{ id: 'b', n: 2 }]);
});

it('keeps restore frontier assertions and their positional results inside the supplied store', async () => {
  const { db, sqlite } = fixture({ schema: true });
  sqlite.run("INSERT INTO projects(project_id,name,created_at) VALUES('project','project',1)");
  const context = { marker: 'restore' };
  Object.assign(db, { [RELATIONAL_CONTEXT]: context });
  const restoring = await excludeDeletedRestoreRows(db, new Map());
  expect(Reflect.get(restoring, RELATIONAL_CONTEXT)).toBe(context);
  const [inserted, revised] = await commit(restoring, insert.bind('b', 2), update.bind('a', 3));
  expect(inserted.results).toEqual([{ id: 'b', n: 2 }]);
  expect(revised.meta.changes).toBe(1);
  sqlite.run("INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES('project','session',1,'owner')");
  await expect(commit(restoring, insert.bind('c', 3))).rejects.toThrow('CHECK constraint failed');
  expect(await readSet(db, rows.bind())).toEqual([[{ id: 'a', n: 3 }, { id: 'b', n: 2 }]]);
});

it('preserves nested guard domain refusals and rolls back a failed post-assertion', async () => {
  const { db } = fixture();
  class DomainRefusal extends Error {}
  const refusal = new DomainRefusal('not_authorized');
  const guarded = writeGuardStore(db, () => db.prepare(`SELECT CASE WHEN (SELECT n FROM items WHERE id='a')=1 THEN 1 ELSE json_extract('[]','$[refused]') END`), () => { throw refusal; }, { assertAfter: true });
  const nested = writeGuardStore(guarded, () => guarded.prepare('SELECT 1'), error => { throw error; });
  try {
    await commit(nested, update.bind('a', 2), insert.bind('c', 3));
    throw new Error('expected refusal');
  } catch (error) { expect(error).toBe(refusal); }
  expect(await readSet(db, rows.bind())).toEqual([[{ id: 'a', n: 1 }]]);
  try { await commit(db, insert.bind('a', 9)); } catch (error) { expect(classify(error)).toBe('constraint'); }
});

it('counts numbered slots, ignores quoted/comment tokens and validates bindings and SQL bytes', () => {
  expect(bindSlots("SELECT ?1, ?1, '?101', \"?99\" /* ?999 */ -- ?888\n")).toBe(1);
  expect(bindSlots('SELECT ?2, ?, ?1')).toBe(3);
  expect(bindSlots('SELECT ?100, ?100')).toBe(100);
  const reused = read<[value: number], { n: number }>({ name: 'kernelTest.reused', sql: 'SELECT ?1 + ?1 AS n' });
  expect(() => reused.bind(2)).not.toThrow();
  expect(() => Reflect.apply(reused.bind, undefined, [])).toThrow('expected 1 slots');
  expect(() => Reflect.apply(reused.bind, undefined, [NaN])).toThrow('finite numbers');
  expect(() => read({ name: 'kernelTest.overflow', sql: 'SELECT ?101' })).toThrow('maximum is 100');
  expect(() => read({ name: 'kernelTest.zero', sql: 'SELECT ?0' })).toThrow('positive');
  expect(() => read({ name: 'kernelTest.bytes', sql: `SELECT '${'é'.repeat(MAX_SQL_BYTES / 2)}'` })).toThrow('UTF-8 bytes');
  expect(() => read({ name: 'kernelTest.rows', sql: 'SELECT 1' })).toThrow('duplicate statement name');
});

it('checks escaped wildcard-wrapped LIKE values in UTF-8 bytes without truncation', () => {
  expect(() => pattern.bind(containsPattern('é'.repeat(24)))).not.toThrow();
  expect(() => pattern.bind(containsPattern('é'.repeat(25)))).toThrow('52 UTF-8 bytes');
  expect(() => pattern.bind(containsPattern('%'.repeat(25)))).toThrow('52 UTF-8 bytes');
});

it('emits fixed names and available numeric metadata, without SQL, bindings or error text', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    const { db } = fixture();
    const d1Metadata: RelationalStore = {
      prepare: text => db.prepare(text),
      batch: async statements => (await db.batch(statements)).map(result => ({ ...result,
        meta: { ...result.meta, rows_read: 8, rows_written: 2, duration: 0.5, unsafe: 'private provider text' },
      })),
    };
    await commit(d1Metadata, insert.bind('private-binding', 5));
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ kind: 'db_batch', statements: [{ statement: 'kernelTest.insert', meta: { changes: 0, rows_read: 8, rows_written: 2, duration: 0.5 } }] });
    log.mockClear();
    await readSet(db, rows.bind());
    expect(JSON.parse(log.mock.calls[0]![0] as string).statements[0].meta).toEqual({ changes: 0 });
    log.mockClear();
    await expect(commit(db, insert.bind('a', 1))).rejects.toThrow();
    expect(log).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});
