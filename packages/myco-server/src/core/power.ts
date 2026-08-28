/**
 * When the Deployment's intelligence should next wake, as policy.
 *
 * The scheduling decision is shared. Only the mechanism that delivers a wake at
 * a chosen instant differs per target, and that lives behind `WakeScheduler`,
 * which #913 and #914 implement. Nothing here knows what a timer is, and
 * nothing here runs a job.
 *
 * **Assertions constrain the state; they never drive it.** Elapsed inactivity
 * decides the natural state, and a held assertion can only pull that shallower
 * or deeper within its own bounds. Letting an assertion drive would collapse
 * the housekeeping tiers: every tier's window exists so work at that depth
 * still happens, and an assertion that set the state outright would erase it.
 *
 * **Stay-awake wins a conflict.** `minDepth` is applied before the `maxDepth`
 * clamp, so an assertion demanding wakefulness beats one permitting sleep.
 * Wrongly sleeping costs real work; wrongly waking costs power, and those are
 * not the same size of mistake.
 *
 * **A wake may arrive more than once.** An alarm can fire twice for one
 * scheduled instant, so acting on a wake has to be idempotent. Resolution here
 * is a pure function of its inputs and holds nothing between calls, which is
 * what makes a repeated wake harmless rather than merely unlikely.
 */

export type PowerState = 'active' | 'idle' | 'sleep' | 'deep_sleep';

export const POWER_STATE_DEPTH: Readonly<Record<PowerState, number>> = {
  active: 0, idle: 1, sleep: 2, deep_sleep: 3,
};

const DEPTH_TO_STATE: readonly PowerState[] = ['active', 'idle', 'sleep', 'deep_sleep'];

export interface PowerAssertion {
  /** Namespaced and stable, so a held assertion is attributable — `drain:embedding-reconcile`. */
  name: string;
  /** The deepest state this assertion permits while it is held. */
  maxDepth: PowerState;
  /** The shallowest state this assertion requires. Applied before `maxDepth`. */
  minDepth?: PowerState;
}

export interface PowerThresholds {
  idleMs: number;
  sleepMs: number;
  deepSleepMs: number;
}

export interface PowerResolution {
  state: PowerState;
  /** The assertion that held the state shallower than inactivity alone would put it, when one did. */
  heldBy: string | null;
}

/**
 * The state elapsed inactivity alone implies, before any assertion is consulted.
 */
export function naturalState(idleMs: number, thresholds: PowerThresholds): PowerState {
  if (idleMs >= thresholds.deepSleepMs) return 'deep_sleep';
  if (idleMs >= thresholds.sleepMs) return 'sleep';
  if (idleMs >= thresholds.idleMs) return 'idle';
  return 'active';
}

/**
 * Resolve the state, given inactivity and whatever is currently asserted.
 *
 * Pure: the same inputs give the same answer, and a second call for one wake
 * changes nothing.
 */
export function resolvePowerState(
  idleMs: number,
  thresholds: PowerThresholds,
  assertions: readonly PowerAssertion[],
): PowerResolution {
  const natural = naturalState(idleMs, thresholds);
  // `active` is the shallowest state: no cap can pull it shallower, so a busy
  // Deployment never pays for the scan.
  if (natural === 'active') return { state: 'active', heldBy: null };

  let cap = POWER_STATE_DEPTH.deep_sleep;
  let capName: string | null = null;
  let floor = POWER_STATE_DEPTH.active;

  for (const assertion of assertions) {
    const max = POWER_STATE_DEPTH[assertion.maxDepth];
    if (max < cap) { cap = max; capName = assertion.name; }
    if (assertion.minDepth !== undefined) {
      const min = POWER_STATE_DEPTH[assertion.minDepth];
      if (min > floor) floor = min;
    }
  }

  let depth = POWER_STATE_DEPTH[natural];
  if (depth < floor) depth = floor;
  let heldBy: string | null = null;
  if (depth > cap) { depth = cap; heldBy = capName; }

  return { state: DEPTH_TO_STATE[depth]!, heldBy };
}

export interface WakeIntervals {
  activeMs: number;
  sleepMs: number;
}

/**
 * When to wake next, or null in deep sleep.
 *
 * **Null is the point of deep sleep, not a missing answer.** No wake scheduled
 * means nothing runs and nothing is billed. A recovery wake is configured
 * separately and externally: a scheduled wake is state the Deployment holds,
 * and a Deployment that never held one has no way back on its own.
 */
export function nextWakeDelayMs(state: PowerState, intervals: WakeIntervals): number | null {
  if (state === 'deep_sleep') return null;
  return state === 'sleep' ? intervals.sleepMs : intervals.activeMs;
}
