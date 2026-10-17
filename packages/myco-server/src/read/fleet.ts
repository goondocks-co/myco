import { capabilitiesRequiredBy } from '@goondocks/myco-shared/repository';
import { runnerAgentLoginReady, runnerDisplay, type FleetQueue, type QueueReason } from '@goondocks/myco-shared/runner-fleet';
import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';
import type { ServerEnv } from '../core/adapters.js';
import { readWorkerFleet, fleetReports, type WorkerFleetRow } from '../core/worker-contacts.js';
import { availableLogin, claimSettings, previewSelection } from '../core/worker-selection.js';
import { harnessCredentialAvailability } from '../core/secrets.js';
import { dispatchLoad } from '../core/runs.js';
import { heldBy, readDispatchLimits, type DispatchLimits } from '../core/limits.js';

/** One fleet request shares stored-slot availability only when its viewer may administer sign-in. */
export function fleetSelectionContext(env: ServerEnv, includeSignIn = false) {
  const available = includeSignIn ? harnessCredentialAvailability(env.db, env.wrappingKey) : async () => false;
  return { includeSignIn, available, login: availableLogin(available) };
}

/** Selection uses the claim's profile and login rules and receives only stored-login availability. */
export function previewFleet(env: ServerEnv, task: string, fleet: readonly WorkerFleetRow[], settings: ReadonlyMap<string, string>, includeBusy = false,
  selection = fleetSelectionContext(env)) {
  return previewSelection(task, fleetReports(fleet, includeBusy), settings, () => selection.login);
}

/** The current wait for this exact task, using the same fleet and admission facts as the queue. */
export async function fleetTaskReason(env: ServerEnv, task: string, fleet: readonly WorkerFleetRow[], now: number,
  settings: ReadonlyMap<string, string>, limits: DispatchLimits, exclude?: string, selection = fleetSelectionContext(env)): Promise<QueueReason> {
  const ceiling = heldBy(await dispatchLoad(env.db, task, now, exclude), limits);
  let reason: QueueReason;
  if (ceiling !== null) reason = 'dispatch_ceiling';
  else if ((await previewFleet(env, task, fleet, settings, false, selection)).executions.length > 0) reason = 'ready';
  else if ((await previewFleet(env, task, fleet, settings, true, selection)).executions.length > 0) reason = 'capacity';
  else if (selection.includeSignIn && (await previewFleet(env, task, fleet, settings, false, selection)).heldBy?.startsWith('credential_unavailable:')) reason = 'credential_unavailable';
  else {
    const recent = fleet.filter(row => row.recent && (row.runner === null ? row.eligible : row.runner.state !== 'removed'));
    const potential = async (candidate: WorkerFleetRow) => (await previewFleet(env, task, [{ ...candidate, eligible: true,
      offers: candidate.offers?.map(offer => ({ ...offer, authenticated: true })) ?? null,
      runnerDetails: candidate.runnerDetails === undefined ? undefined : { ...candidate.runnerDetails,
        readiness: { ...candidate.runnerDetails.readiness, state: 'ready' } },
    }], settings, true, selection)).executions.length > 0;
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
export async function queueProjection(env: ServerEnv, fleet: readonly WorkerFleetRow[], now: number, selection = fleetSelectionContext(env)): Promise<FleetQueue> {
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
    const reason = await fleetTaskReason(env, group.task, fleet, now, settings, limits, group.id, selection);
    reasons.set(reason, (reasons.get(reason) ?? 0) + group.count);
  }
  return { observedAt: now, count, oldestAt, reasons: [...reasons].map(([reason, count]) => ({ reason, count })),
    nativeNeedsRunner: count > 0 && env.platform?.name === 'bun' && !fleet.some(row => row.runner?.state === 'enabled') };
}

/** Chosen stored sources affect readiness only through their slot's current usability. */
export async function applyFleetSignInAvailability(fleet: readonly WorkerFleetRow[], now: number, available: (agent: string) => Promise<boolean>): Promise<void> {
  const agents = new Set(fleet.flatMap(row => row.runnerDetails?.readiness.state === 'ready'
    ? row.offers?.filter(offer => row.runnerDetails?.credentialChoices?.[offer.id] === 'stored').map(offer => offer.id) ?? [] : []));
  const storedCredentials = Object.fromEntries(await Promise.all([...agents].map(async agent => [agent, await available(agent)] as const)));
  for (const row of fleet) {
    const runner = row.runnerDetails;
    if (runner === undefined || runner.readiness.state !== 'ready' || runner.offers === null
      || runner.offers.some(offer => runnerAgentLoginReady(offer, runner.credentialChoices, storedCredentials))) continue;
    runner.readiness = { state: 'unknown', code: 'credential_unavailable', reason: 'The chosen stored key is unavailable for this agent. Add a usable key in Settings or change its sign-in on Runners.', observedAt: now };
    runner.display = runnerDisplay(runner);
  }
}

/** One fleet read supplies every registered runner, the compatibility inventory and queue readiness. */
export async function readFleetProjection(env: ServerEnv, now: number, includeStoredCredentials = false) {
  const selection = fleetSelectionContext(env, includeStoredCredentials);
  const fleet = await readWorkerFleet(env.db, now, selection.includeSignIn);
  const storedCredentials = includeStoredCredentials ? Object.fromEntries(await Promise.all(Object.keys(HARNESS_CREDENTIALS)
    .map(async agent => [agent, await selection.available(agent)] as const))) : undefined;
  if (includeStoredCredentials) await applyFleetSignInAvailability(fleet, now, selection.available);
  const queue = await queueProjection(env, fleet, now, selection);
  return { observedAt: now, fleet, queue, ...(includeStoredCredentials ? { storedCredentials } : {}),
    runners: fleet.flatMap(row => row.runnerDetails === undefined ? [] : [row.runnerDetails]),
    legacyWorkers: fleet.filter(row => row.runner === null) };
}
