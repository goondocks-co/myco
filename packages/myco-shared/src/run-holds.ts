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
 * waits in the claim queue for a worker to take it. The worker capabilities
 * (`repository.ts`) hold a run that only a worker reporting one can take,
 * while no worker heard from lately reports it.
 */
import { REPOSITORY_CHECKOUT_CAPABILITY, REPOSITORY_DIGESTS_CAPABILITY } from './repository.js';

export type HeldBy = 'concurrent_runs' | 'task_concurrent_runs' | 'task_runs_per_hour' | 'fleet' | 'runtime' | 'worker' | CapabilityHold;

/** A run held for a worker capability is held by the capability's own name. */
export type CapabilityHold = typeof REPOSITORY_CHECKOUT_CAPABILITY | typeof REPOSITORY_DIGESTS_CAPABILITY;

/** Every holder that names a capability, in the order a run is checked for them. */
export const CAPABILITY_HOLDS: readonly CapabilityHold[] = [REPOSITORY_CHECKOUT_CAPABILITY, REPOSITORY_DIGESTS_CAPABILITY];

export const HELD_BY_WORDS: Readonly<Record<HeldBy, string>> = {
  concurrent_runs: 'the limit on runs at once',
  task_concurrent_runs: 'the limit on runs of this task at once',
  task_runs_per_hour: 'the limit on runs of this task per hour',
  fleet: 'the size of the fleet',
  runtime: 'this server is not taking a run right now',
  worker: 'waiting for a worker to claim it',
  [REPOSITORY_CHECKOUT_CAPABILITY]: 'waiting for a worker that can read the repository; none heard from lately can',
  [REPOSITORY_DIGESTS_CAPABILITY]: 'waiting for an up-to-date worker; the workers heard from lately are too old to run it',
};

/** The words for a holder a run names, or null when it names none this Deployment knows. */
export function heldByWords(holder: string | null): string | null {
  return holder !== null && holder in HELD_BY_WORDS ? HELD_BY_WORDS[holder as HeldBy] : null;
}
