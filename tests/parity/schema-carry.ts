import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import type { SchemaStep } from '@myco-server-worker/db/schema-step.js';
import { migrateOnly } from '@myco-server-worker/platform/bun/server-main.js';
import { applySteps, declaredSchemaObjects, upgradeSplit, type SchemaObject } from './schema-upgrade.ts';

/**
 * Carries a Deployment's rows from a store at the latest schema into a store at the last release's schema, naming no
 * table. What that schema cannot hold stays behind as a Deployment on the release never held it: tables and columns the
 * upgrade adds, rows the upgrade inserts itself, and (on a table the upgrade changes) rows the release's schema refuses,
 * with what references them, named in the boot log. Three things refuse the carry rather than let an upgrade pass
 * untested: a table the upgrade changes (its definition, indexes, triggers or rows) that the seed leaves empty, unless the
 * upgrade retires it; a row the release refuses on a table the upgrade does not change; and a release-only column on a
 * changed table that no step since the release declares it retires.
 */

const SEED = 'tests/parity/upgrade-seed/';
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const isRuntimeTable = (name: string): boolean => name.startsWith('sqlite_') || name.startsWith('_cf_') || name === 'd1_migrations';

interface Column { name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number }

function tables(db: Database, schema: string): Array<{ name: string; withoutRowid: boolean }> {
  return (db.query(`SELECT name, wr FROM pragma_table_list WHERE schema = ? AND type = 'table'`).all(schema) as Array<{ name: string; wr: number }>)
    .filter((row) => !isRuntimeTable(row.name)).map((row) => ({ name: row.name, withoutRowid: row.wr === 1 }));
}

function columns(db: Database, schema: string, table: string): Column[] {
  return (db.query(`SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?, ?)`).all(table, schema) as Column[])
    .filter((column) => column.hidden === 0);
}

const keysOf = (target: readonly Column[]): string[] => target.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);

/** A value of the column's type for a release-only column a carried row cannot fill. */
const placeholder = (column: Column): string => /INT|REAL|NUMERIC/i.test(column.type) ? '0' : "''";

/**
 * What the upgrade does to the release's store: the keys of rows it inserts into tables the release already holds, and
 * the steps that change each such table: its definition, indexes or triggers, or its rows, as the tables a statement
 * opens for writing (its program's OpenWrite root pages, mapped through sqlite_master).
 */
function upgradeEffects(previousFile: string, upgrade: readonly SchemaStep[]): { born: Map<string, string>; changedBy: Map<string, number[]> } {
  // A copy outside write-ahead mode, which a Wrangler-built file is in, so the probe never writes the file itself.
  const probe = `${previousFile}.upgrade-probe`;
  const file = new Database(previousFile);
  try { file.query('VACUUM INTO ?').run(probe); }
  finally { file.close(); }
  const db = new Database(probe);
  try {
    const shape = () => new Map((db.query(`SELECT tbl_name AS name, json_group_array(json_array(type, name, sql)) AS shape
      FROM (SELECT * FROM sqlite_master ORDER BY type, name) GROUP BY tbl_name`).all() as Array<{ name: string; shape: string }>).map((row) => [row.name, row.shape]));
    const released = tables(db, 'main');
    const keyed = released.map(({ name }) => ({ name, keys: keysOf(columns(db, 'main', name)) })).filter((table) => table.keys.length > 0);
    const keyRows = (table: string, keys: readonly string[]) => (db.query(`SELECT json_array(${keys.map(quote).join(', ')}) AS key FROM ${quote(table)}`).all() as Array<{ key: string }>).map((row) => row.key);
    const before = new Map(keyed.map((table) => [table.name, new Set(keyRows(table.name, table.keys))]));
    const changedBy = new Map<string, number[]>();
    const releasedNames = new Set(released.map((table) => table.name));
    const changed = (name: string, version: number) => {
      const versions = changedBy.get(name) ?? [];
      if (releasedNames.has(name) && !versions.includes(version)) changedBy.set(name, [...versions, version]);
    };
    // Each read is finalized at once: a statement left open would hold the step's transaction from committing.
    const once = <T,>(sql: string): T[] => {
      const prepared = db.prepare(sql);
      try { return prepared.all() as T[]; }
      finally { prepared.finalize(); }
    };
    const written = (statement: string): string[] => {
      let program: Array<{ opcode: string; p2: number }>;
      try { program = once(`EXPLAIN ${statement}`); }
      catch { return []; }
      const roots = new Map(once<{ rootpage: number; tbl_name: string }>('SELECT rootpage, tbl_name FROM sqlite_master WHERE rootpage > 0').map((row) => [row.rootpage, row.tbl_name]));
      return program.filter((op) => op.opcode === 'OpenWrite').flatMap((op) => roots.get(op.p2) ?? []);
    };
    for (const step of upgrade) {
      const prior = shape();
      applySteps(db, [step], { beforeStatement: (_, statement) => { for (const name of written(statement)) changed(name, step.version); } });
      const after = shape();
      for (const { name } of released) {
        if (prior.has(name) && prior.get(name) !== after.get(name)) changed(name, step.version);
      }
    }
    // Each row the upgrade inserts, by key, as the step leaves it: a source row identical to it is the step's to insert.
    const existing = new Set(tables(db, 'main').map((row) => row.name));
    const born = new Map<string, string>();
    for (const table of keyed) {
      if (!existing.has(table.name)) continue;
      const row = `json_array(${columns(db, 'main', table.name).map((column) => quote(column.name)).join(', ')})`;
      const added = (db.query(`SELECT json_group_object(json_array(${table.keys.map(quote).join(', ')}), json(${row})) AS rows, COUNT(*) AS n FROM ${quote(table.name)}
        WHERE json_array(${table.keys.map(quote).join(', ')}) NOT IN (SELECT value FROM json_each(?1))`).get(JSON.stringify([...before.get(table.name)!])) as { rows: string; n: number });
      if (added.n > 0) born.set(table.name, added.rows);
    }
    return { born, changedBy };
  } finally {
    db.close();
    fs.rmSync(probe, { force: true });
  }
}

