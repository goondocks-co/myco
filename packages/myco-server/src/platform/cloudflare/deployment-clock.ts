/**
 * The Worker's wake: one Durable Object holding one alarm.
 *
 * An alarm takes an absolute instant, is re-armed on each fire, and costs
 * nothing while none is set — which is what deep sleep means. The tick
 * decides the instant; this object only holds it. A cron trigger in
 * `wrangler.toml` calls `wake` as a floor, for a Deployment holding no alarm.
 * Both paths run the same idempotent tick, so a wake delivered twice changes
 * nothing.
 */
import { DurableObject } from 'cloudflare:workers';
import { runTick, type TickReport } from '../../core/tick.js';
import { serialGate } from '../../core/serial-gate.js';
import { WAKE_CONTINUATIONS } from '../../core/jobs.js';
import { classify, emit } from '../../telemetry.js';
import { serverEnvFromBindings, type CloudflareBindings } from './env.js';
import { PRODUCER_NAME } from './recovery-producer-object.js';

/** The one clock a Deployment keeps. */
export const CLOCK_NAME = 'deployment';
/** How soon `ensure` wakes when no alarm is set. */
const ENSURE_SOON_MS = 1_000;

/**
 * The clock that ticks only when a caller asks it to.
 *
 * A Deployment's clock arms its own next alarm, so one wake produces the next
 * without anyone asking. A test target driving ticks by route needs its ticks
 * to be exactly the wakes it posts — an alarm firing between two assertions is
 * a tick the scenario did not ask for and cannot see.
 */
export const CLOCK_MANUAL = 'manual';

/** Whether this clock keeps an alarm of its own. */
export function clockArmsAlarms(bindings: { CLOCK_MODE?: string }): boolean {
  return bindings.CLOCK_MODE !== CLOCK_MANUAL;
}

/** What a clock holds an alarm in. */
export interface AlarmStore {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** Hold the instant a tick asked for, or none: deep sleep and a manual clock both arm nothing. */
export async function armNextWake(
  storage: AlarmStore, bindings: { CLOCK_MODE?: string }, now: number, nextWakeMs: number | null,
): Promise<void> {
  if (nextWakeMs === null || !clockArmsAlarms(bindings)) {
    await storage.deleteAlarm();
    return;
  }
  await storage.setAlarm(now + nextWakeMs);
}

/**
 * The floor a wake arms before it does anything that can throw, so a reset or a failure leaves a usable wake. It is
 * shorter than the ordinary tick interval: a continuation in flight needs the next one soon, and it never
 * pushes an alarm that is already sooner.
 */
export const CONTINUATION_FLOOR_MS = 2_000;

export async function armFloor(storage: AlarmStore, bindings: { CLOCK_MODE?: string }, now: number): Promise<void> {
  if (!clockArmsAlarms(bindings)) return;
  const held = await storage.getAlarm();
  if (held === null || held > now + CONTINUATION_FLOOR_MS) await storage.setAlarm(now + CONTINUATION_FLOOR_MS);
}

/** The sooner of the tick's own next wake and a continuation's deadline; neither may cancel the other. */
export function soonestWake(tickMs: number | null, continuationMs: number | null): number | null {
  if (tickMs === null) return continuationMs;
  if (continuationMs === null) return tickMs;
  return Math.min(tickMs, continuationMs);
}

/**
 * What one wake did. A wake that could not tick says so rather than answering an empty tick: the Deployment's
 * database is unreadable while its own export runs, and a fabricated report would read as a quiet success.
 */
export type WakeOutcome =
  | { ticked: true; report: TickReport }
  | { ticked: false; heldBy: 'recovery_export'; attempt: number | null; stage: string };

/**
 * Runs each continuation the registry declares, before any storage read, and reports the soonest deadline they ask
 * for. A continuation advances something already admitted; it opens nothing and decides no cadence.
 */
async function runContinuations(bindings: CloudflareBindings): Promise<{ attempt: number | null; stage: string; nextInMs: number | null; sourcePaused: boolean }> {
  let held: { attempt: number | null; stage: string; nextInMs: number | null; sourcePaused: boolean } = {
    attempt: null, stage: 'idle', nextInMs: null, sourcePaused: false,
  };
  for (const declared of WAKE_CONTINUATIONS) {
    const run = CONTINUATION_IMPLEMENTATIONS[declared.name];
    if (run === undefined) {
      emit({ kind: 'continuation_unimplemented', continuation: declared.name });
      continue;
    }
    try {
      const report = await run(bindings);
      held = {
        attempt: report.attempt ?? held.attempt,
        stage: report.attempt === null ? held.stage : report.stage,
        nextInMs: soonestWake(held.nextInMs, report.nextInMs),
        sourcePaused: held.sourcePaused || report.sourcePaused,
      };
    } catch (error) {
      emit({ kind: 'continuation_failed', continuation: declared.name, error_class: classify(error) });
      held = { ...held, nextInMs: soonestWake(held.nextInMs, CONTINUATION_FLOOR_MS) };
    }
  }
  return held;
}

/** What each declared continuation runs. A gate holds this map and the registry to each other. */
export const CONTINUATION_IMPLEMENTATIONS: Record<string, (bindings: CloudflareBindings) => Promise<{ attempt: number | null; stage: string; nextInMs: number | null; sourcePaused: boolean }>> = {
  'recovery-export-continuation': async (bindings) => {
    const producer = bindings.RECOVERY;
    if (producer === undefined) return { attempt: null, stage: 'idle', nextInMs: null, sourcePaused: false };
    return producer.get(producer.idFromName(PRODUCER_NAME)).continue();
  },
};

/** Wake soon, unless an alarm is already set or this clock keeps none. */
export async function armSoon(storage: AlarmStore, bindings: { CLOCK_MODE?: string }, now: number): Promise<void> {
  if (!clockArmsAlarms(bindings)) return;
  if ((await storage.getAlarm()) === null) await storage.setAlarm(now + ENSURE_SOON_MS);
}

/** The cron floor's wake: the clock's tick, on a configuration that declares a clock. */
export async function wakeClock(bindings: CloudflareBindings): Promise<void> {
  const clock = bindings.CLOCK;
  if (clock === undefined) return;
  await clock.get(clock.idFromName(CLOCK_NAME)).wake();
}

export class DeploymentClock extends DurableObject<CloudflareBindings> {
  /** One wake at a time in this object: an alarm and a cron floor arriving together run back to back rather than doubling store calls. */
  private readonly gate = serialGate();

