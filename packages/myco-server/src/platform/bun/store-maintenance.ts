/**
 * Store maintenance on the self-hosted target: SQLite's own optimize and integrity checks.
 *
 * Optimize runs on the serving connection, bounded by `analysis_limit`. The integrity check is SQLite's full
 * `integrity_check`, which covers every table, index and page including the freelist, followed by
 * `foreign_key_check`. It runs on a thread of its own over a read-only connection, so capture keeps writing
 * through WAL while it reads. SQLite gives this runtime no way to interrupt a running statement, and terminating
 * the thread does not stop one, so the check runs to its end: its length is bounded by the store's size, and what
 * it reports is bounded to `MAX_FINDINGS` of each kind. The port belongs to the one process serving the volume,
 * so it holds the check exclusive for as long as the thread works.
 */
import type { Database } from 'bun:sqlite';
import type { MaintenanceCheck, PortResult, StoreMaintenancePort, StoreMeasurement } from '../../core/store-maintenance.js';
import { MAX_FINDINGS } from '../../core/store-maintenance.js';

/** Rows `PRAGMA optimize` may sample per index; SQLite's own recommended bound for a periodic optimize. */
export const ANALYSIS_LIMIT = 400;

/** What the integrity thread reports. `truncated` is true when a check had more to say than `max`. */
export interface IntegrityReport {
  findings: string[];
  truncated: boolean;
}

/**
 * The integrity thread, as module source: a blob worker needs no file beside the compiled binary.
 *
 * Asks `integrity_check(max + 1)` and then `foreign_key_check`, stepping at most `max + 1` rows of the latter, so
 * one past the limit says more existed without reading it all. A failure to close the connection is reported as
 * the thread's failure.
 */
const INTEGRITY_THREAD_SOURCE = `
import { Database } from 'bun:sqlite';
self.onmessage = (event) => {
  const { path, max } = event.data;
  let db;
  let answer;
  try {
    db = new Database(path, { readonly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    const integrity = db.query('PRAGMA integrity_check(' + (max + 1) + ')').all().map((r) => r.integrity_check).filter((t) => t !== 'ok');
    const keys = [];
    for (const row of db.query('PRAGMA foreign_key_check').iterate()) {
      if (keys.length > max) break;
      keys.push('foreign key: ' + row.table + ' row ' + row.rowid + ' names a missing ' + row.parent);
    }
    answer = { ok: true, report: { findings: [...integrity.slice(0, max), ...keys.slice(0, max)], truncated: integrity.length > max || keys.length > max } };
  } catch (error) {
    answer = { ok: false, message: String((error && error.message) || error) };
  }
  try {
    if (db) db.close();
  } catch (error) {
    answer = { ok: false, message: 'closing the read-only connection failed: ' + String((error && error.message) || error) };
  }
  postMessage(answer);
};`;

/**
 * Runs the integrity thread over the database at `path` and answers its report once the thread has finished. A
 * thread that ends without reporting is a failure, never a pass.
 */
export function checkIntegrityOffThread(path: string, options: { max?: number } = {}): Promise<IntegrityReport> {
  const url = URL.createObjectURL(new Blob([INTEGRITY_THREAD_SOURCE], { type: 'application/javascript' }));
  const worker = new Worker(url);
  return new Promise<IntegrityReport>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      worker.terminate();
      outcome();
    };
    worker.onmessage = (event: MessageEvent<{ ok: true; report: IntegrityReport } | { ok: false; message: string }>) => {
      const data = event.data;
      settle(() => (data.ok ? resolve(data.report) : reject(new Error(data.message))));
    };
    worker.onerror = (event) => settle(() => reject(new Error(event.message)));
    worker.addEventListener('close', () => settle(() => reject(new Error('the integrity check thread ended without reporting'))));
    worker.postMessage({ path, max: options.max ?? MAX_FINDINGS });
  });
}

function sizeMeasurements(sqlite: Database): StoreMeasurement[] {
  const pragma = (name: string) => Number((sqlite.query(`PRAGMA ${name}`).get() as Record<string, number>)[name]);
  const pageSize = pragma('page_size');
  return [
    { name: 'size', state: 'measured', value: pragma('page_count') * pageSize, unit: 'bytes' },
    { name: 'reclaimable', state: 'measured', value: pragma('freelist_count') * pageSize, unit: 'bytes' },
  ];
}

export function sqliteStoreMaintenance(sqlite: Database): StoreMaintenancePort {
  const path = sqlite.filename;
  const run = async (check: MaintenanceCheck): Promise<PortResult> => {
    if (check === 'optimize') {
      sqlite.exec(`PRAGMA analysis_limit = ${ANALYSIS_LIMIT}`);
      sqlite.exec('PRAGMA optimize');
      return { findings: [], measurements: sizeMeasurements(sqlite) };
    }
    const report = await checkIntegrityOffThread(path);
    const findings = report.truncated ? [...report.findings, `more problems were found than the ${MAX_FINDINGS} of each kind kept`] : report.findings;
    return { findings, measurements: sizeMeasurements(sqlite) };
  };
  return {
    support: {
      optimize: { supported: true, label: 'Refreshes the statistics queries are planned from' },
      integrity: { supported: true, label: 'Checks every table, index and page, and every link between records' },
    },
    exclusivity: { kind: 'serving-owner', holder: crypto.randomUUID() },
    run,
  };
}
