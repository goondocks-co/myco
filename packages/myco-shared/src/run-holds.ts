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

const profileUnsupportedHold = {
  key: 'profile_unsupported',
  words: (harness: string) => `waiting for a worker that can apply the execution profile for ${harness}; update this machine's Myco worker if it is older`,
};
const invalidTaskTierHold = {
  key: 'invalid_task_tier',
  words: (task: string) => `this task's tier setting is invalid for ${task}; correct it in Settings or reset the task tier`,
};
const noModelForTierHold = {
  key: 'no_model_for_tier',
  words: (value: string) => {
    const [harness, tier] = value.split(':');
    return `waiting for a model for ${harness}'s ${tier} tier in Settings`;
  },
};
const credentialUnavailableHold = {
  key: 'credential_unavailable',
  words: (harness: string) => `waiting for a usable server login for ${harness}`,
};

const PROFILE_HOLDS = [profileUnsupportedHold, invalidTaskTierHold, noModelForTierHold, credentialUnavailableHold] as const;
const prefixOf = (hold: typeof PROFILE_HOLDS[number]) => `${hold.key}:`;

/** Prefixes of profile and credential holds that can be released when a worker's offer changes. */
export const PROFILE_HOLD_PREFIXES: readonly string[] = PROFILE_HOLDS.map(prefixOf);

const profileHold = (hold: typeof PROFILE_HOLDS[number], ...parts: string[]) => `${prefixOf(hold)}${parts.join(':')}`;

export const profileUnsupported = (harness: string): string => profileHold(profileUnsupportedHold, harness);
export const invalidTaskTier = (task: string): string => profileHold(invalidTaskTierHold, task);
export const noModelForTier = (harness: string, tier: string): string => profileHold(noModelForTierHold, harness, tier);
export const credentialUnavailable = (harness: string): string => profileHold(credentialUnavailableHold, harness);

/** The words for a holder a run names, or null when it names none this Deployment knows. */
export function heldByWords(holder: string | null): string | null {
  if (holder !== null) {
    for (const hold of PROFILE_HOLDS) {
      const prefix = prefixOf(hold);
      if (holder.startsWith(prefix)) return hold.words(holder.slice(prefix.length));
    }
  }
  return holder !== null && holder in HELD_BY_WORDS ? HELD_BY_WORDS[holder as HeldBy] : null;
}
