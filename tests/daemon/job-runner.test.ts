/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, it, expect } from 'bun:test';
import { JobRunner, type RunnerJob } from '@myco/daemon/job-runner.js';
import type { Logger } from '@myco/daemon/logger.js';
import type { PowerState } from '@myco/daemon/power.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

function noopJob(name: string, overrides: Partial<RunnerJob> = {}): RunnerJob {
  return {
    name, runIn: ['active', 'idle', 'sleep'], kind: 'housekeeping',
    fn: async () => {}, ...overrides,
  };
}

describe('JobRunner registration', () => {
  it('register + replaceGroup manage the job set', () => {
    const r = new JobRunner({ concurrency: 3, logger: silentLogger(), clock: () => 0 });
    r.register(noopJob('a'));
    r.replaceGroup('scheduled:', [noopJob('scheduled:tasks')]);
    r.register(noopJob('scheduled:legacy'));
    r.replaceGroup('scheduled:', [noopJob('scheduled:tasks')]); // drops scheduled:legacy
    expect(r.jobNames().sort()).toEqual(['a', 'scheduled:tasks']);
  });
});

function silentLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

describe('JobRunner dispatch', () => {
  it('dispatches eligible-for-state jobs detached, never exceeding the cap', async () => {
    const release: Array<() => void> = [];
    const make = (name: string, runIn: PowerState[] = ['sleep']): RunnerJob => ({
      name, runIn, kind: 'housekeeping',
      fn: () => new Promise<void>((res) => release.push(res)),
    });
    const r = new JobRunner({ concurrency: 2, logger: silentLogger(), clock: () => 0 });
    r.register(make('a')); r.register(make('b')); r.register(make('c'));
    r.register(make('active-only', ['active']));

    r.dispatch('sleep');
    expect(r.inFlightNames().sort()).toEqual(['a', 'b']); // c blocked by cap, active-only ineligible

    release.shift()!();                 // a resolves
    await Promise.resolve();            // let the .then cleanup drain the microtask queue
    r.dispatch('sleep');
    expect(r.inFlightNames().sort()).toEqual(['b', 'c']);
  });
});

describe('JobRunner fairness', () => {
  it('reserves a slot for drain/scheduler work so housekeeping cannot starve it', () => {
    const r = new JobRunner({ concurrency: 2, logger: silentLogger(), clock: () => 0 });
    const hang = (name: string, kind: 'housekeeping' | 'drain'): RunnerJob => ({
      name, runIn: ['sleep'], kind,
      drain: kind === 'drain' ? { slice: 10 } : undefined,
      fn: () => new Promise<void>(() => {}), // never resolves
    });
    r.register(hang('release-provenance', 'housekeeping'));
    r.register(hang('backup', 'housekeeping'));
    r.register(hang('embedding', 'drain'));

    r.dispatch('sleep');
    const inFlight = r.inFlightNames();
    expect(inFlight).toContain('embedding');                          // the drain got a slot
    expect(inFlight.length).toBe(2);                                  // cap respected
    expect(inFlight.filter((n) => n !== 'embedding').length).toBe(1); // only ONE housekeeping
  });

  it('cap=3: 3 foreground + 2 housekeeping — each lane gets ≥1 slot, neither takes all 3', () => {
    const r = new JobRunner({ concurrency: 3, logger: silentLogger(), clock: () => 0 });
    const hang = (name: string, kind: 'housekeeping' | 'drain' | 'scheduler'): RunnerJob => ({
      name, runIn: ['sleep'], kind,
      drain: kind === 'drain' ? { slice: 10 } : undefined,
      fn: () => new Promise<void>(() => {}), // never resolves
    });
    r.register(hang('drain-a', 'drain'));
    r.register(hang('scheduler-a', 'scheduler'));
    r.register(hang('drain-b', 'drain'));
    r.register(hang('hk-a', 'housekeeping'));
    r.register(hang('hk-b', 'housekeeping'));

    r.dispatch('sleep');
    const inFlight = r.inFlightNames();
    expect(inFlight.length).toBe(3); // cap respected

    const fgCount = inFlight.filter((n) => n.startsWith('drain-') || n.startsWith('scheduler-')).length;
    const bgCount = inFlight.filter((n) => n.startsWith('hk-')).length;
    expect(bgCount).toBeGreaterThanOrEqual(1); // housekeeping guaranteed ≥1 slot
    expect(fgCount).toBeGreaterThanOrEqual(1); // foreground guaranteed ≥1 slot
    expect(fgCount).toBeLessThanOrEqual(2);    // foreground cannot hold all 3 slots
    expect(bgCount).toBeLessThanOrEqual(2);    // background cannot hold all 3 slots
  });

  it('cross-tick: 2 housekeeping already in-flight at cap=3 — a foreground job still gets the reserved slot', () => {
    const r = new JobRunner({ concurrency: 3, logger: silentLogger(), clock: () => 0 });
    const hang = (name: string, kind: 'housekeeping' | 'drain'): RunnerJob => ({
      name, runIn: ['sleep'], kind,
      drain: kind === 'drain' ? { slice: 10 } : undefined,
      fn: () => new Promise<void>(() => {}), // never resolves
    });
    // First tick: fill 2 housekeeping slots (no foreground eligible yet)
    r.register(hang('hk-a', 'housekeeping'));
    r.register(hang('hk-b', 'housekeeping'));
    r.dispatch('sleep');
    expect(r.inFlightNames().sort()).toEqual(['hk-a', 'hk-b']);

    // Second tick: a foreground job becomes eligible — it must get the one remaining slot
    r.register(hang('drain-a', 'drain'));
    r.dispatch('sleep');
    const inFlight = r.inFlightNames();
    expect(inFlight).toContain('drain-a'); // foreground gets the reserved slot
    expect(inFlight.length).toBe(3);       // cap respected
  });

  it('dispatches least-recently-dispatched first, not registration order', async () => {
    let now = 0;
    const r = new JobRunner({ concurrency: 1, logger: silentLogger(), clock: () => now });
    const quick = (name: string): RunnerJob => ({
      name, runIn: ['sleep'], kind: 'housekeeping', fn: async () => {},
    });
    r.register(quick('first')); r.register(quick('second'));
    now = 1; r.dispatch('sleep');
    await Promise.resolve(); await Promise.resolve();   // let 'first' clear inFlight
    now = 2; r.dispatch('sleep');
    await Promise.resolve(); await Promise.resolve();
    expect(r.lastDispatchedAt('first')).toBe(1);
    expect(r.lastDispatchedAt('second')).toBe(2);
  });
});

