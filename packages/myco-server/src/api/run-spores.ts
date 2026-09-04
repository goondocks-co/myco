/**
 * What a sweep run reads and writes.
 *
 * A run of a spore task holds no vault; it reaches this Project's spores over
 * these four routes, and each admits exactly one caller: the harness credential
 * that dispatched a live run of such a task (`heldRun`). A plain member, another
 * task, a finished run, or another credential of the harness is answered
 * `held: false`.
 *
 * The inventory carries previews rather than bodies. A sweep surveys every
 * active spore in a Project and reads in full only the handful it means to
 * resolve, so the size of a vault sets the cost of a pass over it, not the size
 * of its writing. The full reads are counted and bounded per run, and one body
 * arrives cut past its own bound: a prompt asking for restraint is a request,
 * and the surface holds the run to it.
 *
 * A spore a run records carries the run's own agent and the session its dispatch
 * named; a resolution records the same. Every resolution is validated by the
 * checks the member's tool applies (`core/spore-writes.ts`), in the same words.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { heldRun, sessionNamedByRun } from './run-admission.js';
import {
  countSpores, getSpore, insertSpore, listSpores, listSupersededSporeIds,
  listSupersedingSporeIds, resolveSpore, DEFAULT_SPORE_LIMIT, MAX_SPORE_CONTENT_BYTES, MAX_SPORE_LIMIT, RESOLUTION_ACTIONS,
  SPORE_BODY_CHARS, SPORE_FULL_READ_BUDGET, SPORE_PREVIEW_CHARS, SPORE_READ_TASKS, SPORE_STATUSES, SPORE_TOOL_TASKS,
  type ResolutionAction, type SporeRow,
} from '../core/spores.js';
import { DIGEST_FULL_READ_BODY_CHARS, DIGEST_SPORE_PAGE_LIMIT } from '../core/cortex-input.js';
import { DIGEST_TASK } from '../core/task-inputs.js';
import { mintSporeId, overSporeCap, planSporeResolution, SPORE_CAP_REASON, sporeTags } from '../core/spore-writes.js';
import { mutateState, type RunRow } from '../core/runs.js';
import { latestPromptId } from '../read/sessions.js';
import { refused } from '../ingest/events.js';
import { refusal, type Refusal } from '../telemetry.js';

const MAX_ID_CHARS = 192;
const MAX_SEARCH_CHARS = 1024;
const BAD_BODY: Refusal = refusal('body is not an object', 'parse');
/** The answer every route gives a caller that holds no run of a spore task. */
const UNHELD = { persisted: true, held: false } as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = MAX_ID_CHARS): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const orNull = (v: unknown, max = MAX_ID_CHARS): string | null | undefined => (v === undefined || v === null ? null : str(v, max) ?? undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);
const optional = (v: unknown, max = MAX_ID_CHARS): string | undefined => str(v, max) ?? undefined;
/** The importance a caller names, held to the 1..10 the tool describes; unnamed is the middle. */
const importanceOf = (v: unknown): number => {
  const named = int(v);
  return named === undefined ? 5 : Math.min(Math.max(named, 1), 10);
};

