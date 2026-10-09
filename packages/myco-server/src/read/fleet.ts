import { capabilitiesRequiredBy } from '@goondocks/myco-shared/repository';
import type { FleetQueue, QueueReason } from '@goondocks/myco-shared/runner-fleet';
import { credentialUnavailable } from '@goondocks/myco-shared/run-holds';
import type { ServerEnv } from '../core/adapters.js';
import { readWorkerFleet, fleetReports, type WorkerFleetRow } from '../core/worker-contacts.js';
import { claimSettings, previewSelection, type LoginStep } from '../core/worker-selection.js';
import { secretStored } from '../core/secrets.js';
import { dispatchLoad } from '../core/runs.js';
import { heldBy, readDispatchLimits, type DispatchLimits } from '../core/limits.js';

/** Selection uses the claim's own profile and login rules; a runner never reads a Deployment key. */
export function previewFleet(env: ServerEnv, task: string, fleet: readonly WorkerFleetRow[], settings: ReadonlyMap<string, string>, includeBusy = false) {
  return previewSelection(env, task, fleetReports(fleet, includeBusy), settings, report => {
    const login: LoginStep<true> = async (harness, plan) => report.runner || plan.kind === 'worker-login' || await secretStored(env.db, plan.slot)
      ? { login: true } : { reason: credentialUnavailable(harness) };
    return login;
  });
}

/** The current wait for this exact task, using the same fleet and admission facts as the queue. */
export async function fleetTaskReason(env: ServerEnv, task: string, fleet: readonly WorkerFleetRow[], now: number,
  settings: ReadonlyMap<string, string>, limits: DispatchLimits, exclude?: string): Promise<QueueReason> {
  const ceiling = heldBy(await dispatchLoad(env.db, task, now, exclude), limits);
  let reason: QueueReason;
  if (ceiling !== null) reason = 'dispatch_ceiling';
  else if ((await previewFleet(env, task, fleet, settings)).executions.length > 0) reason = 'ready';
  else if ((await previewFleet(env, task, fleet, settings, true)).executions.length > 0) reason = 'capacity';
  else {
    const recent = fleet.filter(row => row.recent && (row.runner === null ? row.eligible : row.runner.state !== 'removed'));
    const potential = async (candidate: WorkerFleetRow) => (await previewFleet(env, task, [{ ...candidate, eligible: true,
      offers: candidate.offers?.map(offer => ({ ...offer, authenticated: true })) ?? null,
      runnerDetails: candidate.runnerDetails === undefined ? undefined : { ...candidate.runnerDetails,
        readiness: { ...candidate.runnerDetails.readiness, state: 'ready' } },
    }], settings, true)).executions.length > 0;
    reason = 'no_runner';
    for (const row of recent) {
      const code = row.runnerDetails?.readiness.code;
      const blocked: QueueReason | null = row.runner?.state === 'paused' ? 'paused'
        : code === 'settling' ? 'settling' : code === 'updating' ? 'updating'
        : code === 'registration' ? 'registration' : row.offers !== null && !row.offers.some(offer => offer.authenticated) ? 'not_signed_in' : null;
      if (blocked !== null && (await potential(row) || (blocked === 'not_signed_in' && row.offers?.length === 0 && row.capabilities !== null
        && capabilitiesRequiredBy(task).every(capability => row.capabilities!.includes(capability))))) {
        reason = blocked;
        break;
      }
      if (row.offers === null || row.capabilities === null || code === 'unknown') reason = 'unavailable';
      else if (reason === 'no_runner') reason = 'model_profile';
    }
  }
  return reason;
}

/** The whole queue is aggregated through its status/queue index; one reason is decided per task and stored hold. */
export async function queueProjection(env: ServerEnv, fleet: readonly WorkerFleetRow[], now: number): Promise<FleetQueue> {
  const [{ results: groups }, settings, limits] = await Promise.all([
    env.db.prepare(`SELECT task, held_by AS held, COUNT(*) AS count, MIN(queued_at) AS oldest, MIN(id) AS id
      FROM agent_runs INDEXED BY idx_fleet_queue WHERE status = 'queued' GROUP BY task, held_by`)
      .all<{ task: string; held: string | null; count: number; oldest: number | null; id: string }>(),
    claimSettings(env), readDispatchLimits(env),
  ]);
  const reasons = new Map<QueueReason, number>();
  let oldestAt: number | null = null;
  let count = 0;
  for (const group of groups) {
    count += group.count;
    if (group.oldest !== null) oldestAt = oldestAt === null ? group.oldest : Math.min(oldestAt, group.oldest);
    const reason = await fleetTaskReason(env, group.task, fleet, now, settings, limits, group.id);
    reasons.set(reason, (reasons.get(reason) ?? 0) + group.count);
  }
  return { observedAt: now, count, oldestAt, reasons: [...reasons].map(([reason, count]) => ({ reason, count })),
    nativeNeedsRunner: count > 0 && env.platform?.name === 'bun' && !fleet.some(row => row.runner?.state === 'enabled') };
}

/** One fleet read supplies every registered runner, the compatibility inventory and queue readiness. */
export async function readFleetProjection(env: ServerEnv, now: number) {
  const fleet = await readWorkerFleet(env.db, now);
  const queue = await queueProjection(env, fleet, now);
  return { observedAt: now, fleet, queue,
    runners: fleet.flatMap(row => row.runnerDetails === undefined ? [] : [row.runnerDetails]),
    legacyWorkers: fleet.filter(row => row.runner === null) };
}