  /** Run the tick now and arm the next alarm from its answer; deep sleep arms none. */
  async wake(): Promise<WakeOutcome> {
    return this.gate.exclusive(() => this.wakeOnce());
  }

  private async wakeOnce(): Promise<WakeOutcome> {
    const now = Date.now();
    const work: Promise<unknown>[] = [];
    try {
      // Armed before anything that can throw: the continuation below can leave the Deployment's own database
      // unreadable, which makes the tick throw, and an unarmed clock stays dark until the cron floor.
      await armFloor(this.ctx.storage, this.env, now);
      const continuation = await runContinuations(this.env);
      if (continuation.sourcePaused) {
        emit({ kind: 'tick_held', held_by: 'recovery_export', attempt: continuation.attempt, stage: continuation.stage });
        await armNextWake(this.ctx.storage, this.env, Date.now(), soonestWake(CONTINUATION_FLOOR_MS, continuation.nextInMs));
        return { ticked: false, heldBy: 'recovery_export', attempt: continuation.attempt, stage: continuation.stage };
      }
      try {
        const report = await runTick(serverEnvFromBindings(this.env, { lifetime: 'clock', waitUntil: (promise) => { work.push(promise); } }), now, { wake: 'clock' });
        await armNextWake(this.ctx.storage, this.env, Date.now(), soonestWake(report.nextWakeMs, continuation.nextInMs));
        return { ticked: true, report };
      } catch (error) {
        // The failure is the answer: the alarm stays armed at least at the floor, and the wake raises rather than
        // answering a quiet empty tick. A failing tick must never leave the Deployment with no wake at all.
        emit({ kind: 'wake_failed', error_class: classify(error) });
        await armNextWake(this.ctx.storage, this.env, Date.now(), soonestWake(CONTINUATION_FLOOR_MS, continuation.nextInMs));
        throw error;
      }
    } finally { await Promise.all(work); }
  }

  /** Wake soon, unless an alarm is already set. */
  async ensure(): Promise<void> {
    await armSoon(this.ctx.storage, this.env, Date.now());
  }

  override async alarm(): Promise<void> {
    await this.wake();
  }
}
