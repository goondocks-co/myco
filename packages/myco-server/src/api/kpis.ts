import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { badRequest, ok } from './scope.js';
import { kpiWindow, readKpis } from '../read/kpis.js';

export async function handleKpis(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const window = kpiWindow(ctx.url.searchParams.get('window'));
  if (window === undefined) return badRequest('window must be one of all, 7, 30, 90');
  return ok(await readKpis(env.db, { window, now: ctx.now }));
}
