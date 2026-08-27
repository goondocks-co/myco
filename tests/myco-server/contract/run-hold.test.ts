/**
 * The run-hold rule, which #908 measured the need for.
 *
 * A container's activity timer is reset by incoming requests; compute is not
 * activity. With `sleepAfter` at 90m and no renewal, a compute-bound container
 * stops after 32 seconds; with a renewal it is still working at 788 seconds.
 * The rule below is what the renewing side has to get right, and it is tested
 * apart from any deployed container.
 */
import { describe, expect, it } from 'bun:test';
import {
  decideHold,
  holdDeadline,
  renewIntervalMs,
  HOLD_OVERRUN_MARGIN_MS,
  MAX_RENEW_INTERVAL_MS,
  MIN_RENEW_INTERVAL_MS,
} from '@myco-server-worker/platform/cloudflare/run-hold.js';

const MINUTE = 60_000;

describe('renewal cadence', () => {
  it('renews well inside the window, so one missed alarm does not end a run', () => {
    const sleepAfter = 10 * MINUTE;
    const interval = renewIntervalMs(sleepAfter);

    // Two consecutive misses still land inside the window.
    expect(interval * 2).toBeLessThan(sleepAfter);
  });

  it('never renews less often than the ceiling, however long the window', () => {
    expect(renewIntervalMs(24 * 60 * MINUTE)).toBe(MAX_RENEW_INTERVAL_MS);
  });

  it('never renews more often than the floor, however short the window', () => {
    // A renewal is a Durable Object alarm; a tiny window must not turn into a
    // storm of them.
    expect(renewIntervalMs(1_000)).toBe(MIN_RENEW_INTERVAL_MS);
  });
});

describe('hold deadline', () => {
  it('is the run own timeout plus a margin, not a fixed constant', () => {
    // The executor aborts at `timeoutSeconds`; the margin covers that abort
    // path rather than trusting two clocks to agree.
    expect(holdDeadline(1_000_000, 600)).toBe(1_000_000 + 600_000 + HOLD_OVERRUN_MARGIN_MS);
  });

  it('scales with the task, so a 59-minute run is held and a 1-minute run is not', () => {
    const short = holdDeadline(0, 60);
    const long = holdDeadline(0, 59 * 60);
    expect(long - short).toBe((59 * 60 - 60) * 1000);
  });
});

describe('decideHold', () => {
  const sleepAfter = 10 * MINUTE;
  const state = { runId: 'run_1', holdUntil: 1_000_000 + 30 * MINUTE };

  it('renews while the run is inside its deadline', () => {
    const decision = decideHold(state, 1_000_000, sleepAfter);
    expect(decision.action).toBe('renew');
  });

  it('schedules the next check at the renewal interval', () => {
    const decision = decideHold(state, 1_000_000, sleepAfter);
    expect(decision).toEqual({ action: 'renew', nextCheckAt: 1_000_000 + renewIntervalMs(sleepAfter) });
  });

  it('never schedules a check past the deadline', () => {
    const nearlyDone = { runId: 'run_1', holdUntil: 1_000_000 + 2_000 };
    const decision = decideHold(nearlyDone, 1_000_000, sleepAfter);
    expect(decision).toEqual({ action: 'renew', nextCheckAt: nearlyDone.holdUntil });
  });

  it('releases once the deadline passes — the normal end of a run', () => {
    // Releasing lets the container sleep and stop, which is what makes a
    // per-run container cheap. It is not a failure.
    expect(decideHold(state, state.holdUntil, sleepAfter))
      .toEqual({ action: 'release', reason: 'deadline-passed' });
  });

  it('releases when there is no hold at all', () => {
    // A container with no run attached must not be held alive by a stale alarm.
    expect(decideHold(null, 1_000_000, sleepAfter).action).toBe('release');
  });

  it('GATE: a run inside its deadline is never released', () => {
    // The #908 failure as a property: at every point across a 59-minute run —
    // the longest continuous run observed — the decision must be to renew.
    const startedAt = 1_000_000;
    const holdUntil = holdDeadline(startedAt, 59 * 60);
    const run = { runId: 'run_long', holdUntil };

    for (let t = startedAt; t < holdUntil; t += 30_000) {
      const decision = decideHold(run, t, sleepAfter);
      expect({ t, action: decision.action }).toEqual({ t, action: 'renew' });
    }
  });
});