describe('JobRunner backoff', () => {
  it('skips a job during its backoff window after a failure, then retries', async () => {
    let now = 0;
    const errors: string[] = [];
    const r = new JobRunner({
      concurrency: 2, logger: silentLogger(), clock: () => now,
      onError: (name) => errors.push(name),
    });
    r.register({ name: 'flaky', runIn: ['sleep'], kind: 'housekeeping',
      fn: async () => { throw new Error('boom'); } });

    r.dispatch('sleep'); await Promise.resolve(); await Promise.resolve();
    expect(errors).toEqual(['flaky']);            // ran once, failed

    now = 1000; r.dispatch('sleep'); await Promise.resolve();
    expect(errors.length).toBe(1);                // still in backoff window, skipped

    now = 60_000; r.dispatch('sleep'); await Promise.resolve(); await Promise.resolve();
    expect(errors.length).toBe(2);                // backoff (30s) elapsed → retried
  });
});

describe('JobRunner deep-sleep hold', () => {
  it('holds when any job with a HoldSpec reports pending > 0', () => {
    const r = new JobRunner({ concurrency: 3, logger: silentLogger(), clock: () => 0 });
    let canopyPending = 0;
    r.register({ name: 'scheduled:tasks', runIn: ['sleep'], kind: 'scheduler',
      hold: { pending: () => canopyPending }, fn: async () => {} });
    r.register({ name: 'backup', runIn: ['sleep'], kind: 'housekeeping', fn: async () => {} });

    expect(r.providesHold()).toBeNull();   // nothing pending
    canopyPending = 5;
    expect(r.providesHold()).toBe('scheduled:tasks');
  });

  it('respects allowDeepSleepHold:false', () => {
    const r = new JobRunner({ concurrency: 3, logger: silentLogger(), clock: () => 0 });
    r.register({ name: 'embedding', runIn: ['sleep'], kind: 'drain', drain: { slice: 10 },
      hold: { pending: () => 99, allowDeepSleepHold: false }, fn: async () => {} });
    expect(r.providesHold()).toBeNull();
  });

  it('a throwing hold probe does not throw, and holds rather than sleeping on an unknown', () => {
    const r = new JobRunner({ concurrency: 3, logger: silentLogger(), clock: () => 0 });
    r.register({ name: 'x', runIn: ['sleep'], kind: 'drain', drain: { slice: 1 },
      hold: { pending: () => { throw new Error('probe down'); } }, fn: async () => {} });
    // A probe that cannot answer is not evidence there is nothing to ship. These
    // probes count un-shipped capture, and sleeping stops the drains, after which
    // the source file can rotate away — so an unanswerable probe holds awake.
    expect(r.providesHold()).toBe('x');
  });

  it('a throwing probe on a hold-exempt job still does not hold', () => {
    const r = new JobRunner({ concurrency: 3, logger: silentLogger(), clock: () => 0 });
    r.register({ name: 'x', runIn: ['sleep'], kind: 'drain', drain: { slice: 1 },
      hold: { pending: () => { throw new Error('probe down'); }, allowDeepSleepHold: false },
      fn: async () => {} });
    expect(r.providesHold()).toBeNull();
  });
});

