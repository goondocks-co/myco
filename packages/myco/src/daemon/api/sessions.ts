import { getSession, listSessions, countSessions, deleteSessionCascade, getSessionImpact, updateSession } from '@myco/db/queries/sessions.js';
import { listBatchesBySession, countBatchesBySession, countBatchesBySessions, getBatchById, PROMPT_BATCH_ORIGIN, type PromptBatchOrigin } from '@myco/db/queries/batches.js';
import { listActivitiesByBatch, countActivities, countActivitiesBySessions } from '@myco/db/queries/activities.js';
import { listAttachmentsBySession } from '@myco/db/queries/attachments.js';
import { deletePlan, getPlan, listPlansBySession } from '@myco/db/queries/plans.js';
import { getSessionActivityBuckets } from '@myco/db/queries/activity-buckets.js';
import { getTeamMachineId } from '@myco/team/context.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { epochSeconds } from '@myco/constants.js';
import { cleanupAfterSessionCascade } from '../jobs/session-cleanup.js';
import { triggerTitleSummary } from '../trigger-title-summary.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { DaemonLogger } from '../logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { projectScopeFromRequestContext } from '@myco/grove/request-context.js';
import {
  releaseStateAnnotation,
  releaseStateAnnotationMap,
  releaseStateField,
} from '@myco/release-provenance/annotations.js';
import { fetchTeamFallback, type TeamFallbackDeps } from './team-fallback.js';
import { errorBody } from './error-envelope.js';

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_LIST_OFFSET = 0;

export async function handleListSessions(req: RouteRequest): Promise<RouteResponse> {
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIST_LIMIT;
  const offset = req.query.offset ? Number(req.query.offset) : DEFAULT_LIST_OFFSET;
  const status = req.query.status || undefined;
  const agent = req.query.agent || undefined;
  const search = req.query.search || undefined;
  const hasPlan = req.query.has_plan === 'true' ? true : undefined;
  const scope = projectScopeFromRequestContext(req.requestContext);

  const filterOpts = { scope, status, agent, search, hasPlan };

  const rawSessions = listSessions({ ...filterOpts, limit, offset });
  const ids = rawSessions.map((s) => s.id);
  const states = releaseStateAnnotationMap('sessions', ids, scope);
  const activityBuckets = getSessionActivityBuckets(ids, {
    ranges: rawSessions.map((s) => ({
      id: s.id,
      started_at: s.started_at,
      ended_at: s.ended_at,
    })),
  });
  // Derived counts from a single GROUP BY each — the cached
  // `sessions.prompt_count` / `tool_count` columns can drift if a writer
  // missed the bump, and the detail endpoint already derives, so the
  // list endpoint matches.
  const promptCounts = countBatchesBySessions(ids);
  const toolCounts = countActivitiesBySessions(ids);
  const sessions = rawSessions.map((s) => ({
    id: s.id,
    date: new Date(s.started_at * 1000).toISOString().slice(0, 10),
    title: s.title || s.id.slice(0, 8),
    status: s.status,
    agent: s.agent,
    prompt_count: promptCounts.get(s.id) ?? 0,
    tool_count: toolCounts.get(s.id) ?? 0,
    started_at: s.started_at,
    ended_at: s.ended_at,
    branch: s.branch,
    activity_buckets: activityBuckets.get(s.id) ?? [],
    ...releaseStateField(states.get(s.id)),
  }));
  const total = countSessions(filterOpts);

  return { body: { sessions, total, offset, limit } };
}

/**
 * Factory form — supports team fallback when the record is missing locally.
 *
 * On a team hit we leave `prompt_count`/`tool_count` null because the
 * derived-count queries only run against local SQLite.
 */
export function createGetSessionHandler(deps: TeamFallbackDeps = {}) {
  return async function handleGetSession(req: RouteRequest): Promise<RouteResponse> {
    const scope = projectScopeFromRequestContext(req.requestContext);
    const session = getSession(req.params.id, scope);
    if (session) {
      // Derive counts from rows, not the cached prompt_count/tool_count.
      const promptCount = countBatchesBySession(session.id);
      const toolCount = countActivities(session.id);
      return {
        body: {
          ...session,
          prompt_count: promptCount,
          tool_count: toolCount,
          ...releaseStateField(releaseStateAnnotation('sessions', session.id, scope)),
          source: 'local',
        },
      };
    }

    const fallback = await fetchTeamFallback(deps, 'sessions', req.params.id);
    if (fallback) {
      return {
        body: {
          ...fallback.record,
          prompt_count: null,
          tool_count: null,
          source: fallback.source,
        },
      };
    }

    return { status: 404, body: { error: 'not_found' } };
  };
}