const steps = (versions: readonly number[]): string => `schema step${versions.length === 1 ? '' : 's'} ${versions.join(', ')}`;

/** Carries every row of `source` (latest schema) into `previous` (the release's schema), or refuses with what to do next. */
export function carryToPreviousSchema(input: { source: string; previous: string; upgrade: readonly SchemaStep[] }): void {
  const { born, changedBy } = upgradeEffects(input.previous, input.upgrade);
  const db = new Database(input.previous);
  // The rows the seed's writers left in each table, whether or not the release's schema holds them all.
  const seeded = new Map<string, number>();
  const leftBehind: string[] = [];
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.query('ATTACH DATABASE ? AS source').run(input.source);
    // The source's derived rows are carried as they stand, so no trigger maintains them a second time.
    const triggers = db.query(`SELECT name, sql FROM main.sqlite_master WHERE type = 'trigger'`).all() as Array<{ name: string; sql: string }>;
    // What the Deployment created at runtime rather than from a step (the budget activation's indexes) is carried as it stands.
    const declared = declaredSchemaObjects();
    const runtime = (db.query(`SELECT type, name, sql FROM source.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
      AND name <> 'd1_migrations' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`).all() as SchemaObject[])
      .filter((object) => !declared.has(`${object.type}:${object.name}`));
    // The columns a step since the release declares it retires: their release values are the step's to drop.
    const retired = new Set(input.upgrade.flatMap((step) => step.retires ?? []).filter((item) => item.kind === 'column').map((item) => item.name));
    db.transaction(() => {
      for (const trigger of triggers) db.exec(`DROP TRIGGER main.${quote(trigger.name)}`);
      for (const object of runtime.filter((item) => item.type === 'table')) db.run(object.sql);
      const sourceTables = new Map(tables(db, 'source').map((table) => [table.name, table]));
      for (const table of tables(db, 'main')) {
        const source = sourceTables.get(table.name);
        if (source === undefined) { seeded.set(table.name, 0); continue; }
        const outcome = carryTable(db, { ...table, sourceRowid: !source.withoutRowid }, { born: born.get(table.name), changedBy: changedBy.get(table.name), retired });
        seeded.set(table.name, outcome.offered);
        for (const [constraint, count] of outcome.refused) leftBehind.push(`${table.name}: ${count} refused by ${constraint}`);
      }
      for (const object of runtime.filter((item) => item.type !== 'table')) db.run(object.sql);
      for (const trigger of triggers) db.run(trigger.sql);
    })();
    db.exec('DETACH DATABASE source');
    // External-content full-text indexes are rebuilt from the rows carried beneath them.
    const fullText = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%USING fts5(%'`).all() as Array<{ name: string }>;
    for (const { name } of fullText) db.run(`INSERT INTO ${quote(name)}(${quote(name)}) VALUES ('rebuild')`);
    // Rows the release's schema refused take what references them, as a Deployment on the release never held either.
    const dependents = new Map<string, number>();
    for (let pass = 0; ; pass += 1) {
      const orphans = db.query('PRAGMA foreign_key_check').all() as Array<{ table: string; rowid: number | null; parent: string }>;
      if (orphans.length === 0) break;
      if (leftBehind.length === 0 || pass > 16 || orphans.some((row) => row.rowid === null)) {
        const pairs = [...new Set(orphans.map((row) => `${row.table} → ${row.parent}`))];
        throw new Error(`rows carried to the release's schema reference rows it does not hold (${pairs.join(', ')}): the upgrade inserts those parents itself, so seed the children through a route that creates their parents in ${SEED}`);
      }
      for (const row of orphans) {
        db.query(`DELETE FROM ${quote(row.table)} WHERE rowid = ?1`).run(row.rowid);
        dependents.set(row.table, (dependents.get(row.table) ?? 0) + 1);
      }
    }
    if (leftBehind.length > 0) {
      console.info(`upgrade carry: rows the release's schema refuses, on tables the upgrade changes, are left behind: ${leftBehind.join('; ')}`
        + (dependents.size === 0 ? '' : `; with their dependents: ${[...dependents].map(([table, count]) => `${table}: ${count}`).join('; ')}`));
    }
  } finally { db.close(); }
  // A table a step since the release retires holds nothing to seed.
  const retiredTables = new Set(input.upgrade.flatMap((step) => step.retires ?? []).filter((item) => item.kind === 'table').map((item) => item.name));
  const empty = [...changedBy].filter(([table]) => !retiredTables.has(table) && (seeded.get(table) ?? 0) === 0);
  if (empty.length > 0) {
    throw new Error(empty.map(([table, versions]) => `${steps(versions)} change${versions.length === 1 ? 's' : ''} ${table}, which the upgrade seed leaves empty`).join('; ')
      + `: seed ${empty.length === 1 ? 'it' : 'each'} through its route in ${SEED} so the upgrade runs over its rows`);
  }
}

