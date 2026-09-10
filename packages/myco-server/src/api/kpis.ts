/**
 * The measures surface: what this Deployment can say about itself, measured.
 *
 * One route, one answer. Every figure is derived at read time from rows the
 * Deployment already holds, so there is nothing to schedule, nothing to backfill,
 * and no stored aggregate that can disagree with the rows under it.
 *
 * The answer always carries every measure, including the ones with an empty
 * sample. A surface that omits a measure it cannot compute leaves a reader unable
 * to tell an absent feed from a forgotten tile.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { ok } from './scope.js';
import { kpiWindow, readKpis } from '../read/kpis.js';

export async function handleKpis(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const windowDays = kpiWindow(ctx.url.searchParams.get('window'));
  return ok(await readKpis(env.db, { windowDays, now: ctx.now }));
}
