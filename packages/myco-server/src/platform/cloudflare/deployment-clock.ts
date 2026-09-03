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
    if (report.nextWakeMs === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(now + report.nextWakeMs);
    return report;
  }

  /** Wake soon, unless an alarm is already set. */
  async ensure(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ENSURE_SOON_MS);
  }

  override async alarm(): Promise<void> {
    await this.wake();
  }
}
