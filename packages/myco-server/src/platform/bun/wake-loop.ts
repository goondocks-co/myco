/**
 * The self-hosted wake: one process timer, re-armed from each tick's answer.
 *
 * The tick names its own next instant; this arms a timer for it. A floor
 * bounds how long the Deployment goes without a wake whatever the tick said,
 * standing in for the cron the Worker target keeps: a timer on the machine
 * costs nothing, and a wake that never comes is a silent failure either way.
 * `ensure` is what requested work calls — a wake soon, unless one is already
 * sooner.
 */
import { ENSURE_SOON_MS, wakePolicy } from '../../core/wake-policy.js';
import { classify, emit } from '../../telemetry.js';

export interface WakeLoop {
  /** Wake soon, unless a wake is already due sooner. */
  ensure(): Promise<void>;
  /** Ends the loop; resolves once a tick already running has returned. */
  stop(): Promise<void>;
}

export interface WakeLoopOptions {
  /** The longest the loop waits between wakes, whatever the tick answers. */
  floorMs: number;
  /** How soon `ensure` wakes. */
  soonMs?: number;
  /** Whether the first tick runs at once; a test that drives the tick itself passes false. */
  immediate?: boolean;
}

export const WAKE_FLOOR_MS = 15 * 60_000;

export function startWakeLoop(tick: (workRequested: boolean) => Promise<{ nextWakeMs: number | null }>, options: WakeLoopOptions): WakeLoop {
  const soonMs = options.soonMs ?? ENSURE_SOON_MS;
  const timing = wakePolicy();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueAt = Number.POSITIVE_INFINITY;
  let running: Promise<unknown> | null = null;
  let again = false;
  let stopped = false;
  let workRequested = false;

  const arm = (delayMs: number): void => {
    if (stopped) return;
    const bounded = Math.max(0, Math.min(delayMs, options.floorMs));
    const at = timing.workAt(Date.now(), bounded);
    if (timer !== null) {
      if (at >= dueAt) return;
      clearTimeout(timer);
    }
    dueAt = at;
    timer = setTimeout(() => { timer = null; dueAt = Number.POSITIVE_INFINITY; void fire(); }, Math.max(0, at - Date.now()));
    (timer as { unref?: () => void }).unref?.();
  };

  const fire = async (): Promise<void> => {
    if (stopped) return;
    if (running !== null) { again = true; return; }
    let nextWakeMs: number | null = options.floorMs;
    const requested = workRequested;
    workRequested = false;
    const ticking = Promise.resolve().then(() => tick(requested));
    running = ticking;
    try {
      nextWakeMs = (await ticking).nextWakeMs;
      timing.succeeded();
    } catch (error) {
      workRequested ||= requested;
      nextWakeMs = timing.failed(Date.now());
      emit({ kind: 'wake_failed', error_class: classify(error) });
      if (timer !== null) clearTimeout(timer);
      timer = null;
      dueAt = Number.POSITIVE_INFINITY;
    } finally {
      running = null;
    }
    if (again) { again = false; arm(0); return; }
    arm(nextWakeMs ?? options.floorMs);
  };

  if (options.immediate !== false) arm(0);
  else arm(options.floorMs);

  return {
    ensure: async () => { workRequested = true; arm(soonMs); },
    stop: async () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await running?.catch(() => undefined);
    },
  };
}
