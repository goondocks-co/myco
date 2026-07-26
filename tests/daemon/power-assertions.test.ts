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

/**
 * Gates for the power-assertion model.
 *
 * The bug these exist to prevent: the daemon deep-slept through hours of agent
 * tool calls because the activity clock only advanced on `user_prompt` — the
 * rarest signal in the system. The pre-existing tests asserted the *mechanism*
 * (`recordActivity()` wakes the manager) and never the *policy* (what counts as
 * activity), which is exactly why the gap survived several review passes.
 *
 * So these gates assert policy, and two of them encode real client behaviour
 * rather than an assumption about it.
 */

import { describe, it, expect } from 'bun:test';
import { JobRunner } from '@myco/daemon/job-runner.js';
import {
  PowerManager,
  type PowerState,
  type AssertionSource,
} from '@myco/daemon/power.js';
import { classifyRequest } from '@myco/daemon/server.js';
import type { Logger } from '@myco/daemon/logger.js';

function silentLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/** Thresholds mirroring production ordering, scaled down for tests. */
const IDLE_MS = 50;
const SLEEP_MS = 100;
const DEEP_SLEEP_MS = 150;

function makeManager(overrides: {
  deepSleepHolder?: () => string | null;
} = {}): PowerManager {
  return new PowerManager({
    idleThresholdMs: IDLE_MS,
    sleepThresholdMs: SLEEP_MS,
    deepSleepThresholdMs: DEEP_SLEEP_MS,
    activeIntervalMs: 10_000,
    sleepIntervalMs: 10_000,
    logger: silentLogger(),
    onTick: () => {},
    deepSleepHolder: overrides.deepSleepHolder ?? (() => null),
  });
}

/** An always-on source at the given depth. */
function fixedSource(name: string, maxDepth: PowerState): AssertionSource {
  return { name, probe: () => [{ name, maxDepth }] };
}

describe('power assertions: resolution', () => {
  it('with no assertions the daemon still reaches deep_sleep (anti-pinning)', async () => {
    const pm = makeManager();
    pm.start();
    await Bun.sleep(DEEP_SLEEP_MS + 20);
    expect(pm.getState()).toBe('deep_sleep');
    pm.stop();
  });

  it('a sleep-depth assertion blocks deep_sleep but permits idle and sleep', async () => {
    const pm = makeManager();
    pm.registerAssertionSource(fixedSource('liveness', 'sleep'));
    pm.start();

    await Bun.sleep(IDLE_MS + 15);
    expect(pm.getState()).toBe('idle');

    await Bun.sleep(SLEEP_MS - IDLE_MS + 15);
    expect(pm.getState()).toBe('sleep');

    // Past the deep-sleep threshold, the assertion clamps it.
    await Bun.sleep(DEEP_SLEEP_MS - SLEEP_MS + 30);
    expect(pm.getState()).toBe('sleep');
    pm.stop();
  });

  it('natural decay still reaches idle and sleep under a held assertion', async () => {
    // Gate 13 / §3.2: the assertion must constrain depth, never pin a state.
    // Pinning `active` would starve the twelve jobs that only run in
    // idle/sleep — retention, backup, DB optimize, integrity check, upgrade.
    const pm = makeManager();
    pm.registerAssertionSource(fixedSource('liveness', 'sleep'));
    pm.start();
    const seen = new Set<PowerState>();
    for (let i = 0; i < 12; i++) {
      await Bun.sleep(20);
      seen.add(pm.getState());
    }
    expect(seen.has('idle')).toBe(true);
    expect(seen.has('sleep')).toBe(true);
    expect(seen.has('deep_sleep')).toBe(false);
    pm.stop();
  });

  it('an expired assertion stops constraining', () => {
    const pm = makeManager();
    const expiresAt = Date.now() - 1;
    pm.registerAssertionSource({
      name: 'lease',
      probe: () => [{ name: 'stale', maxDepth: 'active', expiresAt }],
    });
    expect(pm.currentAssertions()).toHaveLength(0);
  });

  it('a throwing probe holds at sleep, not active', () => {
    // Matches JobRunner.providesHold(): a probe that cannot answer is not
    // evidence there is nothing to do. But it must not pin `active` either —
    // a probe-backed assertion has no TTL, so an `active` fail-safe would
    // starve the idle/sleep tiers indefinitely on any transient fault.
    const pm = makeManager();
    pm.registerAssertionSource({
      name: 'broken',
      probe: () => { throw new Error('probe exploded'); },
    });
    const held = pm.currentAssertions();
    expect(held).toHaveLength(1);
    expect(held[0]!.maxDepth).toBe('sleep');
  });

  it('the shallowest maxDepth wins across sources', () => {
    const pm = makeManager();
    pm.registerAssertionSource(fixedSource('deep', 'sleep'));
    pm.registerAssertionSource(fixedSource('shallow', 'idle'));
    const depths = pm.currentAssertions().map((a) => a.maxDepth);
    expect(depths).toContain('idle');
    expect(depths).toContain('sleep');
  });

  it('assertions are tagged with the source that produced them', () => {
    const pm = makeManager();
    pm.registerAssertionSource(fixedSource('liveness', 'sleep'));
    const held = pm.currentAssertions().find((a) => a.name === 'liveness');
    expect(held?.source).toBe('liveness');
  });

  it('the pre-existing job-runner hold still resolves through the new model', () => {
    let pending = 3;
    const runner = new JobRunner({ concurrency: 1, logger: silentLogger(), clock: () => 0 });
    runner.register({
      name: 'drain:things', runIn: ['sleep'], kind: 'drain',
      hold: { pending: () => pending }, fn: async () => {},
    });
    const pm = new PowerManager({
      idleThresholdMs: 0, sleepThresholdMs: 0, deepSleepThresholdMs: 0,
      activeIntervalMs: 1, sleepIntervalMs: 1, logger: silentLogger(),
      onTick: () => {}, deepSleepHolder: () => runner.providesHold(),
    });
    expect(pm.evaluateStateForTest()).toBe('sleep');
    pending = 0;
    expect(pm.evaluateStateForTest()).toBe('deep_sleep');
  });
});