function parseBody(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Count one full read against this run's budget and answer the running total.
 *
 * The count lives under the run's own key in agent state, moved by the same
 * guarded write every other state value is moved by; a write that loses its
 * guard leaves the count where the winner put it, which spends a read at most
 * once per read served.
 */
async function spendFullRead(env: ServerEnv, ctx: RouteContext, run: RunRow): Promise<number> {
  let spent = 0;
  await mutateState(env.db, { projectId: ctx.projectId }, run.agentId, `spore_reads:${run.id}`, (current) => {
    const held = Number(current ?? 0);
    spent = (Number.isSafeInteger(held) && held > 0 ? held : 0) + 1;
    return String(spent);
  }, ctx.now);
  return spent;
}

/** One line, bounded: what a spore says, enough to group it with its neighbours. */
function preview(row: SporeRow): Record<string, unknown> {
  return {
    id: row.id,
    observationType: row.observationType,
    importance: row.importance,
    createdAt: row.createdAt,
    preview: row.content.replace(/\s+/g, ' ').trim().slice(0, SPORE_PREVIEW_CHARS),
  };
}

/**
 * The Project's spores as an inventory: one bounded line each, with the total
 * behind the page so a run knows how much it has not seen.
 */
export async function handleRunSpores(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  if (runId === null) return Response.json(refused(ctx, refusal('an inventory requires runId', 'parse')));
  const run = await heldRun(env, ctx, runId, SPORE_READ_TASKS);
  if (run === null) return Response.json(UNHELD);

  const asked = body.status === undefined || body.status === null ? 'active' : body.status;
  if (asked !== 'all' && !(SPORE_STATUSES as readonly string[]).includes(asked as string)) {
    return Response.json(refused(ctx, refusal(`status is one of ${SPORE_STATUSES.join(', ')} or all`, 'parse')));
  }
  // A digest run reads its material once and writes every tier from it, so its
  // page is the tier window's rather than the inventory's own.
  const ceiling = run.task === DIGEST_TASK ? DIGEST_SPORE_PAGE_LIMIT : MAX_SPORE_LIMIT;
  const options = {
    status: asked === 'all' ? undefined : asked as string,
    observationType: optional(body.observation_type),
    search: optional(body.search, MAX_SEARCH_CHARS),
    limit: Math.min(int(body.limit) ?? DEFAULT_SPORE_LIMIT, ceiling),
    offset: int(body.offset),
  };
  const scope = { projectId: ctx.projectId };
  const [spores, total] = await Promise.all([listSpores(env.db, scope, options), countSpores(env.db, scope, options)]);
  return Response.json({ persisted: true, held: true, spores: spores.map(preview), total });
}

/** One spore in full, with what supersedes it and what it grew out of. */
export async function handleRunSpore(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  const id = str(body.id);
  if (runId === null || id === null) return Response.json(refused(ctx, refusal('a spore read requires runId and id', 'parse')));
  const run = await heldRun(env, ctx, runId, SPORE_READ_TASKS);
  if (run === null) return Response.json(UNHELD);

  if ((await spendFullRead(env, ctx, run)) > SPORE_FULL_READ_BUDGET) {
    return Response.json({ persisted: true, held: true, spore: null, budget: 'spent' });
  }

  const scope = { projectId: ctx.projectId };
  const spore = await getSpore(env.db, scope, id);
  if (spore === null) return Response.json({ persisted: true, held: true, spore: null, supersededBy: [], supersedes: [] });
  const [supersededBy, supersedes] = await Promise.all([
    listSupersedingSporeIds(env.db, scope, id),
    listSupersededSporeIds(env.db, scope, id),
  ]);
  // A digest run's reads spend against the same tier window its pages are cut
  // from, so its bodies are the window's share rather than the sweep's own.
  const bodyChars = run.task === DIGEST_TASK ? DIGEST_FULL_READ_BODY_CHARS : SPORE_BODY_CHARS;
  const truncated = spore.content.length > bodyChars;
  return Response.json({
    persisted: true, held: true,
    spore: truncated ? { ...spore, content: spore.content.slice(0, bodyChars) } : spore,
    truncated, supersededBy, supersedes,
  });
}

/**
 * Record one spore for the run. Its agent is the run's own and its session is
 * the one the dispatch named, bound to that session's latest prompt; a run
 * naming no session records a spore bound to neither.
 */
export async function handleRunSporeCreate(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  const observationType = str(body.observation_type);
  const content = str(body.content, MAX_SPORE_CONTENT_BYTES);
  const context = orNull(body.context, MAX_SPORE_CONTENT_BYTES);
  const properties = orNull(body.properties, MAX_SPORE_CONTENT_BYTES);
  if (runId === null || observationType === null || content === null || context === undefined || properties === undefined) {
    return Response.json(refused(ctx, refusal('a spore requires runId, observation_type and content', 'parse')));
  }
  const run = await heldRun(env, ctx, runId, SPORE_TOOL_TASKS);
  if (run === null) return Response.json(UNHELD);
  if (overSporeCap(content)) return Response.json(refused(ctx, refusal(SPORE_CAP_REASON, 'parse')));

  const scope = { projectId: ctx.projectId };
  const sessionId = sessionNamedByRun(run);
  const promptId = sessionId === null ? null : await latestPromptId(env.db, scope, sessionId);
  const spore = await insertSpore(env.db, scope, {
    id: mintSporeId(observationType), agentId: run.agentId, sessionId, promptId, observationType,
    content, context, importance: importanceOf(body.importance), filePath: null,
    tags: sporeTags(body.tags), contentHash: null, properties, createdAt: ctx.now,
  });
  return Response.json({ persisted: true, held: true, spore });
}

/**
 * Move one spore the run has judged: superseded by a named successor,
 * consolidated into a wisdom spore the run recorded first, or obsolete with
 * what changed. `resolved: false` means nothing moved, which a caller must not
 * read as a resolution it made.
 */
export async function handleRunSporeResolve(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  const action = (RESOLUTION_ACTIONS as readonly string[]).includes(body.action as string) ? body.action as ResolutionAction : null;
  if (runId === null || action === null) {
    return Response.json(refused(ctx, refusal(`a resolution requires runId and one of ${RESOLUTION_ACTIONS.join(', ')}`, 'parse')));
  }
  const run = await heldRun(env, ctx, runId, SPORE_TOOL_TASKS);
  if (run === null) return Response.json(UNHELD);

  const scope = { projectId: ctx.projectId };
  const planned = await planSporeResolution(env.db, scope, {
    action,
    sporeId: optional(body.spore_id),
    newSporeId: optional(body.new_spore_id),
    reason: optional(body.reason, MAX_SPORE_CONTENT_BYTES),
  });
  if (!planned.ok) return Response.json(refused(ctx, refusal(planned.reason, 'parse')));

  const plan = planned.plan;
  const sessionId = sessionNamedByRun(run);
  const resolved = await resolveSpore(env.db, scope, plan.status, {
    id: crypto.randomUUID(), agentId: run.agentId, sporeId: plan.sporeId, action: plan.action,
    newSporeId: plan.newSporeId, reason: plan.reason, sessionId, createdAt: ctx.now,
  }, ctx.now);
  return Response.json({ persisted: true, held: true, resolved, action: plan.action, spore: plan.sporeId });
}
