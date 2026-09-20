import { harnessLabel } from './harness';
import type { WorkerRow, WorkerStatus } from './api';
import type { StatusTone } from '../components/ui/status-dot';

/**
 * The words every surface names a worker with.
 *
 * Each line is either a lease the Deployment holds or something the worker
 * reported about its own machine. A reported login is not a tested provider, and
 * a claim's outcome describes that poll rather than the queue.
 */

/** Seconds matter for a 2-second poll, so this says them; `formatRelative` starts at "just now". */
export function sinceWords(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/** Whether the credential a run names still holds it: `lapsed` is a recorded holder whose lease has expired, which a row keeps naming until the sweep. */
export type LeaseStanding = 'held' | 'lapsed' | 'none';

export function leaseStanding(leasedBy: string | null, expiresAt: number | null, now: number): LeaseStanding {
  if (leasedBy === null) return 'none';
  return expiresAt !== null && expiresAt > now ? 'held' : 'lapsed';
}

/** A lease runs in seconds and renews on a 30s heartbeat, so it is counted in seconds until a couple of minutes out. */
export function untilWords(at: number, now: number): string {
  const delta = at - now;
  if (delta <= 0) return 'now';
  return delta < 120_000 ? `${Math.round(delta / 1000)}s` : `${Math.floor(delta / 60_000)}m`;
}

/** Why the last claim took nothing, in the words an owner reads. Each describes THAT poll, not the whole queue. */
export const REASON_WORDS: Record<NonNullable<WorkerRow['lastReason']>, string> = {
  claimed: 'took a run',
  no_work: 'nothing it could take',
  no_harness: 'no matching harness',
  at_limit: 'a limit was already held',
  lost_race: 'another worker took it first',
};

/** The name a person reads for a worker: the machine it named, or the credential that is all the Deployment holds. */
export function workerName(worker: WorkerRow): string {
  return worker.machineId ?? worker.credentialId;
}

/**
 * What the worker said about its harnesses, and nothing more. A harness it did
 * not report authenticated is listed as exactly that: the claim carries no
 * statement about whether the tool is installed.
 */
export function offersWords(worker: WorkerRow): string {
  if (worker.offers === null) return worker.lastSeenAt === 0 ? 'Offers unknown: this worker has reported none.' : 'Offers unknown: the stored report could not be read.';
  if (worker.offers.length === 0) return 'Reported no harnesses.';
  const authenticated = worker.offers.filter((o) => o.authenticated).map((o) => harnessLabel(o.id));
  const rest = worker.offers.filter((o) => !o.authenticated).map((o) => harnessLabel(o.id));
  const reported = authenticated.length === 0
    ? `Reported not authenticated: ${rest.join(', ')}.`
    : `Reported authenticated: ${authenticated.join(', ')}.${rest.length === 0 ? '' : ` Reported not authenticated: ${rest.join(', ')}.`}`;
  return `${reported} Provider access has not been tested by this check.`;
}

/** The one line that names a worker's state, and the tone that goes with it. */
export function workerState(worker: WorkerRow, now: number): { tone: StatusTone; line: string } {
  const name = workerName(worker);
  if (worker.busy !== null) {
    const task = worker.busy.task ?? 'a run';
    return { tone: 'sage', line: `${name} · Running ${task} for ${worker.busy.projectId} · Lease expires in ${untilWords(worker.busy.leaseExpiresAt, now)}` };
  }
  if (worker.lastSeenAt === 0) return { tone: 'outline', line: `${name} · No contact recorded` };
  if (!worker.recent) return { tone: 'outline', line: `${name} · Not seen recently · Last contact ${sinceWords(worker.lastSeenAt, now)}` };
  if (!worker.eligible) return { tone: 'terracotta', line: `${name} · A claim from it would be refused now · Last contact ${sinceWords(worker.lastSeenAt, now)}` };
  // An unreadable report is not a report of nothing: it cannot make a worker read as ready.
  const ready = worker.offers?.some((o) => o.authenticated) === true;
  const polling = worker.offers === null
    ? 'Polling, with no readable report of its harnesses'
    : ready ? 'Polling for work' : 'Polling, but reported no harness authenticated';
  return {
    tone: ready ? 'sage' : 'terracotta',
    line: `${name} · ${polling} · Last contact ${sinceWords(worker.lastSeenAt, now)}`,
  };
}

/**
 * What the fleet says about one credential. `unavailable` is a Deployment that
 * could not be asked; `absent` is an answer holding no observation of it, which
 * a bounded retention alone produces.
 */
export type FleetLookup =
  | { known: true; worker: WorkerRow }
  | { known: false; why: 'unavailable' | 'absent' };

export function workerFor(workers: WorkerStatus | undefined, credentialId: string | null): FleetLookup {
  if (workers === undefined || !workers.available) return { known: false, why: 'unavailable' };
  if (credentialId === null) return { known: false, why: 'absent' };
  const worker = workers.fleet.find((row) => row.credentialId === credentialId);
  return worker === undefined ? { known: false, why: 'absent' } : { known: true, worker };
}

/** What a surface says where the fleet holds nothing to say. */
export const FLEET_UNKNOWN_WORDS: Readonly<Record<'unavailable' | 'absent', string>> = {
  unavailable: 'Worker contact unavailable — this server could not be asked, so nothing here is known.',
  absent: 'No worker contact recorded.',
};