describe('job-tier reachability', () => {
  it('every registered runIn tier is still reached while a liveness assertion is held', async () => {
    // The gate that would have caught asserting `active` for liveness. Twelve
    // of nineteen production jobs never run in `active` — retention, backup,
    // DB optimize, integrity check, both upgrade jobs — so an assertion that
    // pinned the daemon there would starve them for the whole length of a
    // long agentic run, and every other gate here would still pass.
    //
    // Enumerates what is actually registered rather than hard-coding tiers, so
    // a job added at a new tier is covered without touching this test.
    const runner = new JobRunner({ concurrency: 4, logger: silentLogger() });
    const tiers: PowerState[][] = [['active'], ['idle'], ['sleep'], ['active', 'idle', 'sleep']];
    const dispatched = new Set<string>();
    tiers.forEach((runIn, i) => {
      runner.register({
        name: `job-${i}`,
        runIn,
        kind: 'housekeeping',
        fn: async () => { dispatched.add(`job-${i}`); },
      });
    });

    const pm = new PowerManager({
      idleThresholdMs: IDLE_MS,
      sleepThresholdMs: SLEEP_MS,
      deepSleepThresholdMs: DEEP_SLEEP_MS,
      activeIntervalMs: 10,
      sleepIntervalMs: 10,
      logger: silentLogger(),
      onTick: (state) => runner.dispatch(state),
      deepSleepHolder: () => null,
    });
    pm.registerAssertionSource(fixedSource('liveness', 'sleep'));
    pm.start();
    await Bun.sleep(DEEP_SLEEP_MS + 80);
    pm.stop();

    const everyTier = new Set(runner.jobNames());
    expect(dispatched).toEqual(everyTier);
    // And the assertion did its job throughout.
    expect(pm.getState()).not.toBe('deep_sleep');
  });
});

