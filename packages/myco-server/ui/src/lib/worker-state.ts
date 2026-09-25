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

/** A worker counts as attached while it drives a run, or while it is heard from recently on a credential the claim route admits. */
export function isAttached(worker: WorkerRow): boolean {
  return worker.busy !== null || (worker.recent && worker.eligible);
}

/** The latest contact a worker the claim route would admit made, or null when the fleet records none. */
export function lastContactAt(workers: WorkerStatus): number | null {
  const latest = Math.max(0, ...workers.fleet.filter((w) => w.eligible).map((w) => w.lastSeenAt));
  return latest > 0 ? latest : null;
}

/** What waits in the queue, as the headline ends it. */
function queueWords(queued: number, attached: boolean): string {
  if (queued === 0) return 'Nothing queued.';
  const runs = `${queued} queued ${queued === 1 ? 'run' : 'runs'}`;
  return attached ? `${runs}.` : `${runs} ${queued === 1 ? 'waits' : 'wait'} until one attaches.`;
}

/**
 * The fleet in one line: whether any worker is attached, when one was last
 * heard from, and what the queue holds. Only for a Deployment that answered;
 * an unanswered one is `FLEET_UNKNOWN_WORDS.unavailable`.
 */
export function fleetHeadline(workers: WorkerStatus, now: number): { tone: StatusTone; attached: number; line: string } {
  const attached = workers.fleet.filter(isAttached);
  if (attached.length > 0) {
    const busy = attached.filter((w) => w.busy !== null).length;
    return {
      tone: 'sage',
      attached: attached.length,
      line: `${attached.length} ${attached.length === 1 ? 'worker' : 'workers'} attached, ${busy} driving a run. ${queueWords(workers.runsQueued, true)}`,
    };
  }
  const last = lastContactAt(workers);
  const contact = last === null ? FLEET_UNKNOWN_WORDS.absent : `Last worker contact ${sinceWords(last, now)}.`;
  return {
    tone: workers.runsQueued > 0 ? 'terracotta' : 'outline',
    attached: 0,
    line: `No worker attached. ${contact} ${queueWords(workers.runsQueued, false)}`,
  };
}

/** How a person attaches one, said wherever none is attached: the words around the command, and the command. */
export const ATTACH_WORDS = {
  before: 'A worker runs on an administrator\'s machine where a coding agent is logged in. Running',
  command: 'myco worker install',
  after: 'there keeps one running whenever they are logged in.',
} as const;

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
