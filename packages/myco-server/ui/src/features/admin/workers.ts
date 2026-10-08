/**
 * A machine running Myco's work, in the words the admin pages use.
 *
 * Every line is either the task the server has handed a machine or something
 * the machine reported about itself. A reported login is not a tested provider,
 * and a check's outcome describes that one check rather than the queue. A worker is named
 * by its machine and a run by its project's name: never by an id.
 */
import type { HealthTone } from '../../design';
import type { WorkerRow, WorkerStatus } from '../../lib/api';
import { formatUntil } from '../../lib/format';
import { harnessLabel } from '../../lib/harness';

/** Seconds matter for a 2-second poll, so this says them; `formatRelative` starts at "just now". */
function sinceWords(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/** Why the last check for work took nothing, in an owner's words. Each describes that one check, not the whole queue. */
export const REASON_WORDS: Record<NonNullable<WorkerRow['lastReason']>, string> = {
  claimed: 'took a run',
  no_work: 'nothing it could take',
  no_harness: 'the work waiting needs an agent it doesn’t have',
  at_limit: 'a limit was already reached',
  lost_race: 'another machine took it first',
};

/** How a person sets a machine to run Myco's work, said wherever none is: the words around the command, and the command. */
export const ATTACH_WORDS = {
  before: 'Explicitly enroll this machine with myco runner register <address>. Running',
  command: 'myco runner install',
  after: 'starts the enrolled runner at login.',
} as const;

/** What Myco's tasks are called, by the task name a run carries. */
const TASK_WORDS: Readonly<Record<string, string>> = {
  'extract-curate': 'learning',
  'title-summary': 'titling',
  'canopy-map': 'a code map update',
  'embedding-reconcile': 'a search index update',
  'vault-seed': 'seeding',
};

/** A task in words: "learning", "titling", else "a task". */
export const taskWords = (task: string | null): string => (task === null ? 'a task' : TASK_WORDS[task] ?? 'a task');

export interface WorkerNames {
  /** The worker's machine, by name. */
  machine: string;
  /** A project's name, or null where the dashboard does not know it. */
  project: (projectId: string) => string | null;
}

/** One worker's state in one line without its name, and the tone of its dot: for a row that already names its machine. */
export function workerState(worker: WorkerRow, now: number, project: WorkerNames['project']): { tone: HealthTone; line: string } {
  if (worker.busy !== null) {
    const name = project(worker.busy.projectId);
    return {
      tone: 'ok',
      line: `Running ${taskWords(worker.busy.task)}${name === null ? '' : ` in ${name}`} · due to check in within ${formatUntil(worker.busy.leaseExpiresAt, now)}`,
    };
  }
  if (worker.lastSeenAt === 0) return { tone: 'faint', line: 'No contact recorded' };
  if (!worker.recent) return { tone: 'faint', line: `Not checking in now · last checked in ${sinceWords(worker.lastSeenAt, now)}` };
  if (!worker.eligible) return { tone: 'bad', line: `It can’t take work now · last checked in ${sinceWords(worker.lastSeenAt, now)}` };
  // An unreadable report is not a report of nothing: it cannot make a worker read as ready.
  const ready = worker.offers?.some((o) => o.authenticated) === true;
  const polling = worker.offers === null
    ? 'Waiting for work, with no readable report of its agents'
    : ready ? 'Waiting for work' : 'Waiting for work, but reported no agent signed in';
  return { tone: ready ? 'ok' : 'bad', line: `${polling} · last checked in ${sinceWords(worker.lastSeenAt, now)}` };
}

/** The credential class the executor reports. */
export function workerKindWords(worker: Pick<WorkerRow, 'runner'>): string {
  return worker.runner ? 'Registered runner' : 'Legacy worker — uses member credential';
}

/** One worker's state in one line, led by its machine's name, and the tone of its dot. */
export function workerLine(worker: WorkerRow, now: number, names: WorkerNames): { tone: HealthTone; line: string } {
  const state = workerState(worker, now, names.project);
  return { tone: state.tone, line: `${worker.runner ? worker.runner.name : names.machine} · ${workerKindWords(worker)} · ${state.line}` };
}

/** Why the last claim took nothing, when it took nothing: that poll's answer, never the queue's. */
export function lastClaimWords(worker: WorkerRow): string | null {
  if (worker.busy !== null || worker.lastReason === null || worker.lastSeenAt === 0) return null;
  return `Last check for work: ${REASON_WORDS[worker.lastReason]}.`;
}

/**
 * The agents a worker reported signed in, in words. It is the machine's own
 * report: whether each agent's provider answers is not tested, and the words
 * say so.
 */
export function agentsWords(worker: WorkerRow): string {
  if (worker.offers === null) return 'Which agents it can run is unknown.';
  const signedIn = worker.offers.filter((o) => o.authenticated).map((o) => harnessLabel(o.id));
  if (signedIn.length === 0) return worker.offers.length === 0 ? 'Reported no agents.' : 'Reported no agent signed in.';
  const names = signedIn.length === 1 ? signedIn[0]! : `${signedIn.slice(0, -1).join(', ')} and ${signedIn[signedIn.length - 1]}`;
  return `Reports ${names} signed in; their providers aren’t tested here.`;
}

/** A worker counts as attached while it drives a run, or while it is heard from lately on a credential the claim route admits. */
export function isAttached(worker: WorkerRow): boolean {
  return worker.busy !== null || (worker.recent && worker.eligible);
}

/** The fleet in one line, and its tone: how many machines run Myco's work, and what waits. */
export function fleetLine(workers: WorkerStatus, now: number): { tone: HealthTone; attached: number; line: string } {
  const attached = workers.fleet.filter(isAttached);
  const queued = workers.runsQueued;
  const waiting = queued === 0 ? 'Nothing is waiting.' : `${queued} ${queued === 1 ? 'task is' : 'tasks are'} waiting.`;
  if (attached.length > 0) {
    const busy = attached.filter((w) => w.busy !== null).length;
    return {
      tone: 'ok',
      attached: attached.length,
      line: `${attached.length} ${attached.length === 1 ? 'machine is' : 'machines are'} running Myco’s work, ${busy} busy now. ${waiting}`,
    };
  }
  const last = Math.max(0, ...workers.fleet.filter((w) => w.eligible).map((w) => w.lastSeenAt));
  const contact = last > 0 ? `A machine last checked in ${sinceWords(last, now)}.` : 'No machine has checked in yet.';
  return { tone: queued > 0 ? 'bad' : 'faint', attached: 0, line: `No machine is running Myco’s work. ${contact} ${waiting}` };
}