/** Back-compat: no-team-fallback handler for existing call sites. */
export const handleGetSession = createGetSessionHandler();

/**
 * Parse a comma-separated `origins` query parameter into a typed origin list.
 * Returns undefined when the param is omitted (callers default to "all
 * origins" — preserves legacy behavior). Unknown values are silently
 * dropped so a misbehaving client can't break the query.
 */
function parseOriginsQuery(raw: unknown): readonly PromptBatchOrigin[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const known = new Set<string>(Object.values(PROMPT_BATCH_ORIGIN));
  const parsed = raw.split(',').map((s) => s.trim()).filter((s) => known.has(s)) as PromptBatchOrigin[];
  return parsed.length > 0 ? parsed : undefined;
}

export async function handleGetSessionBatches(req: RouteRequest): Promise<RouteResponse> {
  const scope = projectScopeFromRequestContext(req.requestContext);
  if (!getSession(req.params.id, scope)) return { status: 404, body: { error: 'not_found' } };
  const origins = parseOriginsQuery(req.query.origins);
  const rawBatches = listBatchesBySession(req.params.id, { scope, origins });
  const states = releaseStateAnnotationMap('prompt_batches', rawBatches.map((b) => String(b.id)), scope);
  const batches = rawBatches.map((b) => ({ ...b, ...releaseStateField(states.get(String(b.id))) }));
  return { body: batches };
}

export async function handleGetBatchActivities(req: RouteRequest): Promise<RouteResponse> {
  const batchId = Number(req.params.id);
  if (isNaN(batchId)) return { status: 400, body: { error: 'invalid_batch_id' } };
  const scope = projectScopeFromRequestContext(req.requestContext);
  if (!getBatchById(batchId, scope)) return { status: 404, body: { error: 'not_found' } };
  const activities = listActivitiesByBatch(batchId, { scope });
  return { body: activities };
}

export async function handleGetSessionAttachments(req: RouteRequest): Promise<RouteResponse> {
  const scope = projectScopeFromRequestContext(req.requestContext);
  if (!getSession(req.params.id, scope)) return { status: 404, body: { error: 'not_found' } };
  const attachments = listAttachmentsBySession(req.params.id);
  return { body: attachments };
}

export async function handleGetSessionPlans(req: RouteRequest): Promise<RouteResponse> {
  const scope = projectScopeFromRequestContext(req.requestContext);
  if (!getSession(req.params.id, scope)) return { status: 404, body: { error: 'not_found' } };
  const rawPlans = listPlansBySession(req.params.id, scope);
  const states = releaseStateAnnotationMap('plans', rawPlans.map((p) => p.id), scope);
  const plans = rawPlans.map((p) => ({ ...p, ...releaseStateField(states.get(p.id)) }));
  return { body: { plans } };
}

// ---------------------------------------------------------------------------
// Session mutation factory (requires injected deps)
// ---------------------------------------------------------------------------

export interface SessionMutationDeps {
  embeddingManager: EmbeddingManager;
  vaultDir: string;
  logger: DaemonLogger;
  liveConfig: { current: MycoConfig };
  /** Cleared on DELETE so a re-created session with the same id is not
   *  short-circuited by the per-lifetime reconciliation cache. Mirrors
   *  the unregister path in session-lifecycle.ts. */
  reconciler: { clearSession(sessionId: string): void };
  /** Cleared on DELETE so the next event for a deleted session's id
   *  re-takes the auto-register-and-reconcile branch in
   *  `event-dispatch.ts` (gated on `registry.getSession`). Without
   *  this, a stale registry entry from the deleted session causes the
   *  dispatcher to skip reconcile entirely, the defensive
   *  `ensureSessionRowExists` materializes an empty row, and the
   *  buffered prompts are orphaned forever. */
  registry: { unregister(sessionId: string): void };
}

