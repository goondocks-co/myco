import type { DaemonLogger } from './logger.js';

export type PowerState = 'active' | 'idle' | 'sleep' | 'deep_sleep';

export interface PowerJob {
  name: string;
  runIn: PowerState[];
  fn: () => Promise<void>;
}

export interface PowerManagerConfig {
  idleThresholdMs: number;
  sleepThresholdMs: number;
  deepSleepThresholdMs: number;
  activeIntervalMs: number;
  sleepIntervalMs: number;
  logger: DaemonLogger;
}

const LOG_CATEGORY = 'power';

export class PowerManager {
  private state: PowerState = 'active';
  private lastActivity: number = Date.now();
  private jobs: PowerJob[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private config: PowerManagerConfig;
  private logger: DaemonLogger;

  constructor(config: PowerManagerConfig) {
    this.config = config;
    this.logger = config.logger;
  }

  register(job: PowerJob): void {
    this.jobs.push(job);
  }

  recordActivity(): void {
    this.lastActivity = Date.now();

    if (this.state === 'deep_sleep') {
      this.logger.info(LOG_CATEGORY, 'Waking from deep sleep');
      this.state = 'active';
      this.scheduleNextTick();
    }
  }

  start(): void {
    this.lastActivity = Date.now();
    this.state = 'active';
    this.running = true;
    this.scheduleNextTick();
    this.logger.info(LOG_CATEGORY, 'PowerManager started', {
      jobs: this.jobs.map((j) => j.name),
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info(LOG_CATEGORY, 'PowerManager stopped');
  }

  getState(): PowerState {
    this.evaluateState();
    return this.state;
  }

  private evaluateState(): void {
    const idleMs = Date.now() - this.lastActivity;
    let target: PowerState;

    if (idleMs >= this.config.deepSleepThresholdMs) {
      target = 'deep_sleep';
    } else if (idleMs >= this.config.sleepThresholdMs) {
      target = 'sleep';
    } else if (idleMs >= this.config.idleThresholdMs) {
      target = 'idle';
    } else {
      target = 'active';
    }

    if (target !== this.state) {
      this.logger.info(LOG_CATEGORY, 'Power state transition', {
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
      this.logger.info(LOG_CATEGORY, 'Entering deep sleep — timer stopped');
      this.timer = null;
      return;
    }

    // Run eligible jobs
    for (const job of this.jobs) {
      if (!job.runIn.includes(this.state)) continue;

      try {
        await job.fn();
      } catch (err) {
        this.logger.error(LOG_CATEGORY, `Job "${job.name}" failed`, {
          error: (err as Error).message,
        });
      }
    }

    this.scheduleNextTick();
  }
}
