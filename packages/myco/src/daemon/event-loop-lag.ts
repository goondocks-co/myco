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
 * Implementation note 1: chained `setTimeout` is preferred over
 * `setInterval`. setInterval's callback fires "as soon as possible" after
 * the interval, which masks lag; chained setTimeout measures the gap
 * directly.
 *
 * Implementation note 2: measurements use `performance.now()` rather than
 * `Date.now()`. On macOS (laptop lid close / display sleep) and other
 * platforms with system suspend, `Date.now()` keeps advancing during
 * sleep while `setTimeout` (driven by libuv's monotonic clock) pauses.
 * That mismatch would surface as a multi-minute fake "lag" reading the
 * first time the laptop woke up. `performance.now()` is monotonic and
 * pauses with the timer, so sleep events are invisible to the probe and
 * only real loop pinning is reported. Live dogfood proof: probe reported
 * 275 sec and 329 sec "lags" until this clock fix landed.
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
  /** Optional clock override for tests. Production uses
   *  `performance.now()` — monotonic and pauses during system sleep,
   *  unlike `Date.now()` which would mis-classify multi-minute sleep
   *  gaps as event-loop pins. */
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
  /** Per-tick subscribers, invoked synchronously inside tick(). */
  private listeners = new Set<(lagMs: number) => void>();

  constructor(private readonly logger: Logger, options: EventLoopLagProbeOptions = {}) {
    this.sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.warnThresholdMs = options.warnThresholdMs ?? DEFAULT_WARN_THRESHOLD_MS;
    this.now = options.now ?? (() => performance.now());
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

  /** Subscribe to per-tick lag values. Returns an unsubscribe function.
   *
   *  Listeners are invoked synchronously inside the probe's tick. Keep
   *  them cheap — exceptions are caught and logged but the listener is
   *  not removed, so a buggy subscriber will keep firing. */
  addTickListener(fn: (lagMs: number) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
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
    for (const fn of this.listeners) {
      try {
        fn(lag);
      } catch (err) {
        this.logger.warn(
          LOG_KINDS.DAEMON_LAG,
          'Event-loop lag tick listener threw',
          { error: (err as Error).message },
        );
      }
    }
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
