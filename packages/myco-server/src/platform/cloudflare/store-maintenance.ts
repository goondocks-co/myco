/**
 * Store maintenance on the hosted target: the checks D1 documents, and the measurements its binding reports.
 *
 * D1 documents `PRAGMA optimize`, `PRAGMA quick_check` and `PRAGMA foreign_key_check`
 * (https://developers.cloudflare.com/d1/sql-api/sql-statements/); it refuses `integrity_check` and `page_count`
 * with `SQLITE_AUTH`, so neither is issued. Every result carries `meta.size_after`, the database's size in bytes
 * (https://developers.cloudflare.com/d1/worker-api/return-object/).
 *
 * The plan's size limit and the account's daily row usage are not readable through the binding: the limits are
 * per plan (https://developers.cloudflare.com/d1/platform/limits/), and usage is reported only by the account's
 * analytics (https://developers.cloudflare.com/d1/observability/metrics-analytics/). Both are reported as
 * unavailable. When a limit is actually reached, D1 refuses the query in documented words, which
 * `classifyD1Error` names.
 *
 * A D1 statement cannot be cancelled once sent, so the check sets no timer of its own. D1 ends every query
 * within 30 seconds (https://developers.cloudflare.com/d1/platform/limits/). Discovery counts every table check;
 * each bounded batch reports progress and renews the claim before sending the next batch.
 *
 * `quick_check` runs one table at a time, the checks of ordinary tables sent in bounded batches: a single
 * whole-database `quick_check` compiles every table's constraints into one program, which D1 refuses with
 * `SQLITE_NOMEM` once the schema's constraints outgrow its program limit. Each table reports at most 100 problems by
 * SQLite's own default. `foreign_key_check` has no documented
 * bounded form on D1, and D1 refuses at commit any write that would leave a foreign key dangling, so rows reach
 * it only from a store that arrived damaged.
 */
import type { MaintenanceCheck, PortResult, StoreMaintenancePort, StoreMeasurement } from '../../core/store-maintenance.js';

/** D1's maximum SQL query duration. */
export const D1_QUERY_LIMIT_MS = 30_000;
const TABLE_DISCOVERY_STATEMENTS = 1;
const FOREIGN_KEY_STATEMENTS = 1;
/** Initial statements before the check discovers and records its full work budget. */
export const D1_INITIAL_STATEMENTS: Readonly<Record<MaintenanceCheck, number>> = { optimize: 1, integrity: TABLE_DISCOVERY_STATEMENTS + MAINTENANCE_PROGRESS_STATEMENTS };

export { CHECKED_TABLES_SQL, quickCheckSql } from '../../db/meta/store-checks.js';
import { checkStoreTables, optimizeStore, checkedTables, checkForeignKeys } from '../../db/meta/store-checks.js';
import type { RelationalStore } from '../../core/adapters.js';
import { MAINTENANCE_PROGRESS_STATEMENTS } from '../../core/store-maintenance.js';
import type { MaintenanceProgress } from '../../core/store-maintenance.js';

export const QUICK_CHECK_BATCH = 16;
export const SIZE_LIMIT_UNAVAILABLE =
  'the plan\'s database size limit is not readable from the Worker (500 MB on Workers Free, 10 GB on Workers Paid)';
export const DAILY_QUOTA_UNAVAILABLE =
  'daily row reads and writes are reported only by Cloudflare\'s account analytics, which this server does not read';

function measurements(sizeAfter: number | undefined): StoreMeasurement[] {
  return [
    sizeAfter === undefined
      ? { name: 'size', state: 'unavailable', reason: 'D1 reported no size for this query' }
      : { name: 'size', state: 'measured', value: sizeAfter, unit: 'bytes' },
    { name: 'size_limit', state: 'unavailable', reason: SIZE_LIMIT_UNAVAILABLE },
    { name: 'daily_quota', state: 'unavailable', reason: DAILY_QUOTA_UNAVAILABLE },
  ];
}


export function d1StoreMaintenance(db: RelationalStore): StoreMaintenancePort {
  const run = async (check: MaintenanceCheck, progress?: (value: MaintenanceProgress) => Promise<void>): Promise<PortResult> => {
    if (check === 'optimize') {
      const optimized = await optimizeStore(db);
      return { findings: [], measurements: measurements(optimized) };
    }
    const tables = await checkedTables(db);
    const total = tables.length + TABLE_DISCOVERY_STATEMENTS + FOREIGN_KEY_STATEMENTS;
    const report = (completedStatements: number) => progress?.({
      completedStatements, totalStatements: total,
      completedTables: Math.min(tables.length,completedStatements-TABLE_DISCOVERY_STATEMENTS), totalTables: tables.length,
      remainingBatches: Math.ceil(Math.max(0,tables.length-(completedStatements-TABLE_DISCOVERY_STATEMENTS))/QUICK_CHECK_BATCH),
    });
    await report(TABLE_DISCOVERY_STATEMENTS);
    const findings: string[] = [];
    for (let at=0; at<tables.length; at+=QUICK_CHECK_BATCH) {
      const page = tables.slice(at,at+QUICK_CHECK_BATCH);
      findings.push(...await checkStoreTables(db,page));
      await report(TABLE_DISCOVERY_STATEMENTS+at+page.length);
    }
    const keys = await checkForeignKeys(db);
    findings.push(...keys.findings);
    await report(total);
    return { findings, measurements: measurements(keys.size) };
  };
  return {
    support: {
      optimize: { supported: true, label: 'Refreshes the statistics queries are planned from' },
      integrity: { supported: true, label: 'A quick check of every table and index, and of every link between records' },
    },
    exclusivity: { kind: 'platform-limit', statementLimitMs: D1_QUERY_LIMIT_MS, statements: D1_INITIAL_STATEMENTS },
    run,
  };
}
