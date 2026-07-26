import { STALE_SESSION_THRESHOLD_MS } from '../../constants.js';
import { LOG_KINDS } from '../../constants/log-kinds.js';
import { openReadonly } from '../../db/client.js';
import { symbiontContexts } from './context.js';
import { checkClosure, type ClosureInput } from './checks/closure.js';
import { checkDrift } from './checks/drift.js';
import { checkIntegrity } from './checks/integrity.js';
import { checkReconcile } from './checks/reconcile.js';
import type { AuditOptions, AuditReport } from './types.js';

export type { AuditOptions, AuditReport, Finding, CoverageGap, SymbiontContext } from './types.js';
export { checkClosure, hookClosingSymbionts } from './checks/closure.js';
export { checkDrift } from './checks/drift.js';
export { checkIntegrity } from './checks/integrity.js';
export { checkReconcile, transcriptCwd } from './checks/reconcile.js';
export { captureModel, classifyRecency, symbiontContexts } from './context.js';
export { repair, type RepairOptions, type RepairPlan } from './repair.js';

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/**
 * Newest `maintenance.session` log entry, as epoch seconds.
 *
 * The sweep logs only when it completes or prunes something, so this is a
 * lower bound on when it last ran, not the run itself: a recent entry proves
 * it ran, absence proves nothing. Callers must treat undefined as "unknown"
 * rather than "never ran".
 */
function lastSweepFromLog(db: ReturnType<typeof openReadonly>): number | undefined {
  try {
    const row = db
      .query(
        `SELECT MAX(timestamp) ts FROM log_entries WHERE kind = $kind`,
      )
      .get({ $kind: LOG_KINDS.MAINTENANCE_SESSION }) as { ts: string | null } | null;
    if (!row?.ts) return undefined;
    const parsed = Date.parse(row.ts);
    return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
  } catch {
    return undefined; // older vault without log_entries
  }
}

/**
 * Run the capture fidelity audit.
 *
 * Read-only by construction: the database is opened through `openReadonly`,
 * so a bug in a check cannot mutate a vault. Repair is a separate, explicitly
 * invoked path with its own gates.
 */
export function runAudit(opts: AuditOptions, closure?: Partial<ClosureInput>): AuditReport {
  const now = Math.floor(Date.now() / 1000);
  const db = openReadonly(opts.dbPath);

  try {
    const symbionts = symbiontContexts(opts.symbiont);
    const report: AuditReport = {
      dbPath: opts.dbPath,
      projectId: opts.projectId,
      since: opts.since,
      generatedAt: now,
      symbionts,
      findings: [],
      coverage: [],
    };

    report.findings.push(...checkIntegrity(db, opts, now));

    // Distinguishing a sweep that ran and missed sessions from one that never
    // ran requires its last run time. No per-run timestamp is recorded, so the
    // newest session-maintenance log entry serves as a lower bound.
    const resolvedSweepAt = closure?.lastSweepAt ?? lastSweepFromLog(db);

    const closureResult = checkClosure(db, opts, now, {
      staleThresholdMs: closure?.staleThresholdMs ?? STALE_SESSION_THRESHOLD_MS,
      ...(resolvedSweepAt !== undefined ? { lastSweepAt: resolvedSweepAt } : {}),
    });
    report.findings.push(...closureResult.findings);
    report.coverage.push(...closureResult.coverage);

    const reconcileResult = checkReconcile(db, opts, now, symbionts);
    report.findings.push(...reconcileResult.findings);
    report.coverage.push(...reconcileResult.coverage);

    report.findings.push(...checkDrift(db, opts, now));

    report.findings.sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count,
    );
    return report;
  } finally {
    db.close();
  }
}
