import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { countSpores, getSpore, listSpores, listSupersedingSporeIds, MAX_SPORE_LIMIT, MAX_SPORE_CONTENT_BYTES, RESOLUTION_ACTIONS } from '../core/spores.js';
import { writeSpore } from '../core/spore-admission.js';
import { refused } from '../ingest/events.js';
import { refusal } from '../telemetry.js';
import { parseJsonObject } from './scope.js';
export { MAX_SPORE_CONTENT_BYTES };
const parseBody = parseJsonObject;
const str = (v: unknown, max = 192): string | null => typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
const int = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined;
const BAD_BODY = refusal('body is not an object', 'parse');

async function write(env: ServerEnv, ctx: RouteContext, body: Record<string, unknown>, op: unknown): Promise<Response> {
  const input = { op, id: body.id ?? body.sporeId, old_spore_id: body.sporeId, new_spore_id: body.newSporeId,
    type: body.observationType, content: body.content, agent_line: body.agentLine, session_id: body.sessionId, prompt_id: body.promptId,
    tags: typeof body.tags === 'string' ? body.tags.split(',').map(tag => tag.trim()) : body.tags,
    provenance_kind: body.provenanceKind, provenance_ref: body.provenanceRef, reason: body.reason,
    expect_status: body.expectStatus, expect_revision: body.expectRevision,
    channel: body.channel, agent_id: body.agentId, created_at: body.createdAt, status: body.status,
    event_id: body.eventId, context: body.context, file_path: body.filePath, content_hash: body.contentHash, properties: body.properties, importance: body.importance };
  const outcome = await writeSpore(input, { env, projectId: ctx.projectId, now: ctx.now, principal: { kind: 'member', memberId: ctx.memberId, machineId: ctx.machineId } }) as Record<string, unknown>;
  if (outcome.ok === false) {
    if (op !== 'save' && outcome.error === 'spore_id not found') return Response.json({ persisted: true, resolved: false });
    return Response.json({ ...refused(ctx, refusal(String(outcome.reason ?? outcome.error), outcome.error === 'stale' ? 'stale' : 'invalid_field')),
      ...(outcome.status === undefined ? {} : { status: outcome.status, revision: outcome.revision }) });
  }
  if (op !== 'save') return Response.json({ persisted: true, resolved: outcome.resolved !== false, ...(outcome.duplicate ? { duplicate: true } : {}) });
  const held = await getSpore(env.db, { projectId: ctx.projectId }, String(outcome.id));
  const { authorKind: _kind, ...spore } = held ?? {};
  return Response.json({ persisted: true, spore: held === null ? null : spore, ...(outcome.duplicate ? { duplicate: true } : {}), ...(outcome.sourceKept ? { sourceKept: true } : {}) });
}

export async function handleSaveSpore(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (body === null) return Response.json(refused(ctx, BAD_BODY));
  if (str(body.id) === null) return Response.json(refused(ctx, refusal('id is required', 'parse')));
  return write(env, ctx, body, 'save');
}

export async function handleResolveSpore(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (body === null) return Response.json(refused(ctx, BAD_BODY));
  if (str(body.eventId) === null || str(body.sporeId) === null || !(RESOLUTION_ACTIONS as readonly unknown[]).includes(body.action)) return Response.json(refused(ctx, refusal('resolution requires eventId, sporeId and a known action', 'parse')));
  return write(env, ctx, body, body.action);
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