export function createSessionMutationHandlers(deps: SessionMutationDeps) {
  const { embeddingManager, vaultDir, logger, liveConfig, reconciler, registry } = deps;

  /** DELETE /api/sessions/:id — cascade delete with post-transaction cleanup. */
  async function handleDeleteSession(req: RouteRequest): Promise<RouteResponse> {
    const sessionId = req.params.id;
    const scope = projectScopeFromRequestContext(req.requestContext);
    if (!getSession(sessionId, scope)) return { status: 404, body: { error: 'Session not found' } };
    const result = deleteSessionCascade(sessionId);
    if (!result.deleted) return { status: 404, body: { error: 'Session not found' } };

    // Clear the per-lifetime reconciliation cache so a re-registration
    // with the same session id replays its buffer cleanly.
    reconciler.clearSession(sessionId);

    // Clear the in-memory registry entry. The event-dispatch fast path
    // (`if (!registry.getSession(event.session_id))`) gates the whole
    // auto-register-and-reconcile branch on registry membership; a
    // stale entry leftover from the just-deleted session caused the
    // next event to skip reconcile entirely and orphan its buffer.
    // Mirror the unregister sequence in `session-lifecycle.ts`.
    registry.unregister(sessionId);

    // Fire-and-forget cleanup: embeddings, vault files, attachments,
    // and the session's buffer journal.
    cleanupAfterSessionCascade(sessionId, result, embeddingManager, vaultDir).catch(() => {});

    logger.info(LOG_KINDS.API_SESSION_DELETE, 'Session cascade deleted', {
      session_id: sessionId,
      counts: result.counts,
    });
    return { body: { ok: true, counts: result.counts } };
  }

  /**
   * POST /api/sessions/:id/complete — manual mirror of the SessionEnd hook.
   *
   * Flips the session to `status = 'completed'` (if not already) and fires
   * the title-summary task so the summary regenerates against the full arc.
   * Kept deliberately forgiving: completing an already-completed session is
   * idempotent — it re-triggers the regenerate without rewriting status.
   *
   * Exists because the SessionEnd hook isn't reliably fired by every
   * symbiont, and because users sometimes know a session is done before
   * any timer-based stale-sweep would catch it.
   */
  async function handleCompleteSession(req: RouteRequest): Promise<RouteResponse> {
    const sessionId = req.params.id;
    const scope = projectScopeFromRequestContext(req.requestContext);
    const session = getSession(sessionId, scope);
    if (!session) return { status: 404, body: { error: 'Session not found' } };

    const wasActive = session.status === 'active';
    if (wasActive) {
      updateSession(sessionId, {
        status: 'completed',
        ended_at: session.ended_at ?? epochSeconds(),
      }, scope);
    }

    await triggerTitleSummary(sessionId, { vaultDir, embeddingManager, liveConfig, logger });

    logger.info(LOG_KINDS.API_SESSION_COMPLETE, 'Session manually completed', {
      session_id: sessionId,
      was_active: wasActive,
    });

    return { body: { ok: true, was_active: wasActive } };
  }

  /** GET /api/sessions/:id/impact — get session impact data. */
  async function handleGetSessionImpact(req: RouteRequest): Promise<RouteResponse> {
    const sessionId = req.params.id;
    const scope = projectScopeFromRequestContext(req.requestContext);
    const session = getSession(sessionId, scope);
    if (!session) return { status: 404, body: { error: 'Session not found' } };
    const impact = getSessionImpact(sessionId);
    return { body: impact };
  }

  /** DELETE /api/plans/:id — remove a captured plan and its vector.
   *
   *  Ownership check: deleting a plan that belongs to another machine
   *  propagates a tombstone across the team. Require an explicit
   *  `{force_remote: true}` opt-in before deleting someone else's row. */
  async function handleDeletePlan(req: RouteRequest): Promise<RouteResponse> {
    const scope = projectScopeFromRequestContext(req.requestContext);
    const existing = getPlan(req.params.id, scope);
    if (!existing) return { status: 404, body: errorBody('plan-not-found', 'Plan not found') };

    const localMachineId = getTeamMachineId();
    const body = req.body as { force_remote?: boolean } | undefined;
    const forceRemote = body?.force_remote === true;
    if (existing.machine_id !== localMachineId && !forceRemote) {
      logger.warn(LOG_KINDS.API_SESSION_DELETE, 'Cross-machine plan delete rejected', {
        plan_id: existing.id,
        plan_machine_id: existing.machine_id,
        local_machine_id: localMachineId,
      });
      return {
        status: 403,
        body: errorBody(
          'cross-machine-delete',
          'Plan belongs to another machine; pass {"force_remote": true} to delete.',
        ),
      };
    }
    if (existing.machine_id !== localMachineId && forceRemote) {
      logger.warn(LOG_KINDS.API_SESSION_DELETE, 'Cross-machine plan delete allowed by force_remote', {
        plan_id: existing.id,
        plan_machine_id: existing.machine_id,
        local_machine_id: localMachineId,
      });
    }

    const deleted = deletePlan(req.params.id, scope);
    if (!deleted) return { status: 404, body: errorBody('plan-not-found', 'Plan not found') };

    embeddingManager.onRemoved('plans', deleted.id);

    logger.info(LOG_KINDS.API_SESSION_DELETE, 'Plan deleted', {
      plan_id: deleted.id,
      session_id: deleted.session_id,
      logical_key: deleted.logical_key,
    });

    return {
      body: {
        ok: true,
        id: deleted.id,
        session_id: deleted.session_id,
      },
    };
  }

  return { handleDeleteSession, handleCompleteSession, handleGetSessionImpact, handleDeletePlan };
}
