import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { assertion, commit, commitNamed, first, read, refusalCode, refusalDetail, refused, rows, write, type RefusalCode } from '@myco-server-worker/db/index.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import * as telemetry from '@myco-server-worker/telemetry.js';

interface Item { id: string; n: number }

const STALE = refusalCode('kernel_test_stale');
const STALE_MORE = refusalCode('kernel_test_stale_more');
const FULL = refusalCode('kernel_test_full');

const insert = write<[id: string, n: number], Item>({ name: 'kernelStores.insert', sql: 'INSERT INTO items(id,n) VALUES(?1,?2) RETURNING id,n' });
const bump = write<[id: string], { n: number }>({ name: 'kernelStores.bump', sql: 'UPDATE items SET n=n+1 WHERE id=?1 RETURNING n' });
const quiet = write<[id: string, n: number]>({ name: 'kernelStores.quiet', sql: 'UPDATE items SET n=?2 WHERE id=?1' });
const FAIL_CLOSED = [
  { guard: assertion<[]>({ name: 'kernelStores.nullDetail', when: '0', refusal: STALE, detail: "(SELECT id FROM items WHERE 0)" }), detail: '' },
  { guard: assertion<[]>({ name: 'kernelStores.oddDetail', when: '0', refusal: STALE, detail: "'a]b''c'" }), detail: 'abc' },
  { guard: assertion<[]>({ name: 'kernelStores.emptySource', when: '1', refusal: STALE, from: 'items WHERE 0' }), detail: '' },
];
const one = read<[id: string], Item>({ name: 'kernelStores.one', sql: 'SELECT id,n FROM items WHERE id=?1' });
const all = read<[], Item>({ name: 'kernelStores.all', sql: 'SELECT id,n FROM items ORDER BY id' });
const present = assertion<[id: string]>({ name: 'kernelStores.present', refusal: STALE, when: 'EXISTS(SELECT 1 FROM items WHERE id=?1)' });
const room = assertion<[limit: number]>({ name: 'kernelStores.room', refusal: FULL, detail: '(SELECT COUNT(*) FROM items)', when: '(SELECT COUNT(*) FROM items)<?1' });
const inputs = assertion<[input: string]>({
  name: 'kernelStores.inputs', refusal: STALE, with: "WITH i AS (SELECT json_extract(?1,'$.id') AS id)", from: 'i', when: 'EXISTS(SELECT 1 FROM items WHERE items.id=i.id)',
});
const overLimit = write<[id: string]>({ name: 'kernelStores.overLimit', sql: 'INSERT INTO items(id,n) VALUES(?1,99)' });

const DDL = ['CREATE TABLE items(id TEXT PRIMARY KEY,n INTEGER NOT NULL CHECK(n<50))'];
const stores: [string, RelationalStore][] = [];
let mf: Miniflare;
let native: Database;

beforeAll(async () => {
  native = new Database(':memory:');
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
  stores.push(['native', sqliteRelationalStore(native)], ['D1', await mf.getD1Database('DB')]);
  for (const [, db] of stores) await db.batch(DDL.map(sql => db.prepare(sql)));
});
afterAll(async () => { native.close(); await mf.dispose(); });

async function reset(db: RelationalStore) {
  await db.batch([db.prepare('DELETE FROM items'), db.prepare("INSERT INTO items VALUES('a',1)")]);
}
const failure = async (work: Promise<unknown>): Promise<unknown> => work.then(() => { throw new Error('expected the batch to fail'); }, error => error);

