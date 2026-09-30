/**
 * A machine running Myco's work, in the words the admin pages use.
 *
 * Every line is either a lease the Deployment holds or something the machine
 * reported about itself. A reported login is not a tested provider, and a
 * claim's outcome describes that poll rather than the queue. A worker is named
 * by its machine and a run by its project's name: never by an id.
 */
import type { HealthTone } from '../../design';
import type { WorkerRow, WorkerStatus } from '../../lib/api';
import { formatUntil } from '../../lib/format';
import { harnessLabel } from '../../lib/harness';
import { REASON_WORDS, sinceWords } from '../../lib/worker-state';

export { offersWords, REASON_WORDS, ATTACH_WORDS } from '../../lib/worker-state';

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

/** One worker's state in one line, and the tone of its dot. */
export function workerLine(worker: WorkerRow, now: number, names: WorkerNames): { tone: HealthTone; line: string } {
  const { machine } = names;
  if (worker.busy !== null) {
    const project = names.project(worker.busy.projectId);
    return {
      tone: 'ok',
      line: `${machine} · Running ${taskWords(worker.busy.task)}${project === null ? '' : ` in ${project}`} · lease ends in ${formatUntil(worker.busy.leaseExpiresAt, now)}`,
    };
  }
  if (worker.lastSeenAt === 0) return { tone: 'faint', line: `${machine} · No contact recorded` };
  if (!worker.recent) return { tone: 'faint', line: `${machine} · Not heard from lately · last contact ${sinceWords(worker.lastSeenAt, now)}` };
  if (!worker.eligible) return { tone: 'bad', line: `${machine} · Its claims would be refused now · last contact ${sinceWords(worker.lastSeenAt, now)}` };
  // An unreadable report is not a report of nothing: it cannot make a worker read as ready.
  const ready = worker.offers?.some((o) => o.authenticated) === true;
  const polling = worker.offers === null
    ? 'Waiting for work, with no readable report of its agents'
    : ready ? 'Waiting for work' : 'Waiting for work, but reported no agent signed in';
  return { tone: ready ? 'ok' : 'bad', line: `${machine} · ${polling} · last contact ${sinceWords(worker.lastSeenAt, now)}` };
}

/** Why the last claim took nothing, when it took nothing: that poll's answer, never the queue's. */
export function lastClaimWords(worker: WorkerRow): string | null {
  if (worker.busy !== null || worker.lastReason === null || worker.lastSeenAt === 0) return null;
  return `Last check for work: ${REASON_WORDS[worker.lastReason]}.`;
}

/** The agents a worker reported signed in, in words. */
export function agentsWords(worker: WorkerRow): string {
  if (worker.offers === null) return 'Which agents it can run is unknown.';
  const signedIn = worker.offers.filter((o) => o.authenticated).map((o) => harnessLabel(o.id));
  if (signedIn.length === 0) return worker.offers.length === 0 ? 'Reported no agents.' : 'Reported no agent signed in.';
  return `Can run ${signedIn.join(', ')}.`;
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
