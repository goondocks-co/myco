/**
 * Always-on probe that measures event-loop responsiveness.
 *
 * Schedules a chained `setTimeout` at a fixed sample interval and records
 * how much the actual fire time drifts past the expected one. Drift above
 * the warn threshold means the loop was occupied by sync work (or a
 * microtask cascade) for that duration — the diagnostic signal we lacked
 * during the canopy-describe / LMStudio over-pressure hang where the
 * daemon went silent without any error.
 *
 * Cross-provider by construction: this lives at the daemon level, so any
 * blocker (sync bun:sqlite call, JSON.parse on a multi-MB buffer, a
 * misbehaving SDK aggregator) shows up in the same log stream with the
 * same kind. Operators grep for `daemon.lag` and see every stall.
 *
 * Implementation note: chained `setTimeout` is preferred over
 * `setInterval`. setInterval's callback fires "as soon as possible" after
 * the interval, which masks lag; chained setTimeout measures the gap
 * directly.
 */

import type { Logger } from './logger.js';
import { LOG_KINDS } from '../constants/log-kinds.js';

export interface EventLoopLagProbeOptions {
  /** How often to measure. Defaults to 250ms — small enough to catch a
   *  half-second pin, large enough not to itself contribute to lag. */
  sampleIntervalMs?: number;
  /** Minimum drift in ms above which a warning is emitted. The probe
   *  records every sample internally; only those exceeding this threshold
   *  hit the log. */
  warnThresholdMs?: number;
  /** Optional clock override for tests. */
  now?: () => number;
}

export const DEFAULT_SAMPLE_INTERVAL_MS = 250;
export const DEFAULT_WARN_THRESHOLD_MS = 500;

export class EventLoopLagProbe {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastTick: number = 0;
  private running = false;
  private readonly sampleIntervalMs: number;
  private readonly warnThresholdMs: number;
  private readonly now: () => number;
  /** Peak lag observed since `start()` — surfaced via `getStats()` so the
   *  daemon /stats endpoint or a test can read it without parsing logs. */
  private peakLagMs = 0;
  /** Number of samples that exceeded the warn threshold. */
  private stallCount = 0;

  constructor(private readonly logger: Logger, options: EventLoopLagProbeOptions = {}) {
    this.sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.warnThresholdMs = options.warnThresholdMs ?? DEFAULT_WARN_THRESHOLD_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTick = this.now();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getStats(): { peakLagMs: number; stallCount: number } {
    return { peakLagMs: this.peakLagMs, stallCount: this.stallCount };
  }

  /** Test-only: reset counters between probe runs. */
  resetStats(): void {
    this.peakLagMs = 0;
    this.stallCount = 0;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick(), this.sampleIntervalMs);
    // unref so the probe doesn't keep the process alive on its own.
    this.timer.unref?.();
  }

  private tick(): void {
    if (!this.running) return;
    const now = this.now();
    const observed = now - this.lastTick;
    const lag = observed - this.sampleIntervalMs;
    this.lastTick = now;

    if (lag > this.peakLagMs) this.peakLagMs = lag;
    if (lag >= this.warnThresholdMs) {
      this.stallCount += 1;
      this.logger.warn(
        LOG_KINDS.DAEMON_LAG,
        `Event-loop lag ${lag}ms exceeds threshold ${this.warnThresholdMs}ms`,
        {
          lagMs: lag,
          sampleIntervalMs: this.sampleIntervalMs,
          warnThresholdMs: this.warnThresholdMs,
        },
      );
    }

    this.schedule();
  }
}
