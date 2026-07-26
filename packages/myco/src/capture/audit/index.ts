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

    const closureResult = checkClosure(db, opts, now, {
      staleThresholdMs: closure?.staleThresholdMs ?? 60 * 60 * 1000,
      ...(closure?.lastSweepAt !== undefined ? { lastSweepAt: closure.lastSweepAt } : {}),
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
