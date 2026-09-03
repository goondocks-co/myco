import { listReports } from '@myco/db/queries/reports.js';
import { getRun } from '@myco/db/queries/runs.js';
import { countToolCallsByRun } from '@myco/db/queries/turns.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { asPlainRecord, checkPhasePostCondition } from './phase-postconditions.js';
import { SKILL_EVOLVE_TASK_NAME } from './skill-evolve-output.js';

/** Task name for vault-seed.yaml — matches the YAML's `name:` field. */
const VAULT_SEED_TASK_NAME = 'vault-seed';

/** Task name for supersession-sweep.yaml — matches the YAML's `name:` field. */
const SUPERSESSION_SWEEP_TASK_NAME = 'supersession-sweep';

/** The report action the sweep closes on, and the counts it carries. */
const SUPERSESSION_REPORT_ACTION = 'supersession';
const RESOLUTION_COUNT_KEYS = ['superseded', 'consolidated', 'obsoleted'] as const;

interface PostconditionInput {
  runId: string;
  taskName?: string;
  dryRun?: boolean;
}

type PostconditionValidator = (input: PostconditionInput) => string | null;

/**
 * Part 3 of the resume-admission gate. Thrown at the run-end validator
 * throw site (executor.ts) instead of a generic Error when BOTH are true:
 * the run was a resume (`options.resumeRunId` set) AND
 * `executePhasedQuery`'s `executedPhaseCount === 0` — every phase in this
 * attempt's plan was trusted from the checkpoint with none re-executed.
 *
 * Distinguishes a deterministically-unresumable run from an ordinary
 * postcondition failure: retrying an all-restored resume can never satisfy
 * the missing contract, because retrying re-runs nothing. The executor's
 * catch block terminal-marks via `instanceof` — `resumable=0`,
 * `resume_status='postcondition_unsatisfiable'` — in ONE attempt instead of
 * burning the scheduler's full resume budget on a run that cannot recover.
 */
export class PostconditionUnsatisfiableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostconditionUnsatisfiableError';
  }
}

/** True when `updated` is a number or numeric string equal to zero (NaN/empty-string/other types excluded). */
function isZeroUpdateValue(updated: unknown): boolean {
  if (typeof updated !== 'number' && typeof updated !== 'string') return false;
  if (typeof updated === 'string' && updated.trim() === '') return false;
  return Number(updated) === 0;
}

/** True when a `summary` report's details show a machine-readable zero-update outcome. */
function hasZeroUpdateSummaryReport(reports: ReturnType<typeof listReports>): boolean {
  return reports.some((report) => {
    if (report.action !== 'summary') return false;
    const details = asPlainRecord(report.details);
    return isZeroUpdateValue(details?.updated);
  });
}

function validateTitleSummaryRun({ runId }: PostconditionInput): string | null {
  const reports = listReports(runId, { scope: ALL_PROJECTS_SCOPE });
  if (reports.length === 0) {
    return 'title-summary completed without calling vault_report';
  }

  // Backward compat: historical runs and older builds emit an explicit
  // skip report instead of a summary with structured zero-update details.
  if (reports.some((report) => report.action === 'skip')) {
    return null;
  }

  const toolCounts = countToolCallsByRun(runId, ['vault_update_session']);
  if ((toolCounts.vault_update_session ?? 0) > 0) {
    return null;
  }

  if (hasZeroUpdateSummaryReport(reports)) {
    return null;
  }

  return 'title-summary completed without vault_update_session or a report showing zero updates';
}

function validateSkillEvolveRun({ runId }: PostconditionInput): string | null {
  const run = getRun(runId, ALL_PROJECTS_SCOPE);
  if (!run) {
    return `skill-evolve run not found: ${runId}`;
  }

  // Delegates to the same checks the phase-boundary gates run
  // (phase-postconditions.ts) — one source of truth for the skill-evolve
  // output contract, evaluated here a second time at run end as the belt
  // to the gates' suspenders (a later phase can clobber state a gate
  // already validated, and resumed runs re-validate from checkpoints).
  //
  // Precedence: inventory is validated fully (report AND state/intent),
  // then assess. When multiple things are wrong this surfaces an
  // inventory-state error where the pre-refactor code surfaced the
  // assess-report error first — an accepted reorder; every string is
  // unchanged and single-failure runs report identically.
  const input = {
    runId,
    agentId: run.agent_id,
    projectId: run.project_id ?? null,
    dryRun: !!run.dry_run,
  };
  const inventory = checkPhasePostCondition('skill-evolve-inventory', input);
  if (!inventory.passed) {
    return inventory.reason;
  }
  const assess = checkPhasePostCondition('skill-evolve-assess', input);
  if (!assess.passed) {
    return assess.reason;
  }
  return null;
}

