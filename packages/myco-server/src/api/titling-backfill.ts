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
import { settingsWriter, leafValues } from '../core/settings.js';
import { TITLING_TASK, titlingBackfillProgress } from '../core/titling.js';
import { badRequest, ok, readJsonObject } from './scope.js';

const OVERRIDES_LEAF = 'agent.tasks';

/** `GET /api/titling-backfill`: the policy, what is left to title, and how the trailing day's runs went. */
export async function handleTitlingBackfill(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return ok(await titlingBackfillProgress(env, ctx.now));
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const UNREADABLE = 'the task overrides held by the server cannot be read; correct them under Task overrides in Settings first';

/** `PUT /api/titling-backfill` with `{ enabled }`: sets the backfill block's switch in the owner's task overrides and answers the progress as it then stands. An absent task entry or schedule is created; one that is present and not an object, `null` included, is refused rather than replaced. */
export async function handleSetTitlingBackfill(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  const enabled = body?.enabled;
  if (typeof enabled !== 'boolean') return badRequest('enabled must be true or false');
  const raw = (await leafValues(env.db, [OVERRIDES_LEAF])).get(OVERRIDES_LEAF);
  let held: unknown = {};
  if (raw !== undefined) {
    try { held = JSON.parse(raw); } catch { return badRequest(UNREADABLE); }
  }
  if (!isObject(held)) return badRequest(UNREADABLE);
  const task = Object.hasOwn(held, TITLING_TASK) ? held[TITLING_TASK] : {};
  if (!isObject(task)) return badRequest(UNREADABLE);
  const schedule = Object.hasOwn(task, 'schedule') ? task.schedule : {};
  if (!isObject(schedule)) return badRequest(UNREADABLE);
  const next = { ...held, [TITLING_TASK]: { ...task, schedule: { ...schedule, enabled } } };
  const result = await settingsWriter(env.db).setLeaf(OVERRIDES_LEAF, next, ctx.member.id, ctx.now);
  if (!result.applied) {
    const refusal = result.refusal;
    return badRequest(`the task overrides could not be written: ${refusal.reason === 'invalid_value' ? refusal.detail : refusal.reason}; correct them under Task overrides in Settings first`);
  }
  return ok(await titlingBackfillProgress(env, ctx.now));
}
