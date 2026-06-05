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
import { JobRunner } from '@myco/daemon/job-runner.js';
import { PowerManager } from '@myco/daemon/power.js';
import type { Logger } from '@myco/daemon/logger.js';

function silentLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

describe('JobRunner + PowerManager deep-sleep hold', () => {
  it('a registered job with pending work holds the real PowerManager out of deep_sleep', () => {
    const runner = new JobRunner({ concurrency: 3, logger: silentLogger(), clock: () => 0 });
    let pending = 4;
    runner.register({
      name: 'scheduled:tasks', runIn: ['sleep'], kind: 'scheduler',
      hold: { pending: () => pending }, fn: async () => {},
    });
    const pm = new PowerManager({
      idleThresholdMs: 0, sleepThresholdMs: 0, deepSleepThresholdMs: 0,
      activeIntervalMs: 1, sleepIntervalMs: 1, logger: silentLogger(),
      onTick: () => {}, deepSleepHolder: () => runner.providesHold(),
    });
    expect(pm.evaluateStateForTest()).toBe('sleep');   // held by canopy backlog
    pending = 0;
    expect(pm.evaluateStateForTest()).toBe('deep_sleep'); // drains → drops to deep_sleep
  });
});
