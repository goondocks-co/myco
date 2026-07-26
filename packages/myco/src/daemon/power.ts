import type { DaemonLogger } from './logger.js';
import { LOG_KINDS } from '../constants/log-kinds.js';

export type PowerState = 'active' | 'idle' | 'sleep' | 'deep_sleep';

/**
 * Power states ordered shallow → deep. A state's index is its "depth", which
 * is what assertion constraints are expressed against.
 */
export const POWER_STATE_DEPTH: Record<PowerState, number> = {
  active: 0,
  idle: 1,
  sleep: 2,
  deep_sleep: 3,
};

const DEPTH_TO_STATE: readonly PowerState[] = ['active', 'idle', 'sleep', 'deep_sleep'];

/**
 * A constraint on how deep the daemon may go, contributed by a registered
 * source. Modelled on OS power assertions (IOPMAssertion, systemd inhibit,
 * Android wake locks): components state a constraint, and the manager
 * resolves all of them at each evaluation.
 */
export interface PowerAssertion {
  /** Namespaced and stable — `drain:embedding-reconcile`, `liveness:agent`. */
  name: string;
  /** The daemon may not go deeper than this state while the assertion holds. */
  maxDepth: PowerState;
  /**
   * The daemon must be at least this deep. Reserved for intentional-sleep
   * sources (quiet hours, battery saver); no source ships one today, and
   * `maxDepth` wins on conflict.
   */
  minDepth?: PowerState;
  /** Human-readable justification, surfaced by the power inventory. */
  reason?: string;
  /** Epoch ms. Absent means probe-backed — the source withdraws it instead. */
  expiresAt?: number;
}

/**
 * A registered contributor of assertions, probed at each evaluation.
 *
 * Pull rather than push: a source that is registered is always consulted, so
 * liveness cannot be lost by a call site forgetting to report it — the bug
 * class that let the daemon deep-sleep through active agent work.
 */
export interface AssertionSource {
  name: string;
  probe: () => PowerAssertion[];
}

