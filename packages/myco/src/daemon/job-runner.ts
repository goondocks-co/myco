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

/**
 * Runtime context passed to each job fn. `sliceBudget` controls how many
 * items a drain job processes per invocation. (Signal and cross-slice state
 * will be re-added when there is a concrete consumer.)
 */
export interface JobRunContext {
  sliceBudget: { maxItems: number; softDeadlineMs: number };
}

export interface JobOutcome { processed: number; remaining: number }

export interface RunnerJob {
  name: string;
  runIn: PowerState[];
  kind: JobKind;
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

    // Two-lane fair sharing. background = housekeeping; foreground = drain/scheduler
    // (time-sensitive). When BOTH lanes have work (in-flight or eligible), neither
    // may hold more than concurrency-1 slots, so each lane is always guaranteed at
    // least one slot. Cross-tick in-flight jobs are counted so a long background job
    // from a prior tick still can't crowd out foreground work (and vice versa).
    const laneOf = (job: RunnerJob): 'background' | 'foreground' =>
      job.kind === 'housekeeping' ? 'background' : 'foreground';
    const kindByName = new Map(this.jobs.map((j) => [j.name, laneOf(j)] as const));
    const inFlightByLane = { background: 0, foreground: 0 };
    for (const name of this.inFlight) {
      const lane = kindByName.get(name);
      if (lane) inFlightByLane[lane]++;
    }
    const eligibleByLane = { background: 0, foreground: 0 };
    for (const job of eligible) eligibleByLane[laneOf(job)]++;

    const dispatched: string[] = [];
    const skipped: string[] = [];
    for (const job of eligible) {
      if (this.inFlight.size >= this.opts.concurrency) break;
      const lane = laneOf(job);
      const other = lane === 'background' ? 'foreground' : 'background';
      eligibleByLane[lane]--; // now being considered
      const otherWantsASlot = inFlightByLane[other] > 0 || eligibleByLane[other] > 0;
      if (otherWantsASlot && inFlightByLane[lane] >= this.opts.concurrency - 1) {
        skipped.push(job.name);
        continue; // reserve the last slot for the other lane
      }
      this.run(job);
      inFlightByLane[lane]++;
      dispatched.push(job.name);
    }

    this.opts.logger.debug(LOG_KINDS.POWER_TICK, 'Dispatch tick', { state, dispatched, skipped });
  }

  // Single-flight per job: dispatch never invokes run() for a job already in
  // inFlight, so fn is never executing concurrently for the same job name.
  private run(job: RunnerJob): void {
    this.inFlight.add(job.name);
    this.lastDispatched.set(job.name, this.now());
    const ctx: JobRunContext = {
      sliceBudget: {
        maxItems: job.drain?.slice ?? 0,
        softDeadlineMs: job.drain?.softDeadlineMs ?? 2000,
      },
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
    // settle is structurally never-throw: it runs as the terminal .then
    // handler of a fire-and-forget promise, so anything it lets escape is an
    // unhandled rejection — AND a throw before cleanup() would strand the
    // job in inFlight forever (the single-flight filter would skip it until
    // restart). Logging is best-effort; the inFlight/backoff bookkeeping in
    // cleanup() must run unconditionally.
    const settle = async (err?: unknown, outcome?: JobOutcome | void): Promise<void> => {
      try {
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
      } catch { /* logging/probe teardown is best-effort */ } finally {
        try {
          cleanup(err);
        } catch { /* cleanup calls opts.onError (a logger in prod) — best-effort */ }
      }
    };
    void job.fn(ctx).then((outcome) => settle(undefined, outcome), (err) => settle(err));
  }

  /**
   * Name of the first job holding deep-sleep, or null.
   *
   * A probe that throws HOLDS. These probes count unshipped capture, so a
   * probe that cannot answer is not evidence there is nothing to ship — and
   * sleeping stops the drains, after which the source file can rotate away.
   * Staying awake on a broken probe costs power; sleeping on one costs data.
   */
  providesHold(): string | null {
    for (const job of this.jobs) {
      if (!job.hold) continue;
      if ((job.hold.allowDeepSleepHold ?? true) === false) continue;
      let pending = 0;
      try {
        pending = job.hold.pending();
      } catch (err) {
        this.opts.logger.warn(LOG_KINDS.POWER_JOB, 'Deep-sleep hold probe failed — holding awake', {
          job: job.name,
          error: (err as Error).message,
        });
        return job.name;
      }
      if (pending > 0) return job.name;
    }
    return null;
  }

}
