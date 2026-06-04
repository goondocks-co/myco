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

import type { Logger } from './logger.js';
import type { PowerState } from './power.js';

export type JobKind = 'housekeeping' | 'drain' | 'scheduler';

/** Global aggregate pending probe (already summed across scopes + cached by the author). */
export interface HoldSpec {
  pending: () => number;
  allowDeepSleepHold?: boolean; // default true
}

export interface DrainSpec {
  slice: number;            // base items per run
  softDeadlineMs?: number;  // default 2000
}

export interface JobRunContext {
  signal: AbortSignal;
  sliceBudget: { maxItems: number; softDeadlineMs: number };
  drainState: Map<string, unknown>; // persisted per-job across slices
}

export interface JobOutcome { processed: number; remaining: number }

export interface RunnerJob {
  name: string;
  runIn: PowerState[];
  kind: JobKind;
  priority?: 'normal' | 'low'; // 'low' = heavy; yields slots under contention
  drain?: DrainSpec;
  hold?: HoldSpec;
  fn: (ctx: JobRunContext) => Promise<JobOutcome | void>;
}

export interface JobRunnerOptions {
  concurrency: number;
  logger: Logger;
  clock?: () => number;
  onError?: (jobName: string, err: unknown) => void;
}

export class JobRunner {
  private jobs: RunnerJob[] = [];
  private readonly now: () => number;

  constructor(private readonly opts: JobRunnerOptions) {
    this.now = opts.clock ?? Date.now;
  }

  register(job: RunnerJob): void { this.jobs.push(job); }

  replaceGroup(prefix: string, jobs: RunnerJob[]): void {
    this.jobs = this.jobs.filter((j) => !j.name.startsWith(prefix));
    this.jobs.push(...jobs);
  }

  jobNames(): string[] { return this.jobs.map((j) => j.name); }
}