describe.each([['native'], ['D1']])('kernel executors on %s', target => {
  const store = () => stores.find(([name]) => name === target)![1];

  it('answers one row or null, and every row, for reads and for writes with RETURNING', async () => {
    const db = store();
    await reset(db);
    const row: Item | null = await first(db, one.bind('a'));
    expect(row).toEqual({ id: 'a', n: 1 });
    expect(await first(db, one.bind('absent'))).toBeNull();
    expect(await first(db, bump.bind('a'))).toEqual({ n: 2 });
    expect(await first(db, bump.bind('absent'))).toBeNull();
    const listed: Item[] = await rows(db, all.bind());
    expect(listed).toEqual([{ id: 'a', n: 2 }]);
    expect(await rows(db, insert.bind('b', 7))).toEqual([{ id: 'b', n: 7 }]);
  });

  it('keeps results under their keys when a statement is added ahead of them', async () => {
    const db = store();
    await reset(db);
    const before = await commitNamed(db, { minted: insert.bind('b', 2), raised: bump.bind('a') });
    const minted: Item[] = before.minted.results;
    const raised: { n: number }[] = before.raised.results;
    expect(minted).toEqual([{ id: 'b', n: 2 }]);
    expect(raised).toEqual([{ n: 2 }]);

    await reset(db);
    const after = await commitNamed(db, { guard: present.bind('a'), first: quiet.bind('a', 5), minted: insert.bind('b', 2), raised: bump.bind('a') });
    expect(after.minted.results).toEqual([{ id: 'b', n: 2 }]);
    expect(after.raised.results).toEqual([{ n: 6 }]);
  });

  it('runs a list key in place and answers its results as a list, so an empty list shifts nothing', async () => {
    const db = store();
    await reset(db);
    const full = await commitNamed(db, { guards: [present.bind('a'), inputs.bind('{"id":"a"}')], minted: insert.bind('b', 2), companions: [insert.bind('c', 3), bump.bind('a')] });
    expect(full.minted.results).toEqual([{ id: 'b', n: 2 }]);
    expect(full.companions.map(result => result.results)).toEqual([[{ id: 'c', n: 3 }], [{ n: 2 }]]);
    expect(full.guards).toHaveLength(2);

    await reset(db);
    const empty = await commitNamed(db, { guards: [], minted: insert.bind('b', 2), companions: [] });
    expect(empty.minted.results).toEqual([{ id: 'b', n: 2 }]);
    expect([empty.guards, empty.companions]).toEqual([[], []]);
  });

  it('rolls back the whole batch on a refusal and identifies it', async () => {
    const db = store();
    await reset(db);
    const error = await failure(commitNamed(db, { minted: insert.bind('b', 2), raised: bump.bind('a'), guard: present.bind('absent'), late: insert.bind('c', 3) }));
    expect(refused(error, STALE)).toBe(true);
    expect(await rows(db, all.bind())).toEqual([{ id: 'a', n: 1 }]);
  });

  it('identifies a refusal raised through shared inputs, and reports its detail', async () => {
    const db = store();
    await reset(db);
    expect(refused(await failure(commit(db, inputs.bind('{"id":"absent"}'))), STALE)).toBe(true);
    await commit(db, inputs.bind('{"id":"a"}'));
    const full = await failure(commit(db, insert.bind('b', 2), room.bind(1)));
    expect(refusalDetail(full, FULL)).toBe('2');
    expect(refused(full, FULL)).toBe(true);
    expect(refusalDetail(full, STALE)).toBeNull();
    expect(await rows(db, all.bind())).toEqual([{ id: 'a', n: 1 }]);
  });

  it('refuses when a reported detail is NULL or holds path characters, or when the row source is empty', async () => {
    const db = store();
    await reset(db);
    for (const { guard, detail } of FAIL_CLOSED) {
      const error = await failure(commit(db, insert.bind('held', 1), guard.bind()));
      expect(refused(error, STALE)).toBe(true);
      expect(refusalDetail(error, STALE)).toBe(detail);
      expect(await first(db, one.bind('held'))).toBeNull();
    }
  });

  it('does not take another refusal or an unrelated failure for this refusal', async () => {
    const db = store();
    await reset(db);
    const stale = await failure(commit(db, present.bind('absent')));
    expect(refused(stale, STALE)).toBe(true);
    expect(refused(stale, STALE_MORE)).toBe(false);
    expect(refused(stale, FULL)).toBe(false);

    const constraint = await failure(commit(db, overLimit.bind('b')));
    expect(refused(constraint, STALE)).toBe(false);
    expect(await rows(db, all.bind())).toEqual([{ id: 'a', n: 1 }]);
    await db.batch([db.prepare('DROP TABLE IF EXISTS kernel_test_stale'), db.prepare('DROP TRIGGER IF EXISTS kernel_raises')]);
    await db.batch([db.prepare("CREATE TRIGGER kernel_raises BEFORE INSERT ON items WHEN NEW.id='raised' BEGIN SELECT RAISE(ABORT,'kernel_test_stale'); END")]);
    try {
      const raised = await failure(commit(db, insert.bind('raised', 1)));
      expect((raised as Error).message).toContain('kernel_test_stale');
      expect(refused(raised, STALE)).toBe(false);
    } finally { await db.batch([db.prepare('DROP TRIGGER kernel_raises')]); }
    const missing = await failure(db.batch([db.prepare('SELECT * FROM kernel_test_stale')]));
    expect((missing as Error).message).toContain('kernel_test_stale');
    expect(refused(missing, STALE)).toBe(false);
  });

  it('names every statement of a keyed commit in telemetry', async () => {
    const db = store();
    await reset(db);
    const emit = spyOn(telemetry, 'emit');
    try {
      await commitNamed(db, { guard: present.bind('a'), raised: bump.bind('a') });
      await first(db, one.bind('a'));
      const named = emit.mock.calls.flatMap(([event]) => event.kind === 'db_batch' ? [(event.statements as { statement: string }[]).map(item => item.statement)] : []);
      expect(named).toEqual([['kernelStores.present', 'kernelStores.bump'], ['kernelStores.one']]);
    } finally { emit.mockRestore(); }
  });
});

