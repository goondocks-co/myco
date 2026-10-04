/**
 * What can hold a queued run, and each as one sentence in the reader's words.
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
import { harnessName, PROFILE_HARNESSES } from './execution-profile.js';
import { REPOSITORY_CHECKOUT_CAPABILITY, REPOSITORY_DIGESTS_CAPABILITY } from './repository.js';

export type HeldBy = 'concurrent_runs' | 'task_concurrent_runs' | 'task_runs_per_hour' | 'fleet' | 'runtime' | 'worker' | CapabilityHold;

/** A run held for a worker capability is held by the capability's own name. */
export type CapabilityHold = typeof REPOSITORY_CHECKOUT_CAPABILITY | typeof REPOSITORY_DIGESTS_CAPABILITY;

/** Every holder that names a capability, in the order a run is checked for them. */
export const CAPABILITY_HOLDS: readonly CapabilityHold[] = [REPOSITORY_CHECKOUT_CAPABILITY, REPOSITORY_DIGESTS_CAPABILITY];

/**
 * Each holder as one sentence a reader meets wherever a run waits: in a run's
 * panel, on its line after a start, in the confirmation before one and beside
 * a task's model. Whole sentences, in the reader's words, naming an agent by
 * its name and never by its id.
 */
export const HELD_BY_WORDS: Readonly<Record<HeldBy, string>> = {
  concurrent_runs: 'Waiting for a free slot: this server is already running as many tasks at once as it allows.',
  task_concurrent_runs: 'Waiting for another run of this task to finish first.',
  task_runs_per_hour: 'Waiting until this task’s hourly limit allows another run.',
  fleet: 'Waiting for a free machine: every machine that runs tasks is busy.',
  runtime: 'This server isn’t taking runs right now.',
  worker: 'Waiting for a machine to pick it up.',
  [REPOSITORY_CHECKOUT_CAPABILITY]: 'Waiting for a machine that can read the repository. None that checked in lately can.',
  [REPOSITORY_DIGESTS_CAPABILITY]: 'Waiting for an up-to-date machine. The machines that checked in lately run a Myco too old to run it, so update Myco there.',
};

/** Whether an agent lets a run choose its model at all. */
const choosesModel = (harness: string): boolean => (PROFILE_HARNESSES[harness]?.allowedEfforts.length ?? 0) > 0;

const profileUnsupportedHold = {
  key: 'profile_unsupported',
  words: (harness: string) => choosesModel(harness)
    ? `That machine’s Myco is too old to use the chosen model with ${harnessName(harness)}. Update it.`
    : `${harnessName(harness)} can’t use a chosen model, so it won’t run this task.`,
};
const invalidTaskTierHold = {
  key: 'invalid_task_tier',
  words: () => 'This task’s tier setting isn’t valid. Correct it in Settings, or reset the task’s tier.',
};
const noModelForTierHold = {
  key: 'no_model_for_tier',
  words: (value: string) => {
    const [harness = '', tier = ''] = value.split(':');
    return `${harnessName(harness)} has no model chosen for the ${tier} tier. Choose one in Settings.`;
  },
};
const credentialUnavailableHold = {
  key: 'credential_unavailable',
  words: (harness: string) => `${harnessName(harness)} has no sign-in this server can use. Add one in Settings.`,
};

const sourceReadUnavailableHold = {
  key: 'source_read_unavailable',
  words: (harness: string) => `${harnessName(harness)} cannot safely read repository source. Choose another agent for this task.`,
};

const PROFILE_HOLDS = [profileUnsupportedHold, invalidTaskTierHold, noModelForTierHold, credentialUnavailableHold, sourceReadUnavailableHold] as const;
const prefixOf = (hold: typeof PROFILE_HOLDS[number]) => `${hold.key}:`;

/** Prefixes of profile and credential holds that can be released when a worker's offer changes. */
export const PROFILE_HOLD_PREFIXES: readonly string[] = PROFILE_HOLDS.map(prefixOf);

const profileHold = (hold: typeof PROFILE_HOLDS[number], ...parts: string[]) => `${prefixOf(hold)}${parts.join(':')}`;

export const profileUnsupported = (harness: string): string => profileHold(profileUnsupportedHold, harness);
export const invalidTaskTier = (task: string): string => profileHold(invalidTaskTierHold, task);
export const noModelForTier = (harness: string, tier: string): string => profileHold(noModelForTierHold, harness, tier);
export const sourceReadUnavailable = (harness: string): string => profileHold(sourceReadUnavailableHold, harness);
export const credentialUnavailable = (harness: string): string => profileHold(credentialUnavailableHold, harness);

/** The sentence for a holder a run names, or null when it names none this Deployment knows. */
export function holdSentence(holder: string | null): string | null {
  if (holder !== null) {
    for (const hold of PROFILE_HOLDS) {
      const prefix = prefixOf(hold);
      if (holder.startsWith(prefix)) return hold.words(holder.slice(prefix.length));
    }
  }
  return holder !== null && Object.hasOwn(HELD_BY_WORDS, holder) ? HELD_BY_WORDS[holder as HeldBy] : null;
}
