/**
 * A machine running Myco's work, in the words the admin pages use.
 *
 * Every line is either the task the server has handed a machine or something
 * the machine reported about itself. A reported login is not a tested provider,
 * and a check's outcome describes that one check rather than the queue. A worker is named
 * by its machine and a run by its project's name: never by an id.
 */
import type { WorkerRow } from '../../lib/api';
import { harnessLabel } from '../../lib/harness';

/** Why the last check for work took nothing, in an owner's words. Each describes that one check, not the whole queue. */
export const REASON_WORDS: Record<NonNullable<WorkerRow['lastReason']>, string> = {
  claimed: 'took a run',
  no_work: 'nothing it could take',
  no_harness: 'the work waiting needs an agent it doesn’t have',
  at_limit: 'a limit was already reached',
  lost_race: 'another machine took it first',
  paused: 'paused; assigned work may finish',
};

/** What Myco's tasks are called, by the task name a run carries. */
const TASK_WORDS: Readonly<Record<string, string>> = {
  'extract-curate': 'learning',
  'title-summary': 'titling',
  'canopy-map': 'a code map update',
  'embedding-reconcile': 'a search index update',
  'vault-seed': 'seeding',
  'turn-cards': 'learning turn cards',
  'curate-spores': 'curating overlapping spores',
  'curate-plans': 'curating stale plans',
};

/** A task in words: "learning", "titling", else "a task". */
export const taskWords = (task: string | null): string => (task === null ? 'a task' : TASK_WORDS[task] ?? 'a task');

export const LEGACY_WORKER_LABEL = 'Legacy worker — uses member credential';

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
