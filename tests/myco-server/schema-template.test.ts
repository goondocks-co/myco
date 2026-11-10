import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { RESTAMPED_CELLS, replaySchema, schemaD1Root, schemaSqlite } from './helpers/schema-template.js';

type Row = Record<string, unknown>;
interface Snapshot { master: Row[]; rows: Record<string, string[]>; restamped: Record<string, unknown> }

/** Everything a database holds: its schema objects, every row of every table, and the cells a replay stamps afresh. */
async function snapshot(db: RelationalStore): Promise<Snapshot> {
  const master = (await db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type, name`).all<Row>()).results;
  const restamped: Record<string, unknown> = {};
  const rows: Record<string, string[]> = {};
  for (const { name } of master.filter((entry) => entry.type === 'table') as Array<{ name: string }>) {
    const tableRows = (await db.prepare(`SELECT * FROM "${name}"`).all<Row>()).results;
    rows[name] = tableRows.map((row) => {
      const kept = { ...row };
      for (const cell of RESTAMPED_CELLS) {
        if (cell.table !== name) continue;
        if ('key' in cell && kept.key === cell.key) { restamped[cell.key] = kept.value; kept.value = '<restamped>'; }
        if ('column' in cell) { restamped[`${name}.${cell.column}`] = kept[cell.column]; kept[cell.column] = '<restamped>'; }
      }
      return JSON.stringify(kept);
    }).sort();
  }
  return { master, rows, restamped };
}

/** The restamped cells hold what a replay between `from` and `to` draws: a random id and that window's instants. */
function expectFresh(restamped: Record<string, unknown>, from: number, to: number) {
  expect(Object.keys(restamped).sort()).toEqual(RESTAMPED_CELLS.map((cell) => 'key' in cell ? cell.key : `${cell.table}.${cell.column}`).sort());
  expect(restamped.deployment_id).toMatch(/^[0-9a-f]{32}$/);
  for (const key of ['ledger_enabled_at', 'guard_enabled_at']) {
    expect(Number(restamped[key])).toBeGreaterThanOrEqual(from);
    expect(Number(restamped[key])).toBeLessThanOrEqual(to);
  }
  const armed = Number(restamped['object_store_reconciliation.armed_at']);
  expect(armed).toBeGreaterThanOrEqual((Math.floor(from / 1000) + 1) * 1000);
  expect(armed).toBeLessThanOrEqual((Math.floor(to / 1000) + 1) * 1000);
}

/**
 * Builds the template, waits past a second boundary, then copies and replays. Every clock-stamped cell the template
 * holds is then older than the copy's window and the replay's, so a cell a copy does not draw again fails either the
 * freshness check or the comparison with the replay, at millisecond and at second granularity.
 */
async function compare(warm: () => Promise<void>, copy: () => Promise<RelationalStore>, replay: () => Promise<RelationalStore>) {
  await warm();
  await Bun.sleep(1_100);
  const copiedFrom = Date.now();
  const copied = await snapshot(await copy());
  const copiedTo = Date.now();
  const replayedFrom = Date.now();
  const replayed = await snapshot(await replay());
  const replayedTo = Date.now();
  expectFresh(copied.restamped, copiedFrom, copiedTo);
  expectFresh(replayed.restamped, replayedFrom, replayedTo);
  expect(copied.master).toEqual(replayed.master);
  const differing = Object.keys({ ...copied.rows, ...replayed.rows })
    .filter((table) => JSON.stringify(copied.rows[table]) !== JSON.stringify(replayed.rows[table]));
  if (differing.length > 0) throw new Error(`template copy and replay hold different rows in ${differing.join(', ')}: `
    + 'a schema step stamps a clock or random value: add the cell to RESTAMPED_CELLS and its expression to RESTAMP_SQL in helpers/schema-template.ts');
  expect(copied.rows).toEqual(replayed.rows);
  return copied;
}

describe('schema template copies equal a full replay', () => {
  it('native SQLite: objects, seeded rows and schema_meta match, and each copy is a Deployment of its own', async () => {
    const opened: Database[] = [];
    try {
      const copied = await compare(async () => { schemaSqlite().close(); }, async () => {
        const sqlite = schemaSqlite();
        opened.push(sqlite);
        expect(sqlite.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
        return sqliteRelationalStore(sqlite);
      }, async () => {
        const sqlite = new Database(':memory:');
        opened.push(sqlite);
        sqlite.exec('PRAGMA foreign_keys = ON');
        const db = sqliteRelationalStore(sqlite);
        await replaySchema(db);
        return db;
      });
      const second = schemaSqlite();
      opened.push(second);
      second.exec("INSERT INTO projects(project_id,name,created_at) VALUES('private','private',1)");
      expect((await snapshot(sqliteRelationalStore(second))).restamped.deployment_id).not.toBe(copied.restamped.deployment_id);
      expect(opened[0]!.query("SELECT COUNT(*) AS n FROM projects WHERE project_id='private'").get()).toEqual({ n: 0 });
    } finally { for (const sqlite of opened) sqlite.close(); }
  }, 60_000);

  it('D1 through Miniflare: objects, seeded rows and schema_meta match, and each copy is a Deployment of its own', async () => {
    const worker = { modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-08-01' };
    let copy: Miniflare | null = null;
    const replay = new Miniflare(convertV4MiniflareOptions({ ...worker, d1Databases: ['DB'] }));
    try {
      const copied = await compare(async () => { await schemaD1Root(); }, async () => {
        copy = new Miniflare(convertV4MiniflareOptions({ ...worker, d1Databases: ['DB', 'OTHER'], resourcePersistencePath: await schemaD1Root(['DB', 'OTHER']) }));
        return await copy.getD1Database('DB') as unknown as RelationalStore;
      }, async () => {
        const db = await replay.getD1Database('DB') as unknown as RelationalStore;
        await replaySchema(db);
        return db;
      });
      const other = await copy!.getD1Database('OTHER') as unknown as RelationalStore;
      await other.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('private','private',1)").run();
      expect((await snapshot(other)).restamped.deployment_id).not.toBe(copied.restamped.deployment_id);
      const db = await copy!.getD1Database('DB') as unknown as RelationalStore;
      expect(await db.prepare("SELECT COUNT(*) AS n FROM projects WHERE project_id='private'").first()).toEqual({ n: 0 });
    } finally { await (copy as Miniflare | null)?.dispose(); await replay.dispose(); }
  }, 120_000);
});
