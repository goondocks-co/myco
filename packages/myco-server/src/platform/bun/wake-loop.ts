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

export interface WakeLoop {
  /** Wake soon, unless a wake is already due sooner. */
  ensure(): Promise<void>;
  stop(): void;
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
const ENSURE_SOON_MS = 1_000;

export function startWakeLoop(tick: () => Promise<{ nextWakeMs: number | null }>, options: WakeLoopOptions): WakeLoop {
  const soonMs = options.soonMs ?? ENSURE_SOON_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueAt = Number.POSITIVE_INFINITY;
  let running = false;
  let again = false;
  let stopped = false;

  const arm = (delayMs: number): void => {
    if (stopped) return;
    const bounded = Math.max(0, Math.min(delayMs, options.floorMs));
    const at = Date.now() + bounded;
    if (timer !== null) {
      if (at >= dueAt) return;
      clearTimeout(timer);
    }
    dueAt = at;
    timer = setTimeout(() => { timer = null; dueAt = Number.POSITIVE_INFINITY; void fire(); }, bounded);
    (timer as { unref?: () => void }).unref?.();
  };

  const fire = async (): Promise<void> => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    let nextWakeMs: number | null = options.floorMs;
    try {
      nextWakeMs = (await tick()).nextWakeMs;
    } catch {
      // The tick reports its own failures; the loop's job is only to come back.
    } finally {
      running = false;
    }
    if (again) { again = false; arm(0); return; }
    arm(nextWakeMs ?? options.floorMs);
  };

  if (options.immediate !== false) arm(0);
  else arm(options.floorMs);

  return {
    ensure: async () => { arm(soonMs); },
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
