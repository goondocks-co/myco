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
import type { EventLoopLagProbe } from './event-loop-lag.js';
import { LOG_KINDS } from '../constants/log-kinds.js';

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
  /** Optional. When provided, every job completion emits a `power.job` log
   *  entry annotated with the peak event-loop lag observed while it ran. */
  lagProbe?: EventLoopLagProbe;
}

export class JobRunner {
  private jobs: RunnerJob[] = [];
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();
  private readonly lastDispatched = new Map<string, number>();
  private readonly drainStates = new Map<string, Map<string, unknown>>();
  private readonly failures = new Map<string, number>();
  private readonly nextEligibleAt = new Map<string, number>();
  private static readonly BACKOFF_BASE_MS = 30_000;
  private static readonly BACKOFF_MAX_MS = 15 * 60_000;

  private backedOff(name: string): boolean {
    return this.now() < (this.nextEligibleAt.get(name) ?? 0);
  }

  constructor(private readonly opts: JobRunnerOptions) {
    this.now = opts.clock ?? Date.now;
  }

  register(job: RunnerJob): void { this.jobs.push(job); }

  replaceGroup(prefix: string, jobs: RunnerJob[]): void {
    this.jobs = this.jobs.filter((j) => !j.name.startsWith(prefix));
    this.jobs.push(...jobs);
  }

  jobNames(): string[] { return this.jobs.map((j) => j.name); }

  inFlightNames(): string[] { return [...this.inFlight]; }

  lastDispatchedAt(name: string): number | undefined {
    return this.lastDispatched.get(name);
  }

  dispatch(state: PowerState): void {
    const eligible = this.jobs
      .filter((j) => j.runIn.includes(state) && !this.inFlight.has(j.name) && !this.backedOff(j.name))
      .sort((a, b) =>
        (this.lastDispatched.get(a.name) ?? -Infinity) -
        (this.lastDispatched.get(b.name) ?? -Infinity),
      );
    // Reserve slots for eligible drain/scheduler work so a long housekeeping
    // run can't starve it. A housekeeping job runs only when free slots exceed
    // the number of non-housekeeping jobs still waiting to dispatch this pass.
    let remainingNonHousekeeping = eligible.filter((j) => j.kind !== 'housekeeping').length;
    const dispatched: string[] = [];
    const skipped: string[] = [];
    for (const job of eligible) {
      const free = this.opts.concurrency - this.inFlight.size;
      if (free <= 0) break;
      if (job.kind === 'housekeeping') {
        if (free <= remainingNonHousekeeping) { skipped.push(job.name); continue; }
        this.run(job);
        dispatched.push(job.name);
      } else {
        this.run(job);
        dispatched.push(job.name);
        remainingNonHousekeeping--;
      }
    }
    this.opts.logger.debug(LOG_KINDS.POWER_TICK, 'Dispatch tick', {
      state,
      dispatched,
      skipped,
    });
  }

  private run(job: RunnerJob): void {
    this.inFlight.add(job.name);
    this.lastDispatched.set(job.name, this.now());
    // AbortSignal for cooperative cancellation; no abort source wired yet.
    const controller = new AbortController();
    const ctx: JobRunContext = {
      signal: controller.signal,
      sliceBudget: {
        maxItems: job.drain?.slice ?? 0,
        softDeadlineMs: job.drain?.softDeadlineMs ?? 2000,
      },
      drainState: this.drainStateFor(job.name),
    };
    const cleanup = (err?: unknown) => {
      this.inFlight.delete(job.name);
      if (err === undefined) {
        this.failures.delete(job.name);
        this.nextEligibleAt.delete(job.name);
        return;
      }
      const n = (this.failures.get(job.name) ?? 0) + 1;
      this.failures.set(job.name, n);
      const delay = Math.min(
        JobRunner.BACKOFF_BASE_MS * 2 ** (n - 1),
        JobRunner.BACKOFF_MAX_MS,
      );
      this.nextEligibleAt.set(job.name, this.now() + delay);
      this.opts.onError?.(job.name, err);
    };

    // Per-job timing + event-loop-lag attribution. Emitted for every job
    // (housekeeping/drain/scheduler) so daemon-log verification keeps the
    // `power.job` line it relies on.
    const probe = this.opts.lagProbe;
    const startMs = performance.now();
    let peakLagDuringMs = 0;
    const unsubscribe = probe?.addTickListener((lag) => {
      if (lag > peakLagDuringMs) peakLagDuringMs = lag;
    });
    const settle = async (err?: unknown, outcome?: JobOutcome | void): Promise<void> => {
      // Yield once to libuv's timer phase so any probe tick deferred by a
      // sync-heavy job fires and reaches the listener before unsubscribe.
      if (probe) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      unsubscribe?.();
      const durationMs = performance.now() - startMs;
      this.opts.logger.info(LOG_KINDS.POWER_JOB, 'Power job completed', {
        job_name: job.name,
        duration_ms: durationMs,
        event_loop_lag_during_ms: probe ? peakLagDuringMs : null,
        status: err === undefined ? 'ok' : 'error',
      });
      if (job.kind === 'drain' && err === undefined && outcome != null && typeof outcome === 'object') {
        this.opts.logger.info(LOG_KINDS.POWER_JOB, 'Drain slice', {
          drain_record: true,
          job: job.name,
          processed: (outcome as JobOutcome).processed,
          remaining: (outcome as JobOutcome).remaining,
          slice: job.drain?.slice,
        });
      }
      cleanup(err);
    };
    void job.fn(ctx).then((outcome) => settle(undefined, outcome), (err) => settle(err));
  }

  /** Name of the first job holding deep-sleep, or null. Defensive: a failing probe never holds. */
  providesHold(): string | null {
    for (const job of this.jobs) {
      if (!job.hold) continue;
      if ((job.hold.allowDeepSleepHold ?? true) === false) continue;
      let pending = 0;
      try { pending = job.hold.pending(); } catch { pending = 0; }
      if (pending > 0) return job.name;
    }
    return null;
  }

  private drainStateFor(name: string): Map<string, unknown> {
    let s = this.drainStates.get(name);
    if (!s) {
      s = new Map();
      this.drainStates.set(name, s);
    }
    return s;
  }
}
