import type { DaemonLogger } from './logger.js';
import { LOG_KINDS } from '../constants/log-kinds.js';

export type PowerState = 'active' | 'idle' | 'sleep' | 'deep_sleep';

export interface PowerManagerConfig {
  idleThresholdMs: number;
  sleepThresholdMs: number;
  deepSleepThresholdMs: number;
  activeIntervalMs: number;
  sleepIntervalMs: number;
  logger: DaemonLogger;
  /** Called once per tick with the resolved state. The runner dispatches; PowerManager never runs jobs. */
  onTick: (state: PowerState) => void;
  /** Returns the name of the job holding deep-sleep, or null if none. */
  deepSleepHolder: () => string | null;
}

export class PowerManager {
  private state: PowerState = 'active';
  private lastActivity: number = Date.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private config: PowerManagerConfig;
  private logger: DaemonLogger;
  private deepSleepHeld = false;

  constructor(config: PowerManagerConfig) {
    this.config = config;
    this.logger = config.logger;
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
    this.logger.info(LOG_KINDS.POWER_STATE, 'PowerManager started');
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
      const holder = this.config.deepSleepHolder();
      if (holder !== null) {
        target = 'sleep';
        if (!this.deepSleepHeld) {
          this.deepSleepHeld = true;
          this.logger.info(LOG_KINDS.POWER_STATE, 'Deep sleep held', { by: holder });
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

    // The power loop is the daemon's heartbeat — a throw from state
    // evaluation, a job dispatch, or the logger must neither become an
    // unhandled rejection (timer-invoked: nothing awaits this) nor kill the
    // loop. Failures are logged and the next tick still schedules; the
    // deep_sleep stop is the one deliberate non-reschedule and the finally
    // is gated to preserve it.
    let enteredDeepSleep = false;
    try {
      this.evaluateState();

      if (this.state === 'deep_sleep') {
        enteredDeepSleep = true;
        this.timer = null;
        this.logger.info(LOG_KINDS.POWER_STATE, 'Entering deep sleep — timer stopped');
        return;
      }

      this.config.onTick(this.state);
    } catch (err) {
      // DaemonLogger never throws, but this class accepts injected Logger
      // substitutes — the heartbeat must not depend on their discipline.
      try {
        this.logger.error(LOG_KINDS.POWER_STATE, 'Power tick failed — loop continues', {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? (err.stack ?? null) : null,
        });
      } catch { /* logging best-effort */ }
    } finally {
      if (!enteredDeepSleep) this.scheduleNextTick();
    }
  }

  /**
   * @internal test seam
   * Drive exactly one tick. Test-only — avoids start()'s real timer.
   */
  tickOnceForTest(): void {
    void this.tick();
  }

  /**
   * @internal test seam
   * Re-evaluate and return the resolved state. Test-only.
   */
  evaluateStateForTest(): PowerState {
    this.evaluateState();
    return this.state;
  }
}
