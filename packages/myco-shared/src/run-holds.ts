/**
 * What can hold a queued run, and each in the reader's words.
 *
 * A value both the server and the dashboard read at RUNTIME, so it lives in the
 * shared package rather than in either. The dashboard's build stage carries this
 * package whole; it carries the server's own source only by a hand-listed file,
 * so a runtime import reaching into the server cannot resolve in the container
 * image. A type-only import can, having been erased before the bundler looks.
 *
 * Three are limits an owner sets, one is the size of what the operator
 * deployed, `runtime` is a runtime that will not take a run at this instant,
 * and `worker` is the ordinary state of a run that no front door launches: it
 * waits in the claim queue for a worker to take it.
 */
export type HeldBy = 'concurrent_runs' | 'task_concurrent_runs' | 'task_runs_per_hour' | 'fleet' | 'runtime' | 'worker';

export const HELD_BY_WORDS: Readonly<Record<HeldBy, string>> = {
  concurrent_runs: 'the limit on runs at once',
  task_concurrent_runs: 'the limit on runs of this task at once',
  task_runs_per_hour: 'the limit on runs of this task per hour',
  fleet: 'the size of the fleet',
  runtime: 'the runtime is not taking a run right now',
  worker: 'waiting for a worker to claim it',
};

/** The words for a holder a run names, or null when it names none this Deployment knows. */
export function heldByWords(holder: string | null): string | null {
  return holder !== null && holder in HELD_BY_WORDS ? HELD_BY_WORDS[holder as HeldBy] : null;
}