/**
 * vault-seed run-end validator. Accepts exactly two shapes:
 *
 *   - SKIP path: a `skip` report exists AND zero `vault_create_spore`
 *     calls were made this run.
 *   - SEED path: at least one `vault_create_spore` call succeeded AND all
 *     three digest-tier postConditions pass AND a `complete` report exists.
 *
 * The report's self-reported spore count is not gated — the run's tool-call
 * log is the authoritative count, and a model self-tally is not reliable
 * enough to fail a run on.
 */
function validateVaultSeedRun({ runId }: PostconditionInput): string | null {
  const reports = listReports(runId, { scope: ALL_PROJECTS_SCOPE });
  if (reports.length === 0) {
    return 'vault-seed completed without calling vault_report';
  }

  const toolCounts = countToolCallsByRun(runId, ['vault_create_spore']);
  const createCount = toolCounts.vault_create_spore ?? 0;

  const skipReport = reports.find((report) => report.action === 'skip');
  if (skipReport) {
    if (createCount > 0) {
      return `vault-seed reported skip but ${createCount} vault_create_spore call(s) were made this run`;
    }
    return null;
  }

  if (createCount < 1) {
    return 'vault-seed completed without a skip report or a successful vault_create_spore call';
  }

  const digest10000 = checkPhasePostCondition('vault-seed-digest-10000', { runId, agentId: '', projectId: null, dryRun: false });
  if (!digest10000.passed) {
    return digest10000.reason;
  }
  const digest5000 = checkPhasePostCondition('vault-seed-digest-5000', { runId, agentId: '', projectId: null, dryRun: false });
  if (!digest5000.passed) {
    return digest5000.reason;
  }
  const digest1500 = checkPhasePostCondition('vault-seed-digest-1500', { runId, agentId: '', projectId: null, dryRun: false });
  if (!digest1500.passed) {
    return digest1500.reason;
  }

  const completeReport = reports.find((report) => report.action === 'complete');
  if (!completeReport) {
    return 'vault-seed made vault_create_spore calls but completed without a "complete" report';
  }

  return null;
}

/**
 * supersession-sweep run-end validator.
 *
 * A sweep that resolves nothing is a normal outcome — most passes over a
 * healthy vault find nothing to merge — so the contract is the report, not the
 * resolutions: the run must close with a `supersession` report carrying its
 * counts. The one shape rejected is a report that claims zero while the run's
 * tool-call log shows a resolution landed; the log is authoritative, and a run
 * whose report disagrees with it leaves an audit trail nobody can read.
 */
function validateSupersessionSweepRun({ runId }: PostconditionInput): string | null {
  const reports = listReports(runId, { scope: ALL_PROJECTS_SCOPE });
  const report = reports.find((r) => r.action === SUPERSESSION_REPORT_ACTION);
  if (!report) {
    return 'supersession-sweep completed without a vault_report with action "supersession"';
  }

  const toolCounts = countToolCallsByRun(runId, ['vault_resolve_spore']);
  const resolveCount = toolCounts.vault_resolve_spore ?? 0;
  if (resolveCount === 0) {
    return null;
  }

  const details = asPlainRecord(report.details);
  const reported = RESOLUTION_COUNT_KEYS
    .map((key) => details?.[key])
    .filter((value) => typeof value === 'number' || typeof value === 'string');
  if (reported.length > 0 && reported.every((value) => isZeroUpdateValue(value))) {
    return `supersession-sweep reported zero resolutions but ${resolveCount} vault_resolve_spore call(s) were made this run`;
  }

  return null;
}

const TASK_POSTCONDITION_RULES: Array<{
  taskNames: string[];
  validate: PostconditionValidator;
}> = [
  {
    taskNames: ['title-summary'],
    validate: validateTitleSummaryRun,
  },
  {
    taskNames: [SKILL_EVOLVE_TASK_NAME],
    validate: validateSkillEvolveRun,
  },
  {
    taskNames: [VAULT_SEED_TASK_NAME],
    validate: validateVaultSeedRun,
  },
  {
    taskNames: [SUPERSESSION_SWEEP_TASK_NAME],
    validate: validateSupersessionSweepRun,
  },
];

export function validateTaskPostconditions(input: PostconditionInput): string | null {
  if (input.dryRun && input.taskName !== SKILL_EVOLVE_TASK_NAME) {
    return null;
  }
  for (const rule of TASK_POSTCONDITION_RULES) {
    if (input.taskName && rule.taskNames.includes(input.taskName)) {
      return rule.validate(input);
    }
  }
  return null;
}
