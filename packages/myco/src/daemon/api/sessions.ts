import { getSession, listSessions, countSessions, deleteSessionCascade, getSessionImpact, updateSession } from '@myco/db/queries/sessions.js';
import { listBatchesBySession, countBatchesBySession } from '@myco/db/queries/batches.js';
import { listActivitiesByBatch, countActivities } from '@myco/db/queries/activities.js';
import { listAttachmentsBySession } from '@myco/db/queries/attachments.js';
import { deletePlan, getPlan, listPlansBySession } from '@myco/db/queries/plans.js';
import { getTeamMachineId } from '@myco/daemon/team-context.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { epochSeconds, TEAM_SOURCE_PREFIX } from '@myco/constants.js';
import { cleanupAfterSessionCascade } from '../jobs/session-cleanup.js';
import { triggerTitleSummary } from '../trigger-title-summary.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { DaemonLogger } from '../logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { TeamSyncClient } from '../team-sync.js';
import { errorBody } from './error-envelope.js';

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_LIST_OFFSET = 0;

export async function handleListSessions(req: RouteRequest): Promise<RouteResponse> {
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIST_LIMIT;
  const offset = req.query.offset ? Number(req.query.offset) : DEFAULT_LIST_OFFSET;
  const status = req.query.status || undefined;
  const agent = req.query.agent || undefined;
  const search = req.query.search || undefined;

  const filterOpts = { status, agent, search };

  const sessions = listSessions({ ...filterOpts, limit, offset }).map((s) => ({
    id: s.id,
    date: new Date(s.started_at * 1000).toISOString().slice(0, 10),
    title: s.title || s.id.slice(0, 8),
    status: s.status,
    agent: s.agent,
    prompt_count: s.prompt_count,
    tool_count: s.tool_count,
    started_at: s.started_at,
    ended_at: s.ended_at,
  }));
  const total = countSessions(filterOpts);

  return { body: { sessions, total, offset, limit } };
}

/** Dependencies for the session get-by-id fallback fanout. */
export interface GetSessionDeps {
  getTeamClient?: () => TeamSyncClient | null;
  machineId?: string;
}

/**
 * Factory form — supports team fallback when the record is missing locally.
 *
 * Mirrors the `createSearchHandler` pattern in `./search.ts`: on a local miss
 * we fan out to the connected team's D1 copy, filter out results claimed by
 * our own machine (to avoid self-echo), and tag the response `source`.
 *
 * Returns the same shape as the local-only path on a hit. On a team hit we
 * leave `prompt_count`/`tool_count` `null` because the derived-count queries
 * run against the local SQLite — consumers (UI, MCP) already tolerate nulls.
 */
export function createGetSessionHandler(deps: GetSessionDeps = {}) {
  return async function handleGetSession(req: RouteRequest): Promise<RouteResponse> {
    const session = getSession(req.params.id);
    if (session) {
      // Derive counts from actual rows — the database is the authority,
      // not the cached prompt_count/tool_count on the sessions row.
      const promptCount = countBatchesBySession(session.id);
      const toolCount = countActivities(session.id);
      return {
        body: {
          ...session,
          prompt_count: promptCount,
          tool_count: toolCount,
          source: 'local',
        },
      };
    }

    const teamClient = deps.getTeamClient?.();
    if (teamClient) {
      // Defense in depth: TeamClient.getRecord already swallows errors and
      // returns null, but in-test mocks sometimes bypass that wrapper. Keep
      // recall resilient — team failures must never block local 404s.
      let record: Record<string, unknown> | null = null;
      try {
        record = await teamClient.getRecord('sessions', req.params.id);
      } catch {
        record = null;
      }
      if (record) {
        const recordMachineId = typeof record.machine_id === 'string' ? record.machine_id : null;
        // Skip self-echo: the team copy originally came from us.
        if (!(deps.machineId && recordMachineId === deps.machineId)) {
          return {
            body: {
              ...record,
              prompt_count: null,
              tool_count: null,
              source: recordMachineId ? `${TEAM_SOURCE_PREFIX}${recordMachineId}` : 'team',
            },
          };
        }
      }
    }

    return { status: 404, body: { error: 'not_found' } };
  };
}

/**
 * Back-compat: simple function export with no team fanout. Kept so the
 * handful of tests and internal call sites that import the bare handler
 * keep working. New code should use `createGetSessionHandler(deps)`.
 */
export const handleGetSession = createGetSessionHandler();

export async function handleGetSessionBatches(req: RouteRequest): Promise<RouteResponse> {
  const batches = listBatchesBySession(req.params.id);
  return { body: batches };
}

export async function handleGetBatchActivities(req: RouteRequest): Promise<RouteResponse> {
  const batchId = Number(req.params.id);
  if (isNaN(batchId)) return { status: 400, body: { error: 'invalid_batch_id' } };
  const activities = listActivitiesByBatch(batchId);
  return { body: activities };
}

export async function handleGetSessionAttachments(req: RouteRequest): Promise<RouteResponse> {
  const attachments = listAttachmentsBySession(req.params.id);
  return { body: attachments };
}

export async function handleGetSessionPlans(req: RouteRequest): Promise<RouteResponse> {
  const plans = listPlansBySession(req.params.id);
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
}

export function createSessionMutationHandlers(deps: SessionMutationDeps) {
  const { embeddingManager, vaultDir, logger, liveConfig } = deps;

  /** DELETE /api/sessions/:id — cascade delete with post-transaction cleanup. */
  async function handleDeleteSession(req: RouteRequest): Promise<RouteResponse> {
    const sessionId = req.params.id;
    const result = deleteSessionCascade(sessionId);
    if (!result.deleted) return { status: 404, body: { error: 'Session not found' } };

    // Post-transaction cleanup (fire-and-forget)
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
    const session = getSession(sessionId);
    if (!session) return { status: 404, body: { error: 'Session not found' } };

    const wasActive = session.status === 'active';
    if (wasActive) {
      updateSession(sessionId, {
        status: 'completed',
        ended_at: session.ended_at ?? epochSeconds(),
      });
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
    const session = getSession(sessionId);
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
    const existing = getPlan(req.params.id);
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

    const deleted = deletePlan(req.params.id);
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
