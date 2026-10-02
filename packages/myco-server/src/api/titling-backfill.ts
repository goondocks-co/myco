/**
 * The imported-session backfill, for the operator: where it stands, and the
 * switch that starts and stops it.
 *
 * The switch is the `enabled` field of the `title-summary` schedule block in
 * the owner's `agent.tasks` override, written through the one settings writer;
 * the block's other fields stay as the override holds them.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { settingsWriter } from '../core/settings.js';
import { TITLING_TASK, titlingBackfillProgress } from '../core/titling.js';
import { badRequest, ok, readJsonObject } from './scope.js';

/** `GET /api/titling-backfill`: the policy, what is left to title, and how the trailing day's runs went. */
export async function handleTitlingBackfill(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return ok(await titlingBackfillProgress(env, ctx.now));
}


/** `PUT /api/titling-backfill` with `{ enabled }`: sets the backfill block's switch in the owner's task overrides and answers the progress as it then stands. An absent task entry or schedule is created; one that is present and not an object, `null` included, is refused rather than replaced. */
export async function handleSetTitlingBackfill(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  const enabled = body?.enabled;
  if (typeof enabled !== 'boolean') return badRequest('enabled must be true or false');
  const result = await settingsWriter(env.db, { target: env.platform.name }).setTaskSwitch(TITLING_TASK, enabled, ctx.member.id, ctx.now);
  if (!result.applied) {
    const refusal = result.refusal;
    return badRequest(`the task overrides could not be written: ${refusal.reason === 'invalid_value' ? refusal.detail : refusal.reason}; correct them under Task overrides in Settings first`);
  }
  return ok(await titlingBackfillProgress(env, ctx.now));
}
