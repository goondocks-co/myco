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
import { ensureAgent } from '../core/runs.js';
import { HARNESS_AGENT_ID } from '../core/harness.js';

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
/** The channel an import names on a write that carries the time it happened. */
const IMPORT_CHANNEL = 'import';

/** The agent row a write attributed to Myco's own agent names, made present before the write, which can precede the Deployment's first dispatch. */
async function ensureNamedAgent(env: ServerEnv, agentId: string, now: number): Promise<void> {
  if (agentId !== HARNESS_AGENT_ID) return;
  await ensureAgent(env.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: null, model: null, enabled: true }, now);
}

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

  await ensureNamedAgent(env, agentId, ctx.now);
  const scope = { projectId: ctx.projectId };
  const spore = await insertSpore(env.db, scope, {
    id, agentId, sessionId, promptId, observationType, status, content, context,
    importance: int(body.importance) ?? 5, filePath, tags, contentHash, properties, author: ctx.memberId,
    createdAt: int(body.createdAt) ?? ctx.now,
  });
  if (spore !== null) return Response.json({ persisted: true, spore });
  // An id already held answers the row as it stands and writes nothing.
  return Response.json({ persisted: true, duplicate: true, spore: await getSpore(env.db, scope, id) });
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
 * no event exists for it, which a caller must not read as a resolution. An
 * event id already recorded changes nothing and answers `duplicate`. On the
 * `import` channel the event keeps the time it names (`createdAt`); every other
 * resolution is dated when it arrives.
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

  const at = body.channel === IMPORT_CHANNEL ? int(body.createdAt) ?? ctx.now : ctx.now;
  await ensureNamedAgent(env, agentId, ctx.now);
  const outcome = await resolveSpore(env.db, { projectId: ctx.projectId }, status, {
    id: eventId, agentId, sporeId, action, newSporeId, reason, sessionId, author: ctx.memberId, createdAt: at,
  }, at);
  return Response.json({ persisted: true, resolved: outcome !== false, ...(outcome === 'duplicate' ? { duplicate: true } : {}) });
}
