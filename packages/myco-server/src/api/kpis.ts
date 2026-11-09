/**
 * The measures surface: what this Deployment can say about itself, measured.
 *
 * A ready answer always carries every measure, including those with an empty
 * sample. A building answer carries observation metadata and catch-up progress.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { badRequest, ok } from './scope.js';
import { kpiWindow, readKpis } from '../db/insights/kpis.js';

export async function handleKpis(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const window = kpiWindow(ctx.url.searchParams.get('window'));
  if (window === undefined) return badRequest('window must be one of all, 7, 30, 90');
  return ok(await readKpis(env.db, { window, now: ctx.now }));
}
