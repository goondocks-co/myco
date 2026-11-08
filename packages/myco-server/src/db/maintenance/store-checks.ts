/**
 * The supported store operations of hosted maintenance, and the integrity walk built from them.
 *
 * `quick_check` runs one table at a time in bounded batches. `foreign_key_check` stays one whole-store statement: it has
 * no bounded form, so the walk counts it as one statement under the platform's own limit.
 */
import type { RelationalStore } from '../../core/adapters.js';
import type { MaintenanceProgress } from '../../core/store-maintenance.js';
import { commit, read, readSet, write } from '../index.js';
import { findingCollector, type BoundedFindings } from './findings.js';

/** The tables a quick check covers: every ordinary table, without the engine's and platform's own. */
export const CHECKED_TABLES_SQL = `SELECT name FROM sqlite_schema WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'
  AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`;
/** One table's quick check. */
export const quickCheckSql = (table: string): string => `PRAGMA quick_check('${table.replaceAll("'", "''")}')`;

const tables = read<[], { name: string }>({ name: 'maintenance.checkedTables', sql: CHECKED_TABLES_SQL });
const optimize = write<[], unknown>({ name: 'maintenance.optimizeStore', sql: 'PRAGMA optimize' });
const quick = read<[table: string], { quick_check: string }>({ name: 'maintenance.quickCheckTable', sql:
  'SELECT quick_check FROM pragma_quick_check(?)' });
const foreign = write<[], { table: string; rowid: number | null; parent: string }>({ name: 'maintenance.foreignKeyCheck', sql: 'PRAGMA foreign_key_check' });
const sizeOf = (meta: object) => (meta as { size_after?: number }).size_after;

export const QUICK_CHECK_BATCH = 16;
export const TABLE_DISCOVERY_STATEMENTS = 1;
const FOREIGN_KEY_STATEMENTS = 1;

/** Runs the planner's own upkeep and answers the store's size afterwards. */
export async function optimizeStore(db: RelationalStore): Promise<number | undefined> {
  const [result] = await commit(db, optimize.bind());
  return sizeOf(result.meta);
}

/** A walk stopped by a failure, with the problems it had already found. Tables it did not reach were not checked. */
export class IntegrityWalkInterrupted extends Error {
  constructor(readonly found: BoundedFindings, cause: unknown) {
    super('the integrity walk stopped before it covered every table', { cause });
    this.name = 'IntegrityWalkInterrupted';
  }
}

/**
 * Discovers the tables, checks them in bounded batches and ends with the whole-store foreign key check. After every
 * step it hands over the actual counts and everything found so far, so a run that stops keeps what it had established.
 */
export async function walkStoreIntegrity(
  db: RelationalStore, progress?: (value: MaintenanceProgress, found: BoundedFindings) => Promise<void>,
): Promise<BoundedFindings & { size: number | undefined }> {
  const found = findingCollector();
  try {
    const [rows] = await readSet(db, tables.bind());
    const names = rows.map(row => row.name);
    const totalStatements = names.length + TABLE_DISCOVERY_STATEMENTS + FOREIGN_KEY_STATEMENTS;
    const report = (completedTables: number, completedStatements: number) => progress?.({
      completedTables, totalTables: names.length, completedStatements, totalStatements,
      remainingBatches: Math.ceil((names.length - completedTables) / QUICK_CHECK_BATCH),
    }, found.snapshot());
    await report(0, TABLE_DISCOVERY_STATEMENTS);
    for (let at = 0; at < names.length; at += QUICK_CHECK_BATCH) {
      const page = names.slice(at, at + QUICK_CHECK_BATCH);
      const checked = await readSet(db, ...page.map(table => quick.bind(table)));
      found.add(checked.flatMap(problems => problems.map(row => row.quick_check)).filter(text => text !== 'ok'));
      await report(at + page.length, TABLE_DISCOVERY_STATEMENTS + at + page.length);
    }
    const [keys] = await commit(db, foreign.bind());
    found.add(keys.results.map(row => `foreign key: ${row.table} row ${row.rowid} names a missing ${row.parent}`));
    await report(names.length, totalStatements);
    return { ...found.snapshot(), size: sizeOf(keys.meta) };
  } catch (error) {
    throw new IntegrityWalkInterrupted(found.snapshot(), error);
  }
}
