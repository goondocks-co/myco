import type { DaemonLogger } from './logger.js';
import type { EventLoopLagProbe } from './event-loop-lag.js';
import { LOG_KINDS } from '../constants/log-kinds.js';

export type PowerState = 'active' | 'idle' | 'sleep' | 'deep_sleep';

export interface PowerJob {
  name: string;
  runIn: PowerState[];
  fn: () => Promise<void>;
  /** When true, prevents transition from sleep → deep_sleep. */
  preventsDeepSleep?: () => boolean;
}

export interface PowerManagerConfig {
  idleThresholdMs: number;
  sleepThresholdMs: number;
  deepSleepThresholdMs: number;
  activeIntervalMs: number;
  sleepIntervalMs: number;
  logger: DaemonLogger;
  /** Optional. When provided, every job invocation emits a `power.job`
   *  log entry annotated with the peak event-loop lag observed during
   *  the job's runtime. */
  lagProbe?: EventLoopLagProbe;
}

export class PowerManager {
  private state: PowerState = 'active';
  private lastActivity: number = Date.now();
  private jobs: PowerJob[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private config: PowerManagerConfig;
  private logger: DaemonLogger;
  private deepSleepHeld = false;

  constructor(config: PowerManagerConfig) {
    this.config = config;
    this.logger = config.logger;
  }

  register(job: PowerJob): void {
    this.jobs.push(job);
  }

  replaceGroup(prefix: string, jobs: PowerJob[]): void {
    this.jobs = this.jobs.filter((job) => !job.name.startsWith(prefix));
    this.jobs.push(...jobs);
  }

  recordActivity(): void {
    this.lastActivity = Date.now();
    this.deepSleepHeld = false;

    if (this.state === 'deep_sleep') {
      this.logger.info(LOG_KINDS.POWER_STATE, 'Waking from deep sleep');
      this.state = 'active';
      this.scheduleNextTick();
    }
  }

  start(): void {
    this.lastActivity = Date.now();
    this.state = 'active';
    this.running = true;
    this.scheduleNextTick();
    this.logger.info(LOG_KINDS.POWER_STATE, 'PowerManager started', {
      jobs: this.jobs.map((j) => j.name),
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info(LOG_KINDS.POWER_STATE, 'PowerManager stopped');
  }

  getState(): PowerState {
    this.evaluateState();
    return this.state;
  }

  private evaluateState(): void {
    const idleMs = Date.now() - this.lastActivity;
    let target: PowerState;

    if (idleMs >= this.config.deepSleepThresholdMs) {
      const blocker = this.jobs.find((j) => j.preventsDeepSleep?.());
      if (blocker) {
        target = 'sleep';
        if (!this.deepSleepHeld) {
          this.deepSleepHeld = true;
          this.logger.info(LOG_KINDS.POWER_STATE, 'Deep sleep held', { by: blocker.name });
        }
      } else {
        target = 'deep_sleep';
        this.deepSleepHeld = false;
      }
    } else if (idleMs >= this.config.sleepThresholdMs) {
      target = 'sleep';
    } else if (idleMs >= this.config.idleThresholdMs) {
      target = 'idle';
    } else {
      target = 'active';
    }

    if (target !== this.state) {
      this.logger.info(LOG_KINDS.POWER_STATE, 'Power state transition', {
        from: this.state,
        to: target,
        idle_ms: idleMs,
      });
      this.state = target;
    }
  }

  private scheduleNextTick(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);

    const interval =
      this.state === 'sleep'
        ? this.config.sleepIntervalMs
        : this.config.activeIntervalMs;

    this.timer = setTimeout(() => this.tick(), interval);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    this.evaluateState();

    if (this.state === 'deep_sleep') {
      this.logger.info(LOG_KINDS.POWER_STATE, 'Entering deep sleep — timer stopped');
      this.timer = null;
      return;
    }

    // Run eligible jobs
    const eligible = this.jobs.filter((j) => j.runIn.includes(this.state));
    this.logger.debug(LOG_KINDS.POWER_TICK, 'Tick', {
      state: this.state,
      jobs: eligible.map((j) => j.name),
    });

    for (const job of eligible) {
      await this.runJob(job);
    }

    this.scheduleNextTick();
  }

  private async runJob(job: PowerJob): Promise<void> {
    const probe = this.config.lagProbe;
    const startMs = performance.now();
    let peakLagDuringMs = 0;
    const unsubscribe = probe?.addTickListener((lag) => {
      if (lag > peakLagDuringMs) peakLagDuringMs = lag;
    });
    let errored: Error | null = null;
    try {
      await job.fn();
    } catch (err) {
      errored = err as Error;
    }
    // Yield once to libuv's timer phase so any probe tick deferred by a
    // sync-heavy job fires and reaches the listener before unsubscribe.
    if (probe) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    unsubscribe?.();
    const durationMs = performance.now() - startMs;
    this.logger.info(LOG_KINDS.POWER_JOB, 'Power job completed', {
      job_name: job.name,
      duration_ms: durationMs,
      event_loop_lag_during_ms: probe ? peakLagDuringMs : null,
      status: errored ? 'error' : 'ok',
    });
    if (errored) {
      this.logger.error(LOG_KINDS.POWER_JOB_ERROR, `Job "${job.name}" failed`, {
        error: errored.message,
      });
    }
  }
}
