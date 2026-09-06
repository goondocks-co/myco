/**
 * Wake policy: the state resolution and the jobs each depth admits.
 */
import { describe, expect, it } from 'bun:test';
import {
  naturalState, nextWakeDelayMs, resolvePowerState, type PowerAssertion,
} from '@myco-server-worker/core/power.js';
import { jobRunsAt, jobsDueAt, SERVER_JOBS, DEFERRED_JOBS } from '@myco-server-worker/core/jobs.js';
import { JOB_IMPLEMENTATIONS } from '@myco-server-worker/core/jobs-run.js';

const THRESHOLDS = { idleMs: 60_000, sleepMs: 300_000, deepSleepMs: 3_600_000 };
const INTERVALS = { activeMs: 30_000, sleepMs: 300_000 };
const hold = (name: string, over: Partial<PowerAssertion> = {}): PowerAssertion =>
  ({ name, maxDepth: 'deep_sleep', ...over });

describe('the natural state', () => {
  it('deepens with elapsed inactivity alone', () => {
    expect(naturalState(0, THRESHOLDS)).toBe('active');
    expect(naturalState(60_000, THRESHOLDS)).toBe('idle');
    expect(naturalState(300_000, THRESHOLDS)).toBe('sleep');
    expect(naturalState(3_600_000, THRESHOLDS)).toBe('deep_sleep');
  });
});

describe('assertions constrain the state, never drive it', () => {
  it('cannot deepen a state that inactivity has not reached', () => {
    // An assertion permitting deep sleep does not cause it while the
    // Deployment has only just gone idle.
    expect(resolvePowerState(60_000, THRESHOLDS, [hold('permits', { maxDepth: 'deep_sleep' })]).state).toBe('idle');
  });

  it('holds a sleeping Deployment shallower, and names what held it', () => {
    const r = resolvePowerState(3_600_000, THRESHOLDS, [hold('drain:embedding-reconcile', { maxDepth: 'sleep' })]);
    expect(r).toEqual({ state: 'sleep', heldBy: 'drain:embedding-reconcile' });
  });

  it('never reports a holder when inactivity alone decided', () => {
    expect(resolvePowerState(300_000, THRESHOLDS, []).heldBy).toBeNull();
  });

  it('skips the scan entirely while active, where no cap could apply', () => {
    expect(resolvePowerState(0, THRESHOLDS, [hold('x', { maxDepth: 'sleep' })])).toEqual({ state: 'active', heldBy: null });
  });
});

describe('stay-awake wins a conflict', () => {
  /**
   * The orders differ only when the floor sits DEEPER than the cap:
   * floor-then-cap is `min(max(d,f), c)`, cap-then-floor is `max(min(d,c), f)`.
   * With floor `sleep` (2) and cap `idle` (1) they give idle and sleep. Any
   * case where the floor is shallower than the cap resolves identically under
   * both, and would prove nothing.
   */
  it('applies minDepth before the maxDepth clamp, taking the shallower answer', () => {
    const r = resolvePowerState(3_600_000, THRESHOLDS, [
      hold('permits-sleep', { maxDepth: 'deep_sleep', minDepth: 'sleep' }),
      hold('caps-at-idle', { maxDepth: 'idle' }),
    ]);
    expect(r.state).toBe('idle');
  });

  // The shallowest cap is declared FIRST, so a resolver that simply kept the
  // last one it saw would answer `sleep` and name the wrong holder.
  it('takes the shallowest cap when several apply, whatever order they arrive in', () => {
    const r = resolvePowerState(3_600_000, THRESHOLDS, [
      hold('shallowest', { maxDepth: 'idle' }),
      hold('deeper', { maxDepth: 'sleep' }),
    ]);
    expect(r).toEqual({ state: 'idle', heldBy: 'shallowest' });
  });
});

describe('a repeated wake is harmless', () => {
  it('resolves identically for identical inputs, holding nothing between calls', () => {
    const assertions = [hold('a', { maxDepth: 'sleep' })];
    const first = resolvePowerState(3_600_000, THRESHOLDS, assertions);
    const second = resolvePowerState(3_600_000, THRESHOLDS, assertions);
    expect(second).toEqual(first);
  });
});

describe('the next wake', () => {
  it('is null in deep sleep, which is what deep sleep means', () => {
    expect(nextWakeDelayMs('deep_sleep', INTERVALS)).toBeNull();
  });

  it('is the sleep interval while sleeping and the active one otherwise', () => {
    expect(nextWakeDelayMs('sleep', INTERVALS)).toBe(300_000);
    expect(nextWakeDelayMs('idle', INTERVALS)).toBe(30_000);
    expect(nextWakeDelayMs('active', INTERVALS)).toBe(30_000);
  });
});

describe('what runs at each depth', () => {
  it('runs nothing at all in deep sleep', () => {
    expect(jobsDueAt('deep_sleep')).toEqual([]);
  });

  /**
   * Deep sleep running nothing is a property of the JOBS, not of a guard beside
   * them: no job declares it runs that deep, so the depth comparison alone
   * excludes every one. A separate `if (deep_sleep) return false` would read as
   * the protection while the declarations were the thing actually providing it.
   */
  it('declares no job that runs into deep sleep, which is what makes deep sleep free', () => {
    expect(SERVER_JOBS.filter((j) => j.runsThrough === 'deep_sleep')).toEqual([]);
  });

  it('holds the model-calling job back to a Deployment in use, once its owner gives it work', () => {
    const embedding = SERVER_JOBS.find((j) => j.name === 'embedding-reconcile');
    expect(embedding?.runsThrough).toBe('idle');
    expect(jobRunsAt('embedding-reconcile', 'idle')).toBe(true);
  });

  it('still runs query-only housekeeping while sleeping', () => {
    expect(jobsDueAt('sleep').map((j) => j.name)).toEqual(['agent-run-retention', 'run-stale-sweep']);
  });

  it('gives every job the tick runs an implementation, and names no deferred job twice', () => {
    for (const job of SERVER_JOBS) expect({ job: job.name, implemented: typeof JOB_IMPLEMENTATIONS[job.name] }).toEqual({ job: job.name, implemented: 'function' });
    const declared = new Set(SERVER_JOBS.map((j) => j.name));
    for (const job of DEFERRED_JOBS) expect(declared.has(job.name)).toBe(false);
  });

  it('answers false for a job this Deployment does not run', () => {
    expect(jobRunsAt('canopy-background-scan', 'active')).toBe(false);
    expect(jobRunsAt('invented', 'active')).toBe(false);
  });

  it('states what every job converges toward, so its idempotence is checkable', () => {
    expect(SERVER_JOBS.filter((j) => j.converges.trim().length === 0)).toEqual([]);
    expect(SERVER_JOBS).toHaveLength(4);
  });
});
