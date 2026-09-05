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
import { serverEnvFromBindings, type CloudflareBindings } from './env.js';

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
  /** Run the tick now and arm the next alarm from its answer; deep sleep arms none. */
  async wake(): Promise<TickReport> {
    const now = Date.now();
    const report = await runTick(serverEnvFromBindings(this.env), now);
    await armNextWake(this.ctx.storage, this.env, now, report.nextWakeMs);
    return report;
  }

  /** Wake soon, unless an alarm is already set. */
  async ensure(): Promise<void> {
    await armSoon(this.ctx.storage, this.env, Date.now());
  }

  override async alarm(): Promise<void> {
    await this.wake();
  }
}
