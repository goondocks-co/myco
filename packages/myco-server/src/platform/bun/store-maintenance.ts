/**
 * Store maintenance on the self-hosted target: SQLite's own optimize and integrity checks.
 *
 * Optimize runs on the serving connection, bounded by `analysis_limit`. The integrity check runs on a thread of
 * its own over a read-only connection, so capture keeps writing through WAL while it reads. SQLite cannot be
 * interrupted from another thread here, and terminating the thread does not stop a statement already running,
 * so the check is bounded cooperatively: it checks one table and its indexes at a time and stops at the deadline
 * between tables. The run answers only once the thread has reported, so its claim is never released while the
 * check still reads.
 */
import type { Database } from 'bun:sqlite';
import type { MaintenanceCheck, PortResult, StoreMaintenancePort, StoreMeasurement } from '../../core/store-maintenance.js';
import { MAX_FINDINGS } from '../../core/store-maintenance.js';

/** Rows `PRAGMA optimize` may sample per index; SQLite's own recommended bound for a periodic optimize. */
export const ANALYSIS_LIMIT = 400;
/** The integrity check starts no new table after this long. */
export const INTEGRITY_DEADLINE_MS = 10 * 60_000;
/**
 * How long a claim stays exclusive. A table started before the deadline is checked to its end, so the claim
 * outlasts the deadline by the time one large table can take; past it a second, read-only check may start beside
 * a first that is still reading, and the first's record never replaces the second's.
 */
export const INTEGRITY_CLAIM_MS = 60 * 60_000;
export const OPTIMIZE_CLAIM_MS = 10 * 60_000;

/** What the integrity thread reports. */
export interface IntegrityReport {
  findings: string[];
  tablesChecked: number;
  tablesTotal: number;
  stoppedAtDeadline: boolean;
}

/**
 * The integrity thread, as module source: a blob worker needs no file beside the compiled binary.
 *
 * Checks every ordinary table and its indexes with `integrity_check(<table>)`, then `foreign_key_check`, keeping at
 * most `max` findings. A virtual table has no b-tree of its own to check; its shadow tables are ordinary tables and
 * are checked.
 */
const INTEGRITY_THREAD_SOURCE = `
import { Database } from 'bun:sqlite';
self.onmessage = (event) => {
  const { path, deadline, max } = event.data;
  const findings = [];
  let tablesChecked = 0;
  let tablesTotal = 0;
  let stoppedAtDeadline = false;
  let db;
  try {
    db = new Database(path, { readonly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    const tables = db.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name").all().map((r) => r.name);
    tablesTotal = tables.length;
    for (const table of tables) {
      if (Date.now() >= deadline) { stoppedAtDeadline = true; break; }
      for (const row of db.query('SELECT * FROM pragma_integrity_check(?)').iterate(table)) {
        const text = Object.values(row)[0];
        if (text !== 'ok' && findings.length < max) findings.push(table + ': ' + text);
      }
      tablesChecked += 1;
    }
    if (!stoppedAtDeadline) {
      for (const row of db.query('PRAGMA foreign_key_check').iterate()) {
        if (findings.length >= max) break;
        findings.push('foreign key: ' + row.table + ' row ' + row.rowid + ' names a missing ' + row.parent);
      }
    }
    postMessage({ ok: true, report: { findings, tablesChecked, tablesTotal, stoppedAtDeadline } });
  } catch (error) {
    postMessage({ ok: false, message: String(error && error.message || error) });
  } finally {
    try { db && db.close(); } catch {}
  }
};`;

/** Runs the integrity thread over the database at `path` and answers its report once the thread has finished. */
export function checkIntegrityOffThread(path: string, options: { deadlineMs?: number; max?: number } = {}): Promise<IntegrityReport> {
  const url = URL.createObjectURL(new Blob([INTEGRITY_THREAD_SOURCE], { type: 'application/javascript' }));
  const worker = new Worker(url);
  return new Promise<IntegrityReport>((resolve, reject) => {
    const finish = () => { worker.terminate(); URL.revokeObjectURL(url); };
    worker.onmessage = (event: MessageEvent<{ ok: true; report: IntegrityReport } | { ok: false; message: string }>) => {
      finish();
      if (event.data.ok) resolve(event.data.report);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event) => { finish(); reject(new Error(event.message)); };
    worker.postMessage({ path, deadline: Date.now() + (options.deadlineMs ?? INTEGRITY_DEADLINE_MS), max: options.max ?? MAX_FINDINGS });
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

/** The integrity report as a port result; a check that stopped at its deadline says how far it got. */
export function integrityResult(report: IntegrityReport, measurements: StoreMeasurement[]): PortResult {
  return {
    findings: report.findings,
    measurements,
    ...(report.stoppedAtDeadline
      ? { incomplete: `stopped at the deadline after ${report.tablesChecked} of ${report.tablesTotal} tables; foreign keys were not checked` }
      : {}),
  };
}

export function sqliteStoreMaintenance(sqlite: Database, options: { deadlineMs?: number } = {}): StoreMaintenancePort {
  const path = sqlite.filename;
  const run = async (check: MaintenanceCheck): Promise<PortResult> => {
    if (check === 'optimize') {
      sqlite.exec(`PRAGMA analysis_limit = ${ANALYSIS_LIMIT}`);
      sqlite.exec('PRAGMA optimize');
      return { findings: [], measurements: sizeMeasurements(sqlite) };
    }
    const report = await checkIntegrityOffThread(path, { deadlineMs: options.deadlineMs });
    return integrityResult(report, sizeMeasurements(sqlite));
  };
  return {
    support: {
      optimize: { supported: true, label: 'SQLite optimize' },
      integrity: { supported: true, label: 'SQLite integrity and foreign key check, one table at a time' },
    },
    claimMs: { optimize: OPTIMIZE_CLAIM_MS, integrity: INTEGRITY_CLAIM_MS },
    run,
  };
}
