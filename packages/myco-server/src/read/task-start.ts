import type { QueueReason } from '@goondocks/myco-shared/runner-fleet';
import { readDispatchLimits } from '../core/limits.js';
import { previewFleet, fleetTaskReason } from './fleet.js';
/**
 * What starting one task by hand in one Project would do right now, read before
 * anything is dispatched: every agent and model the workers heard from lately
 * would run it with (whichever of them asks next takes it), or what a
 * queued run of it would wait for; whether the task's own condition for running
 * holds there; whether one is already waiting or running; and whether the
 * Project has turned its capability on. Every answer comes from the function the
 * dispatch, the clock or the claim decides by, never a copy.
 *
 * A stored login is never opened here: a server login counts as usable when the
 * agent's slot holds one. The claim alone opens it.
 */
import type { ReasoningTier } from '@goondocks/myco-shared/execution-profile';
import type { RelationalStore, ServerEnv } from '../core/adapters.js';
import { declared } from '../core/declared.js';
import { TASK_SCHEDULE } from '../core/jobs.js';
import { hasLiveTaskRun } from '../core/runs.js';
import { PRE_CONDITIONS, scheduleFor, scheduleLeaves } from '../core/schedule-rules.js';
import { fleetReports, readWorkerFleet, type WorkerFleetRow } from '../core/worker-contacts.js';
import { capabilityOf, capabilityOn, claimSettings } from '../core/worker-selection.js';
import { HARNESS_MEMBER_ID } from '../constants.js';
import { ownMachineNames } from './capture.js';

/** A machine heard from lately: named only to the member it belongs to, and to anyone else as that member's. */
export interface StartWorker {
  credentialId: string;
  machineId: string | null;
  machineName: string | null;
  member: { id: string; label: string | null } | null;
  runner: { id: string; name: string | null } | null;
}

export interface TaskStartPreview {
  task: string;
  projectId: string;
  fleetWait: { reason: QueueReason; observedAt: number };
  /** Each distinct agent, tier, model and effort the workers heard from lately would run it with, and which of them would; empty when none could take it now. */
  executions: Array<{ harness: string; tier: ReasoningTier; model: string; effort: string | null; workers: StartWorker[] }>;
  /** What a queued run would wait under while no worker can take it, in the `run-holds` holder vocabulary; null when one can. */
  heldBy: string | null;
  /** How many workers have been heard from lately. */
  workers: number;
  /** The task's scheduling condition and whether it holds in the Project now; null for a task that names none. */
  readiness: { condition: string; met: boolean } | null;
  /** A run of the task is already waiting or running in the Project. */
  live: boolean;
  /** The capability the task needs and whether the Project has it on; null for a task no capability gates. */
  capability: { name: string; on: boolean } | null;
}

/** The workers behind credentials and runners, each named as `viewerId` may see it: a runner by its own name. */
async function startWorkers(db: RelationalStore, reports: ReadonlyArray<{ credentialId: string; machineId: string | null }>, viewerId: string, now: number, fleet: readonly WorkerFleetRow[]): Promise<Map<string, StartWorker>> {
  if (reports.length === 0) return new Map();
  const ids = reports.map((report) => report.credentialId);
  const [owners, ownNames] = await Promise.all([
    db.prepare(`SELECT c.id AS id, c.member_id AS member_id, m.label AS label FROM member_credentials c LEFT JOIN members m ON m.id = c.member_id WHERE c.id IN (${ids.map(() => '?').join(', ')})`)
      .bind(...ids).all<{ id: string; member_id: string | null; label: string | null }>(),
    ownMachineNames(db, viewerId, now),
  ]);
  const byId = new Map((owners.results ?? []).map((row) => [row.id, row]));
  const runnerNames = new Map(fleet.flatMap(row => row.runner === null ? [] : [[row.runner.id, row.runner.name] as const]));
  return new Map<string, StartWorker>(reports.map((report): [string, StartWorker] => {
    const runnerName = runnerNames.get(report.credentialId);
    if (runnerName !== undefined) return [report.credentialId, { credentialId: report.credentialId, machineId: report.machineId, machineName: runnerName, member: null, runner: { id: report.credentialId, name: runnerName } }];
    const owner = byId.get(report.credentialId);
    const member = owner?.member_id == null ? null : { id: owner.member_id, label: owner.member_id === HARNESS_MEMBER_ID ? 'Myco' : owner.label };
    return [report.credentialId, {
      credentialId: report.credentialId, machineId: report.machineId,
      machineName: report.machineId === null ? null : ownNames.get(report.machineId) ?? null, member, runner: null,
    }];
  }));
}

/** Preview one task in one Project the caller may read, naming machines as `viewerId` may see them. */
export async function readTaskStartPreview(env: ServerEnv, projectId: string, task: string, viewerId: string, now: number): Promise<TaskStartPreview> {
  const declaredSchedule = TASK_SCHEDULE[task] ?? null;
  const capability = capabilityOf(task);
  const [settings, fleet, leaves, live, on] = await Promise.all([
    claimSettings(env),
    readWorkerFleet(env.db, now),
    declaredSchedule === null ? Promise.resolve(null) : scheduleLeaves(env),
    hasLiveTaskRun(env.db, { projectId }, task),
    capability === null ? Promise.resolve(null) : capabilityOn(env.db, projectId, capability),
  ]);
  const reports = fleetReports(fleet);
  const { executions, heldBy } = await previewFleet(env, task, fleet, settings);
  const workers = await startWorkers(env.db, reports, viewerId, now, fleet);
  const condition = declaredSchedule === null || leaves === null ? undefined : scheduleFor(task, declaredSchedule, leaves.overrides).preCondition;
  const check = condition === undefined ? undefined : declared(PRE_CONDITIONS, condition);
  const readiness = condition === undefined || check === undefined ? null : { condition, met: await check({ db: env.db, projectId, now }) };
  return {
    task, projectId, fleetWait: { reason: await fleetTaskReason(env, task, fleet, now, settings, await readDispatchLimits(env)), observedAt: now }, heldBy, workers: reports.length, readiness, live,
    executions: executions.map((execution) => ({
      harness: execution.harness, tier: execution.profile.tier, model: execution.profile.model, effort: execution.profile.effort,
      workers: execution.credentialIds.map((id) => workers.get(id)!),
    })),
    capability: capability === null || on === null ? null : { name: capability, on },
  };
}