/** Carries one table's rows, answering how many the source offered and, on a table the upgrade changes, how many each constraint refused. */
function carryTable(db: Database, table: { name: string; withoutRowid: boolean; sourceRowid: boolean }, upgrade: { born?: string; changedBy?: number[]; retired: ReadonlySet<string> }): { offered: number; refused: Map<string, number> } {
  const refused = new Map<string, number>();
  const target = columns(db, 'main', table.name);
  const sourceOrder = columns(db, 'source', table.name).map((column) => column.name);
  const sourceColumns = new Set(sourceOrder);
  const shared = target.filter((column) => sourceColumns.has(column.name)).map((column) => column.name);
  const releaseOnly = target.filter((column) => !sourceColumns.has(column.name));
  const unfilled = releaseOnly.filter((column) => column.notnull === 1 && column.dflt_value === null);
  const keys = keysOf(target);
  const keyed = keys.length > 0 && keys.every((key) => sourceColumns.has(key));
  const sourceKey = `json_array(${keys.map(quote).join(', ')})`;
  const conditions = [
    // A row the upgrade inserts itself, unchanged since, is left to it; a row the writers changed is carried for it to meet.
    ...(keyed && upgrade.born !== undefined ? [`NOT EXISTS (SELECT 1 FROM json_each(?1) WHERE key = ${sourceKey} AND value = json_array(${sourceOrder.map(quote).join(', ')}))`] : []),
    // The store's version is the release's until the upgrade stamps its own.
    ...(table.name === 'schema_meta' ? [`"key" <> 'version'`] : []),
  ];
  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  const args = keyed && upgrade.born !== undefined ? [upgrade.born] : [];
  const from = `source.${quote(table.name)}${where}`;
  const offered = (db.query(`SELECT COUNT(*) AS n FROM ${from}`).get(...args) as { n: number }).n;
  if (offered === 0) return { offered, refused };
  const held = (db.query(`SELECT COUNT(*) AS n FROM main.${quote(table.name)}`).get() as { n: number }).n;
  const matched = keyed && held > 0
    ? (db.query(`SELECT COUNT(*) AS n FROM ${from}${where === '' ? ' WHERE' : ' AND'} ${sourceKey} IN (SELECT ${sourceKey} FROM main.${quote(table.name)})`).get(...args) as { n: number }).n : 0;
  const undeclared = releaseOnly.map((column) => `${table.name}.${column.name}`).filter((name) => !upgrade.retired.has(name));
  if (upgrade.changedBy !== undefined && undeclared.length > 0 && offered > matched) {
    throw new Error(`${steps(upgrade.changedBy)} change${upgrade.changedBy.length === 1 ? 's' : ''} ${table.name} and leave${upgrade.changedBy.length === 1 ? 's' : ''} the release's ${undeclared.join(', ')} behind undeclared, `
      + `which a carried row can only fill with defaults: declare each in the dropping step's retires ({ kind: 'column', name: 'table.column', reason }). `
      + `A step that moves data out of a column before dropping it also keeps its own unit test, seeded at the release's shape beside the step`);
  }
  // A rowid table keeps its rowids, which cursors and full-text indexes name rows by, when its source has rowids and the release's own rows hold none.
  const rowidAlias = keys.length === 1 && /^INTEGER$/i.test(target.find((column) => column.name === keys[0])!.type);
  const rowid = !table.withoutRowid && table.sourceRowid && !rowidAlias && held === 0;
  const names = [...(rowid ? ['rowid'] : []), ...shared.map(quote), ...unfilled.map((column) => quote(column.name))];
  const values = [...(rowid ? ['rowid'] : []), ...shared.map(quote), ...unfilled.map(placeholder)];
  // A row the release's own steps already hold takes the Deployment's value.
  const upsert = keyed && held > 0 && shared.some((name) => !keys.includes(name))
    ? ` ON CONFLICT(${keys.map(quote).join(', ')}) DO UPDATE SET ${shared.filter((name) => !keys.includes(name)).map((name) => `${quote(name)} = excluded.${quote(name)}`).join(', ')}`
    : keyed && held > 0 ? ' ON CONFLICT DO NOTHING' : '';
  const insert = (filter: string) => `INSERT INTO main.${quote(table.name)} (${names.join(', ')}) SELECT ${values.join(', ')} FROM ${from}${filter}${upsert}`;
  try {
    db.query(insert(where === '' ? ' WHERE true' : '')).run(...args);
    return { offered, refused };
  } catch (error) {
    // On a table no step since the release changes, the release accepts what the latest writers write, so a refusal
    // means the carry or the seed is wrong.
    const row = keyed ? sourceKey : table.sourceRowid ? 'rowid' : null;
    if (upgrade.changedBy === undefined || row === null) {
      throw new Error(`the release's schema refuses a row of ${table.name} the latest writers wrote (${(error as Error).message}), on a table no step since the release changes: the carry or the upgrade seed is wrong`, { cause: error });
    }
  }
  // A step since the release changes the table (a value it renames, a range it widens): each row the release's schema
  // refuses stays behind, as a Deployment on the release never held it.
  const slot = args.length + 1;
  const ids = (db.query(`SELECT ${keyed ? sourceKey : 'rowid'} AS id FROM ${from}`).all(...args) as Array<{ id: unknown }>).map((item) => item.id);
  for (const id of ids) {
    try {
      db.query(insert(`${where === '' ? ' WHERE' : ' AND'} ${keyed ? sourceKey : 'rowid'} = ?${slot}`)).run(...args, id as string | number);
    } catch (error) {
      const constraint = (error as Error).message;
      refused.set(constraint, (refused.get(constraint) ?? 0) + 1);
    }
  }
  return { offered, refused };
}

/**
 * Builds a native store at the last release's schema beside `databaseFile`, carries its rows in, and upgrades it with
 * the self-hosted migrator (every later step in its own transaction, then budget completion) before putting it in place.
 */
export function upgradeNativeStore(databaseFile: string): void {
  const { previous, upgrade } = upgradeSplit();
  const previousFile = `${databaseFile}.previous`;
  const db = new Database(previousFile);
  try { applySteps(db, previous); }
  finally { db.close(); }
  carryToPreviousSchema({ source: databaseFile, previous: previousFile, upgrade });
  migrateOnly(previousFile);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${databaseFile}${suffix}`, { force: true });
  fs.renameSync(previousFile, databaseFile);
}
