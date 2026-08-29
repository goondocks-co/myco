/**
 * The spore surface.
 *
 * Reads and writes only; the meaning of a spore lives in `core/spores.ts`. A
 * resolution is one call rather than a status write followed by an event write,
 * so a caller cannot leave a spore superseded by nothing.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import {
  countSpores, getSpore, insertSpore, listSpores, listSupersedingSporeIds, resolveSpore,
  MAX_SPORE_CONTENT_BYTES, MAX_SPORE_LIMIT, RESOLUTION_ACTIONS, SPORE_STATUSES,
  type ResolutionAction, type SporeStatus,
} from '../core/spores.js';
import { refusal } from '../telemetry.js';
import { refused } from '../ingest/events.js';

export { MAX_SPORE_CONTENT_BYTES };
const MAX_ID_CHARS = 192;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = MAX_ID_CHARS): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const orNull = (v: unknown, max = MAX_ID_CHARS): string | null | undefined => (v === undefined || v === null ? null : str(v, max) ?? undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

function parseBody(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const BAD_BODY = refusal('body is not an object', 'parse');

export async function handleSaveSpore(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));

  const id = str(body.id);
  const agentId = str(body.agentId);
  const observationType = str(body.observationType);
  const content = str(body.content, MAX_SPORE_CONTENT_BYTES);
  const context = orNull(body.context, MAX_SPORE_CONTENT_BYTES);
  const sessionId = orNull(body.sessionId, 384);
  const promptId = orNull(body.promptId);
  const filePath = orNull(body.filePath, 4096);
  const tags = orNull(body.tags, 4096);
  const contentHash = orNull(body.contentHash);
  const properties = orNull(body.properties, MAX_SPORE_CONTENT_BYTES);
  const status = body.status === undefined ? 'active' : (SPORE_STATUSES as readonly string[]).includes(body.status as string) ? body.status as SporeStatus : null;

  if (id === null || agentId === null || observationType === null || content === null || status === null
    || context === undefined || sessionId === undefined || promptId === undefined
    || filePath === undefined || tags === undefined || contentHash === undefined || properties === undefined) {
    return Response.json(refused(ctx, refusal('a spore requires id, agentId, observationType and content, and a known status when given', 'parse')));
  }

  const spore = await insertSpore(env.db, { projectId: ctx.projectId }, {
    id, agentId, sessionId, promptId, observationType, status, content, context,
    importance: int(body.importance) ?? 5, filePath, tags, contentHash, properties,
    createdAt: int(body.createdAt) ?? ctx.now,
  });
  return Response.json({ persisted: true, spore });
}

export async function handleListSpores(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const scope = { projectId: ctx.projectId };
  const options = {
    agentId: str(body.agentId) ?? undefined,
    observationType: str(body.observationType) ?? undefined,
    status: str(body.status) ?? undefined,
    sessionId: str(body.sessionId, 384) ?? undefined,
    search: str(body.search, 1024) ?? undefined,
    since: int(body.since),
    // Absent means unfiltered, matching the local reader: only an explicit
    // `false` engages the terminal-session gate.
    includeActive: body.includeActive === false ? false : undefined,
    limit: int(body.limit),
    offset: int(body.offset),
  };
  const [spores, total] = await Promise.all([listSpores(env.db, scope, options), countSpores(env.db, scope, options)]);
  return Response.json({ persisted: true, spores, total, maxLimit: MAX_SPORE_LIMIT });
}

export async function handleGetSpore(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const id = str(body.id);
  if (id === null) return Response.json(refused(ctx, refusal('get requires id', 'parse')));
  const scope = { projectId: ctx.projectId };
  const spore = await getSpore(env.db, scope, id);
  return Response.json({
    persisted: true,
    spore,
    supersededBy: spore === null ? [] : await listSupersedingSporeIds(env.db, scope, id),
  });
}

/**
 * Move a spore's status and record why, in one call.
 *
 * `resolved: false` means the spore is not in this Project — nothing moved and
 * no event exists for it, which a caller must not read as a resolution.
 */
export async function handleResolveSpore(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));

  const eventId = str(body.eventId);
  const agentId = str(body.agentId);
  const sporeId = str(body.sporeId);
  const action = (RESOLUTION_ACTIONS as readonly string[]).includes(body.action as string) ? body.action as ResolutionAction : null;
  const status = (SPORE_STATUSES as readonly string[]).includes(body.status as string) ? body.status as SporeStatus : null;
  const newSporeId = orNull(body.newSporeId);
  const reason = orNull(body.reason, MAX_SPORE_CONTENT_BYTES);
  const sessionId = orNull(body.sessionId, 384);

  if (eventId === null || agentId === null || sporeId === null || action === null || status === null
    || newSporeId === undefined || reason === undefined || sessionId === undefined) {
    return Response.json(refused(ctx, refusal('a resolution requires eventId, agentId, sporeId, a known action and a known status', 'parse')));
  }
  // A supersession that names no successor is a status change wearing the wrong
  // name: the lineage it claims to record would be unreadable.
  if (action === 'supersede' && newSporeId === null) {
    return Response.json(refused(ctx, refusal('a supersede resolution requires newSporeId', 'refused')));
  }

  const resolved = await resolveSpore(env.db, { projectId: ctx.projectId }, status, {
    id: eventId, agentId, sporeId, action, newSporeId, reason, sessionId, createdAt: ctx.now,
  }, ctx.now);
  return Response.json({ persisted: true, resolved });
}
