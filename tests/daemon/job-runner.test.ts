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
    r.register(noopJob('scheduled:legacy', { name: 'scheduled:legacy' }));
    r.replaceGroup('scheduled:', [noopJob('scheduled:tasks')]); // drops scheduled:legacy
    expect(r.jobNames().sort()).toEqual(['a', 'scheduled:tasks']);
  });
});

function silentLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop } as any;
}