describe('JobRunner drain record', () => {
  it('logs a drain record with processed/remaining for drain jobs', async () => {
    const records: any[] = [];
    const captureLogger = { ...silentLogger(), info: (_k: string, _m: string, d?: any) => { if (d?.drain_record) records.push(d); } };
    const r = new JobRunner({ concurrency: 2, logger: captureLogger as any, clock: () => 0 });
    r.register({ name: 'embedding', runIn: ['sleep'], kind: 'drain', drain: { slice: 10 },
      fn: async () => ({ processed: 7, remaining: 3 }) });
    r.dispatch('sleep');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ job: 'embedding', processed: 7, remaining: 3, slice: 10 });
  });

  it('does NOT log a drain record for housekeeping jobs', async () => {
    const records: any[] = [];
    const captureLogger = { ...silentLogger(), info: (_k: string, _m: string, d?: any) => { if (d?.drain_record) records.push(d); } };
    const r = new JobRunner({ concurrency: 2, logger: captureLogger as any, clock: () => 0 });
    r.register({ name: 'backup', runIn: ['sleep'], kind: 'housekeeping', fn: async () => {} });
    r.dispatch('sleep');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(records).toHaveLength(0);
  });
});

describe('JobRunner power.job telemetry', () => {
  it('emits status=ok with lag attribution when a lagProbe is provided', async () => {
    // Fake lagProbe: captures the listener so the test can push a lag value.
    let capturedListener: ((lag: number) => void) | null = null;
    let unsubscribeCalled = false;
    const fakeLagProbe = {
      addTickListener(fn: (lag: number) => void): () => void {
        capturedListener = fn;
        return () => { unsubscribeCalled = true; };
      },
    };

    const powerJobLogs: any[] = [];
    const captureLogger = {
      ...silentLogger(),
      info: (_k: string, _m: string, d?: any) => {
        if (_k === LOG_KINDS.POWER_JOB && !d?.drain_record) powerJobLogs.push(d);
      },
    };

    const r = new JobRunner({
      concurrency: 2,
      logger: captureLogger as any,
      clock: () => 0,
      lagProbe: fakeLagProbe as any,
    });
    r.register({ name: 'my-job', runIn: ['sleep'], kind: 'housekeeping', fn: async () => {} });
    r.dispatch('sleep');

    // Deliver a lag value before the job's Promise resolves — the listener is
    // registered synchronously in run(), so capturedListener is already set.
    capturedListener?.(42);

    // The job fn is trivial, so it resolves as a microtask. Drain microtasks
    // so the .then(settle) fires, then yield to the timer phase (settle awaits
    // a setTimeout(0) when a probe is present), then drain remaining microtasks.
    await Promise.resolve(); // fn resolves
    await Promise.resolve(); // .then(settle) fires, settle starts
    await new Promise<void>((res) => setTimeout(res, 0)); // settle's timer yield
    await Promise.resolve(); // settle logs + calls cleanup
    await Promise.resolve();

    expect(powerJobLogs).toHaveLength(1);
    const log = powerJobLogs[0];
    expect(log.job_name).toBe('my-job');
    expect(log.status).toBe('ok');
    expect(typeof log.duration_ms).toBe('number');
    expect(log.duration_ms).toBeGreaterThanOrEqual(0);
    expect(log.event_loop_lag_during_ms).toBe(42);
    expect(unsubscribeCalled).toBe(true);
  });

  it('emits status=error with null lag when no lagProbe and job rejects', async () => {
    const powerJobLogs: any[] = [];
    const errors: string[] = [];
    const captureLogger = {
      ...silentLogger(),
      info: (_k: string, _m: string, d?: any) => {
        if (_k === LOG_KINDS.POWER_JOB && !d?.drain_record) powerJobLogs.push(d);
      },
    };

    const r = new JobRunner({
      concurrency: 2,
      logger: captureLogger as any,
      clock: () => 0,
      onError: (name) => errors.push(name),
    });
    r.register({
      name: 'bad-job',
      runIn: ['sleep'],
      kind: 'housekeeping',
      fn: async () => { throw new Error('boom'); },
    });
    r.dispatch('sleep');

    // No probe → settle does not await a timer, only microtasks needed.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(powerJobLogs).toHaveLength(1);
    const log = powerJobLogs[0];
    expect(log.job_name).toBe('bad-job');
    expect(log.status).toBe('error');
    expect(log.event_loop_lag_during_ms).toBeNull();
    expect(errors).toEqual(['bad-job']);
  });
});