/** A live assertion tagged with the source that produced it, for reporting. */
export type HeldAssertion = PowerAssertion & { source: string };

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
  private sources: AssertionSource[] = [];
  private lastTransition: { from: PowerState; to: PowerState; atMs: number; idleMs: number } | null = null;

  constructor(config: PowerManagerConfig) {
    this.config = config;
    this.logger = config.logger;

    // The pre-existing job-runner hold, expressed in the general model. It is
    // a `sleep`-depth constraint: pending queued work means the daemon may
    // still sleep, but must not stop ticking entirely.
    this.registerAssertionSource({
      name: 'job-runner',
      probe: () => {
        const holder = this.config.deepSleepHolder();
        if (holder === null) return [];
        // Name is the bare job name, not a namespaced one: it lands in the
        // `by:` field of the "Deep sleep held" log, whose shape operators
        // already read. The namespace is carried by the source instead.
        return [{
          name: holder,
          maxDepth: 'sleep',
          reason: 'pending queued work',
        }];
      },
    });
  }

  /**
   * Register a contributor of power assertions. Sources are probed on every
   * evaluation, so registration is the whole contract — there is no call site
   * to keep in sync.
   *
   * Names should be unique; the inventory reports whichever source produced
   * the binding constraint.
   */
  registerAssertionSource(source: AssertionSource): void {
    this.sources.push(source);
  }

  /**
   * Live assertions across all registered sources, expired entries dropped.
   *
   * A probe that throws yields a `sleep`-depth assertion rather than nothing.
   * Mirrors `JobRunner.providesHold()`: a probe that cannot answer is not
   * evidence there is nothing to do, and sleeping stops the drains, so the
   * safe error is staying out of deep sleep.
   */
  currentAssertions(now: number = Date.now()): HeldAssertion[] {
    const live: HeldAssertion[] = [];
    for (const source of this.sources) {
      let produced: PowerAssertion[];
      try {
        produced = source.probe();
      } catch (err) {
        try {
          this.logger.warn(LOG_KINDS.POWER_STATE, 'Assertion probe failed — holding out of deep sleep', {
            source: source.name,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch { /* logging best-effort */ }
        live.push({
          source: source.name,
          name: `${source.name}:probe-failed`,
          maxDepth: 'sleep',
          reason: 'assertion probe threw',
        });
        continue;
      }
      for (const assertion of produced) {
        if (assertion.expiresAt !== undefined && assertion.expiresAt <= now) continue;
        live.push({ ...assertion, source: source.name });
      }
    }
    return live;
  }

  /**
   * Edge signal: an `interaction`-class request reached the daemon.
   *
   * Deep sleep stops the tick timer, so nothing polls and no registered
   * assertion source can revive the daemon on its own. Exactly one push edge
   * is required to escape that state, and this is it.
   *
   * Advancing `lastActivity` is load-bearing, not incidental: it is what
   * returns the daemon to `active` and restarts natural decay through
   * `idle` and `sleep`. Assertions only ever constrain how deep decay may
   * go — none of them drives it — so if this did not advance the clock,
   * nothing would, and the daemon would settle at `sleep` permanently with
   * every drain running on the slow tick.
   *
   * Called on every qualifying request, so the armed-timer path must stay
   * O(1) and allocation-free.
   */
  wake(): void {
    if (!this.running) return;
    this.lastActivity = Date.now();
    this.deepSleepHeld = false;

    // A null timer means the loop was stopped, which only `tick()` does on
    // entering deep sleep. Anything else is already scheduled.
    if (this.timer !== null) return;

    this.logger.info(LOG_KINDS.POWER_STATE, 'Waking from deep sleep');
    this.state = 'active';
    this.scheduleNextTick();
  }

  /** @deprecated Use {@link wake}. Retained until the legacy call sites go. */
  recordActivity(): void {
    this.wake();
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

  /**
   * Everything needed to answer "why is the daemon in this state, and what is
   * holding it there".
   *
   * Before this, the global power state had no reader at all — `getState()`
   * had zero production callers — so a daemon that had quietly stopped
   * ticking looked identical to one with nothing to do.
   */
  report(): {
    state: PowerState;
    idleMs: number;
    assertions: HeldAssertion[];
    lastTransition: { from: PowerState; to: PowerState; atMs: number; idleMs: number } | null;
  } {
    const now = Date.now();
    this.evaluateState();
    return {
      state: this.state,
      idleMs: now - this.lastActivity,
      assertions: this.currentAssertions(now),
      lastTransition: this.lastTransition,
    };
  }

  private evaluateState(): void {
    const now = Date.now();
    const idleMs = now - this.lastActivity;

    // Natural decay from elapsed inactivity. Assertions only constrain this
    // result — they never drive it, so housekeeping tiers keep their windows.
    const natural: PowerState =
      idleMs >= this.config.deepSleepThresholdMs ? 'deep_sleep'
      : idleMs >= this.config.sleepThresholdMs ? 'sleep'
      : idleMs >= this.config.idleThresholdMs ? 'idle'
      : 'active';

    let target = natural;
    let clampedBy: string | null = null;

    // `active` is the shallowest state, so no maxDepth constraint can pull it
    // shallower — skip probing entirely on the busy path. Past that, sources
    // are probed on every evaluation rather than only at the deep-sleep
    // boundary as before; probes are TTL-cached and evaluations are at most
    // once per tick.
    if (natural !== 'active') {
      let cap = POWER_STATE_DEPTH.deep_sleep;
      let capName: string | null = null;
      let floor = POWER_STATE_DEPTH.active;

      for (const assertion of this.currentAssertions(now)) {
        const maxDepth = POWER_STATE_DEPTH[assertion.maxDepth];
        if (maxDepth < cap) {
          cap = maxDepth;
          capName = assertion.name;
        }
        if (assertion.minDepth !== undefined) {
          const minDepth = POWER_STATE_DEPTH[assertion.minDepth];
          if (minDepth > floor) floor = minDepth;
        }
      }

      let depth = POWER_STATE_DEPTH[natural];
      // minDepth first, then the maxDepth clamp — so stay-awake wins on
      // conflict. Wrongly sleeping costs real work; wrongly waking costs power.
      if (depth < floor) depth = floor;
      if (depth > cap) {
        depth = cap;
        clampedBy = capName;
      }
      target = DEPTH_TO_STATE[depth]!;
    }

    // Preserves the once-per-hold log dedupe: a daemon held out of deep sleep
    // every tick must not emit a line every tick.
    if (natural === 'deep_sleep' && clampedBy !== null) {
      if (!this.deepSleepHeld) {
        this.deepSleepHeld = true;
        this.logger.info(LOG_KINDS.POWER_STATE, 'Deep sleep held', { by: clampedBy });
      }
    } else {
      this.deepSleepHeld = false;
    }

    if (target !== this.state) {
      this.logger.info(LOG_KINDS.POWER_STATE, 'Power state transition', {
        from: this.state,
        to: target,
        idle_ms: idleMs,
      });
      // Kept in memory as well as logged. These logs are emitted outside any
      // request scope, so they persist to the daemon's anchor DB rather than
      // the Grove DB a reader would naturally query — which is exactly why
      // the transition history looked "missing" while it was in fact intact.
      this.lastTransition = { from: this.state, to: target, atMs: now, idleMs };
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
