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
 * A D1 statement cannot be cancelled once sent: a timer that gave up on it would release the claim while the
 * statement still ran. The check therefore sets no timer. Each statement is bounded by D1's own per-query
 * limits, and the claim is held for the longest invocation that can carry it.
 */
import type { MaintenanceCheck, PortResult, StoreMaintenancePort, StoreMeasurement } from '../../core/store-maintenance.js';

/** The D1 binding as the product types it; D1 attaches `meta.size_after` to every result it returns. */
interface D1Like {
  prepare(sql: string): { all<T>(): Promise<{ results: T[]; meta?: { size_after?: number } }> };
}

/**
 * How long a hosted claim stays exclusive: the longest a Worker invocation that runs a check may live — an alarm
 * or scheduled wake is limited to fifteen minutes of wall time — with margin. A claim whose invocation died is
 * free again after it.
 */
export const HOSTED_CLAIM_MS = 20 * 60_000;

export const SIZE_LIMIT_UNAVAILABLE =
  'the plan\'s database size limit is not readable from the Worker (500 MB on Workers Free, 10 GB on Workers Paid)';
export const DAILY_QUOTA_UNAVAILABLE =
  'daily row reads and writes are reported only by Cloudflare\'s account analytics, which this Deployment does not read';

function measurements(sizeAfter: number | undefined): StoreMeasurement[] {
  return [
    sizeAfter === undefined
      ? { name: 'size', state: 'unavailable', reason: 'D1 reported no size for this query' }
      : { name: 'size', state: 'measured', value: sizeAfter, unit: 'bytes' },
    { name: 'size_limit', state: 'unavailable', reason: SIZE_LIMIT_UNAVAILABLE },
    { name: 'daily_quota', state: 'unavailable', reason: DAILY_QUOTA_UNAVAILABLE },
  ];
}

interface ForeignKeyRow { table: string; rowid: number | null; parent: string }

export function d1StoreMaintenance(db: D1Like): StoreMaintenancePort {
  const run = async (check: MaintenanceCheck): Promise<PortResult> => {
    if (check === 'optimize') {
      const optimized = await db.prepare('PRAGMA optimize').all();
      return { findings: [], measurements: measurements(optimized.meta?.size_after) };
    }
    const quick = await db.prepare('PRAGMA quick_check').all<{ quick_check: string }>();
    const keys = await db.prepare('PRAGMA foreign_key_check').all<ForeignKeyRow>();
    const findings = [
      ...quick.results.map((r) => r.quick_check).filter((text) => text !== 'ok'),
      ...keys.results.map((r) => `foreign key: ${r.table} row ${r.rowid} names a missing ${r.parent}`),
    ];
    return { findings, measurements: measurements(keys.meta?.size_after ?? quick.meta?.size_after) };
  };
  return {
    support: {
      optimize: { supported: true, label: 'D1 optimize' },
      integrity: { supported: true, label: 'D1 quick check and foreign key check' },
    },
    claimMs: { optimize: HOSTED_CLAIM_MS, integrity: HOSTED_CLAIM_MS },
    run,
  };
}