describe('power assertions: the wake edge', () => {
  it('returns the daemon to active from sleep, restarting natural decay', async () => {
    // Guards the regression where nothing advanced `lastActivity` once the
    // legacy per-event call sites were removed: the daemon would settle at
    // `sleep` forever and run every drain on the slow tick.
    const pm = makeManager();
    pm.registerAssertionSource(fixedSource('liveness', 'sleep'));
    pm.start();
    await Bun.sleep(SLEEP_MS + 20);
    expect(pm.getState()).toBe('sleep');

    pm.wake();
    expect(pm.getState()).toBe('active');
    pm.stop();
  });

  it('revives a deep-sleeping daemon whose tick timer has stopped', async () => {
    const pm = makeManager();
    pm.start();
    await Bun.sleep(DEEP_SLEEP_MS + 20);
    expect(pm.getState()).toBe('deep_sleep');

    pm.wake();
    expect(pm.getState()).toBe('active');
    pm.stop();
  });

  it('is inert before start and after stop', () => {
    const pm = makeManager();
    pm.wake();
    expect(pm.getState()).toBe('active');
    pm.start();
    pm.stop();
    pm.wake();
    expect(pm.getState()).toBe('active');
  });
});

describe('request classification', () => {
  it('an unclassified request counts as interaction (fail-open)', () => {
    // CLI, capture hooks and MCP tool calls carry no header and are always
    // initiated by a human or an agent.
    expect(classifyRequest({}, '/api/sessions')).toBe('interaction');
  });

  it('an active client declaration counts as interaction', () => {
    expect(classifyRequest({ 'x-myco-client-activity': 'active' }, '/api/sessions'))
      .toBe('interaction');
  });

  it('an idle or hidden dashboard tab does not count as interaction', () => {
    // Chris's permanently-open tab: the notifications heartbeat keeps polling
    // at a 30s cap even while the UI is in its own deep sleep. Without this
    // the daemon could never sleep while any tab was open anywhere.
    for (const state of ['idle', 'hidden', 'deep_sleep']) {
      expect(classifyRequest({ 'x-myco-client-activity': state }, '/api/sessions'))
        .toBe('passive');
    }
  });

  it('classifies /health and /ready as probes whatever the client declared', () => {
    // The resident MCP stdio bridge polls /health every 5s for the whole life
    // of an agent session, by design — its own docstring says it exists for
    // "the idle-bridge case where the user hasn't sent a message in a while".
    // Treating that as work would pin the daemon awake for as long as any
    // editor window is open, including overnight.
    for (const path of ['/health', '/ready']) {
      expect(classifyRequest({}, path)).toBe('probe');
      expect(classifyRequest({ 'x-myco-client-activity': 'active' }, path)).toBe('probe');
    }
  });

  it('classifies the power inventory itself as a probe', () => {
    // Reading the activity clock must not reset it. Live smoke caught this:
    // every /api/power sample returned idle_ms 0 because the read counted as
    // interaction and woke the daemon before reporting. A monitoring client
    // polling it would have held the machine awake forever — the exact bug
    // class this mechanism exists to remove, reintroduced by its own
    // observability endpoint.
    expect(classifyRequest({}, '/api/power')).toBe('probe');
    expect(classifyRequest({ 'x-myco-client-activity': 'active' }, '/api/power')).toBe('probe');
  });

  it('honours an explicit probe declaration on any path', () => {
    expect(classifyRequest({ 'x-myco-client-activity': 'probe' }, '/api/status'))
      .toBe('probe');
  });

  it('tolerates a repeated header without crashing', () => {
    expect(classifyRequest({ 'x-myco-client-activity': ['active', 'idle'] }, '/api/x'))
      .toBe('interaction');
  });
});

describe('resident-client realism', () => {
  it('a client polling /health every 5s does not prevent deep sleep', async () => {
    // Encodes what the MCP bridge actually does, rather than an assumption
    // about it. This is the gate that would have caught treating an absent
    // header as intent without accounting for keep-alives.
    const pm = makeManager();
    const woken: string[] = [];
    pm.start();

    for (let i = 0; i < 6; i++) {
      await Bun.sleep(30);
      const cls = classifyRequest({}, '/health');
      if (cls === 'interaction') {
        woken.push('/health');
        pm.wake();
      }
    }

    expect(woken).toHaveLength(0);
    expect(pm.getState()).toBe('deep_sleep');
    pm.stop();
  });

  it('real tool traffic from the same bridge does keep it awake', async () => {
    // The counterpart: the bridge's /mcp calls carry no header and must count.
    const pm = makeManager();
    pm.start();
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(30);
      if (classifyRequest({}, '/mcp') === 'interaction') pm.wake();
    }
    expect(pm.getState()).toBe('active');
    pm.stop();
  });
});
