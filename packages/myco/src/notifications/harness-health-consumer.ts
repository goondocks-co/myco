// SPDX-License-Identifier: Apache-2.0

/**
 * Consumer that turns a completed `harness-health` sentinel run into a
 * notification. Agent tools cannot emit notifications themselves — this is
 * the daemon-side seam that notices the run's `vault_report` (action
 * `harness-health`) and surfaces its findings.
 *
 * Called from three completion seams: the scheduler's own dispatch
 * (`dispatchScheduledTask`), the manual-run API handler (`handleRun`), and
 * the manual-resume API handler (`handleResumeRun`). Read-only and
 * best-effort — never mutates a run or report, and never throws into the
 * caller's completion handling.
 */

import { listReports } from '@myco/db/queries/reports.js';
import { asPlainRecord } from '@myco/agent/phase-postconditions.js';
import { notify } from './notify.js';
import { agentRunNotificationLink } from './links.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { GroveProjectId } from '@myco/grove/ids.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { errorMessage } from '@myco/utils/error-message.js';

export const HARNESS_HEALTH_TASK_NAME = 'harness-health';
const HARNESS_HEALTH_REPORT_ACTION = 'harness-health';

/** Minimal logger surface the consumer needs — matches DaemonLogger. */
export interface HarnessHealthConsumerLogger {
  warn: (kind: string, message: string, metadata?: Record<string, unknown>) => void;
}

export interface NotifyHarnessHealthFindingsInput {
  runId: string;
  projectVaultDir: string;
  config?: MycoConfig;
  projectId?: GroveProjectId;
  logger: HarnessHealthConsumerLogger;
}

const MAX_LISTED_BUCKETS = 5;
const MAX_LISTED_RUN_IDS = 3;
const MAX_LISTED_TASKS = 5;
const MAX_METADATA_ATTRIBUTIONS = 10;

/**
 * A bucket's findings as an entry list. Tolerates both report shapes: a
 * plain array of findings, or the `vault_run_health` tool's
 * `{ description, entries: [...] }` object — where `description` is always
 * present, so key count alone would misreport an empty bucket as non-empty.
 */
function bucketEntries(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') {
    const entries = (value as Record<string, unknown>).entries;
    if (Array.isArray(entries)) return entries;
  }
  return null;
}

/** True when a bucket's value carries at least one finding. */
function bucketHasFindings(value: unknown): boolean {
  const entries = bucketEntries(value);
  if (entries) return entries.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  if (value === null || value === undefined) return false;
  return Boolean(value);
}

/** Number of findings in a bucket, for the notification summary. */
function bucketCount(value: unknown): number {
  const entries = bucketEntries(value);
  if (entries) return entries.length;
  if (value !== null && typeof value === 'object') return Object.keys(value).length;
  return 1;
}

/**
 * Distinct task names and run ids attributed across all bucket entries.
 * Entries mirror `vault_run_health` attribution rows (`task`, `run_id`),
 * but the report is agent-authored — extraction is lenient (also accepts
 * `runId`, skips non-object entries) and purely additive.
 */
function collectAttributions(nonEmpty: Array<[string, unknown]>): { tasks: string[]; runIds: string[] } {
  const tasks = new Set<string>();
  const runIds = new Set<string>();
  for (const [, value] of nonEmpty) {
    for (const entry of bucketEntries(value) ?? []) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.task === 'string' && record.task.length > 0) tasks.add(record.task);
      const runId = record.run_id ?? record.runId;
      if (typeof runId === 'string' && runId.length > 0) runIds.add(runId);
    }
  }
  return { tasks: [...tasks], runIds: [...runIds] };
}

function capped(values: string[], max: number): string {
  const shown = values.slice(0, max);
  const remainder = values.length - shown.length;
  return remainder > 0 ? `${shown.join(', ')} and ${remainder} more` : shown.join(', ');
}

function summarizeBuckets(nonEmpty: Array<[string, unknown]>): {
  title: string;
  message: string;
  tasks: string[];
  runIds: string[];
} {
  const bucketNames = nonEmpty.map(([name]) => name);
  const title = nonEmpty.length === 1
    ? `Harness health: ${bucketNames[0]}`
    : `Harness health: ${nonEmpty.length} anomaly buckets`;

  const parts = nonEmpty.map(([name, value]) => `${name} (${bucketCount(value)})`);
  const shown = parts.slice(0, MAX_LISTED_BUCKETS);
  const remainder = parts.length - shown.length;
  let message = remainder > 0
    ? `${shown.join(', ')}, and ${remainder} more`
    : shown.join(', ');

  const { tasks, runIds } = collectAttributions(nonEmpty);
  if (tasks.length > 0) message += ` — tasks: ${capped(tasks, MAX_LISTED_TASKS)}`;
  if (runIds.length > 0) message += `${tasks.length > 0 ? ';' : ' —'} runs: ${capped(runIds, MAX_LISTED_RUN_IDS)}`;

  return { title, message, tasks, runIds };
}

/**
 * Read the latest `harness-health` report for a completed run and, if it
 * contains any non-empty anomaly buckets, emit a single `agents` domain
 * notification summarizing them. No-ops (without throwing) when there is
 * no report, the report's `details` isn't a plain object, or every bucket
 * is empty.
 */
async function notifyHarnessHealthFindingsInner(input: NotifyHarnessHealthFindingsInput): Promise<void> {
  const { runId, projectVaultDir, config, projectId } = input;

  const reports = listReports(runId, { scope: ALL_PROJECTS_SCOPE });
  let latest: (typeof reports)[number] | undefined;
  for (let index = reports.length - 1; index >= 0; index -= 1) {
    if (reports[index]?.action === HARNESS_HEALTH_REPORT_ACTION) {
      latest = reports[index];
      break;
    }
  }
  if (!latest) return;

  const details = asPlainRecord(latest.details);
  if (!details) return;

  const nonEmpty = Object.entries(details).filter(([, value]) => bucketHasFindings(value));
  if (nonEmpty.length === 0) return;

  const { title, message, tasks, runIds } = summarizeBuckets(nonEmpty);

  notify(projectVaultDir, {
    domain: 'agents',
    type: 'agent.harness-health.findings',
    title,
    message,
    link: agentRunNotificationLink(runId),
    metadata: {
      runId,
      buckets: nonEmpty.map(([name, value]) => ({ name, count: bucketCount(value) })),
      affectedTasks: tasks.slice(0, MAX_METADATA_ATTRIBUTIONS),
      affectedRunIds: runIds.slice(0, MAX_METADATA_ATTRIBUTIONS),
    },
  }, config, projectId ? { projectId } : undefined);
}

/**
 * Best-effort wrapper — logs and swallows any error instead of propagating
 * into the caller's run-completion flow.
 */
export async function notifyHarnessHealthFindings(input: NotifyHarnessHealthFindingsInput): Promise<void> {
  try {
    await notifyHarnessHealthFindingsInner(input);
  } catch (err) {
    input.logger.warn(LOG_KINDS.AGENT_ERROR, 'Failed to emit harness-health findings notification', {
      runId: input.runId,
      error: errorMessage(err),
    });
  }
}