describe('refusal identity', () => {
  it('finds a refusal reported only through cause, and stops at a cause cycle', () => {
    const wrapped = new Error('request failed', { cause: new Error('D1_ERROR', { cause: new Error("bad JSON path: '$[kernel_test_stale]': SQLITE_ERROR") }) });
    expect(refused(wrapped, STALE)).toBe(true);
    const cycle = new Error('outer') as Error & { cause: unknown };
    cycle.cause = cycle;
    expect(refused(cycle, STALE)).toBe(false);
    expect(refused('kernel_test_stale', STALE)).toBe(false);
    expect(refused(null, STALE)).toBe(false);
  });

  it('recognises the older SQLite wording of the same report', () => {
    expect(refused(new Error("D1_ERROR: JSON path error near '[kernel_test_stale]': SQLITE_ERROR"), STALE)).toBe(true);
    expect(refusalDetail(new Error("JSON path error near '[kernel_test_full:12]'"), FULL)).toBe('12');
  });

  it('accepts only codes made by refusalCode, in a safe form', () => {
    expect(() => refusalCode("bad]'code")).toThrow('refusal code must match');
    expect(() => refusalCode('Upper')).toThrow('refusal code must match');
    if (false) {
      // @ts-expect-error A bare string is not a refusal code, so a matcher cannot drift from its assertion.
      refused(new Error('x'), 'kernel_test_stale');
      // @ts-expect-error An assertion names its refusal with a code.
      assertion({ name: 'kernelStores.typed', when: '1', refusal: 'kernel_test_stale' });
      const code: RefusalCode<'kernel_test_stale'> = STALE;
      void code;
    }
  });

  it('refuses an integer key, which would run the batch out of written order', async () => {
    const db = sqliteRelationalStore(new Database(':memory:'));
    await expect(commitNamed(db, { 2: quiet.bind('a', 1), 1: quiet.bind('a', 2) })).rejects.toThrow('commitNamed key 1 is an integer');
    expect(await commitNamed(db, {})).toEqual({});
  });
});
