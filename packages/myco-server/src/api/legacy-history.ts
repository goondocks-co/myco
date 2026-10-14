import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { LEGACY_HISTORY_MAX_EVENTS } from '@goondocks/myco-shared/member-protocol';
import { importedLegacyHistory } from '../read/legacy-history.js';
import { refused } from '../ingest/events.js';
import { refusal } from '../telemetry.js';

/** Only the authenticated machine's imported events under the requested Project can confirm a source. */
export async function handleLegacyHistory(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  let body: unknown;
  try { body = JSON.parse(ctx.body); } catch { body = null; }
  const groups = typeof body === 'object' && body !== null && 'eventGroups' in body ? body.eventGroups : null;
  if (!Array.isArray(groups) || groups.length === 0 || groups.length > LEGACY_HISTORY_MAX_EVENTS
    || !groups.every((group): group is string[] => Array.isArray(group) && group.length > 0 && group.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)))
    || groups.flat().length > LEGACY_HISTORY_MAX_EVENTS) {
    return Response.json(refused(ctx, refusal('eventGroups must be bounded source completion identities', 'parse')));
  }
  const held = await importedLegacyHistory(env.db, ctx.projectId, ctx.machineId, groups.flat());
  const confirmed = groups.every(group => group.some(id => held.has(id)));
  return Response.json({ persisted: true, confirmed, ...(confirmed ? { eventIds: [...held].sort() } : {}) });
}
