import { heldTranscriptsFor } from '../read/transcript.js';
import { sessionsWithImportedPrompts } from '../read/sessions.js';
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { LEGACY_HISTORY_MAX_EVENTS, LEGACY_IMPORT_ADAPTER } from '@goondocks/myco-shared/member-protocol';
import { importedLegacyHistory, importedLegacyRows, legacyDestinationState } from '../read/legacy-history.js';
import { refused } from '../ingest/events.js';
import { refusal } from '../telemetry.js';

/** Confirm source records using their stored Project, authorship and machine provenance. */
export async function handleLegacyHistory(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  let body: unknown;
  try { body = JSON.parse(ctx.body); } catch { body = null; }
  const object = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const groups = object.eventGroups;
  const recordIds = object.recordIds ?? [];
  const sporeIds = object.sporeIds ?? [];
  const lineageIds = object.lineageIds ?? [];
  const sessions = object.sessions ?? [];
  const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= LEGACY_HISTORY_MAX_EVENTS
    && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 384);
  if (!Array.isArray(groups) || groups.length > LEGACY_HISTORY_MAX_EVENTS
    || !groups.every((group): group is string[] => ids(group) && group.length > 0 && group.every(id => /^[0-9a-f-]{36}$/.test(id)))
    || !ids(recordIds) || !recordIds.every(id => /^[0-9a-f-]{36}$/.test(id)) || !ids(sporeIds) || !ids(lineageIds)
    || !ids(sessions) || (object.projectState !== undefined && object.projectState !== true)
    || (groups.flat().length + recordIds.length + sporeIds.length + lineageIds.length + sessions.length === 0 && object.projectState !== true)
    || groups.flat().length + recordIds.length + sporeIds.length + lineageIds.length + sessions.length > LEGACY_HISTORY_MAX_EVENTS) {
    return Response.json(refused(ctx, refusal('source completion identities must be bounded', 'parse')));
  }
  const held = await importedLegacyHistory(env.db, ctx.projectId, ctx.machineId, groups.flat());
  const records = await importedLegacyHistory(env.db, ctx.projectId, ctx.machineId, recordIds, false);
  const rows = await importedLegacyRows(env.db, ctx.projectId, ctx.memberId, ctx.machineId, sporeIds, lineageIds);
  const confirmed = groups.every(group => group.some(id => held.has(id)))
    && recordIds.every(id => records.has(id)) && sporeIds.every(id => rows.sporeIds.has(id)) && lineageIds.every(id => rows.lineageIds.has(id));
  const sources = object.sessions === undefined ? {} : { sources: {
    withTranscript: [...new Set((await heldTranscriptsFor(env.db, { projectId: ctx.projectId }, sessions, [], ctx.machineId)).filter(t => t.size > 0).map(t => t.sessionId))].sort(),
    vaultSourced: [...await sessionsWithImportedPrompts(env.db, { projectId: ctx.projectId }, sessions, LEGACY_IMPORT_ADAPTER)].sort(),
  } };
  return Response.json({ persisted: true, confirmed, ...sources,
    ...(object.projectState === true ? { projectState: await legacyDestinationState(env.db, ctx.projectId) } : {}), ...(confirmed ? { eventIds: [...held].sort(),
    ...(object.recordIds === undefined ? {} : { recordIds: [...records].sort() }),
    ...(object.sporeIds === undefined ? {} : { sporeIds: [...rows.sporeIds].sort() }),
    ...(object.lineageIds === undefined ? {} : { lineageIds: [...rows.lineageIds].sort() }) } : {}) });
}
