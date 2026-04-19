/**
 * MCP proxy API handlers — routes that the MCP server proxies through the
 * daemon instead of opening its own SQLite connection.
 *
 * Factory function injects machineId and embeddingManager; returns handlers
 * for remember, supersede, consolidate, plans, sessions, and team endpoints.
 */

import { z } from 'zod';
import {
  epochSeconds,
  MCP_SESSIONS_DEFAULT_LIMIT,
  SESSION_SUMMARY_PREVIEW_CHARS,
  USER_AGENT_ID,
  USER_AGENT_NAME,
} from '@myco/constants.js';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { getLatestOpenBatch } from '@myco/db/queries/batches.js';
import { insertSpore, updateSporeStatus } from '@myco/db/queries/spores.js';
import { getPlan, listPlans, listPlansBySession } from '@myco/db/queries/plans.js';
import { getSession, listSessions } from '@myco/db/queries/sessions.js';
import { listTeamMembers } from '@myco/db/queries/team-members.js';
import { insertResolutionEvent } from '@myco/db/queries/resolution-events.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { DaemonLogger } from '../logger.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import { PLAN_STATUSES } from '@myco/vault/types.js';
import {
  buildPathPlanLogicalKey,
  buildSessionPlanLogicalKey,
  normalizePlanSourcePath,
} from '@myco/plans/identity.js';
import { persistPlan } from '../plan-capture.js';
import { errorBody } from './error-envelope.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPORE_ID_RANDOM_BYTES = 4;
const RESOLUTION_ID_RANDOM_BYTES = 8;
const MIN_CONSOLIDATE_SOURCES = 2;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RememberBody = z.object({
  content: z.string(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const SupersedeBody = z.object({
  old_spore_id: z.string(),
  new_spore_id: z.string(),
  reason: z.string().optional(),
});

/**
 * Convert an ISO-8601 string to epoch seconds.
 * Returns undefined if parsing fails (silently — callers treat undefined as "no filter").
 */
function isoToEpochSeconds(iso: string): number | undefined {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

function registerMcpUserAgent(createdAt: number): void {
  registerAgent({
    id: USER_AGENT_ID,
    name: USER_AGENT_NAME,
    created_at: createdAt,
  });
}

function toPlanProgress(content: string | null): string {
  const planContent = content ?? '';
  const checked = (planContent.match(/- \[x\]/gi) ?? []).length;
  const unchecked = (planContent.match(/- \[ \]/g) ?? []).length;
  const total = checked + unchecked;
  return total === 0 ? 'N/A' : `${checked}/${total}`;
}

function toPlanTags(tags: string | null): string[] {
  return tags ? tags.split(',').map((tag) => tag.trim()) : [];
}

const ConsolidateBody = z.object({
  source_spore_ids: z.array(z.string()).min(MIN_CONSOLIDATE_SOURCES),
  consolidated_content: z.string().min(1),
  observation_type: z.string(),
  tags: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

const SavePlanBody = z.object({
  session_id: z.string(),
  content: z.string().min(1),
  source_path: z.string().min(1).optional(),
  plan_key: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  status: z.enum(PLAN_STATUSES).optional(),
  tags: z.array(z.string()).optional(),
}).refine(
  (value) => Boolean(value.source_path) !== Boolean(value.plan_key),
  { message: 'Provide exactly one of source_path or plan_key' },
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpProxyDeps {
  machineId: string;
  embeddingManager: EmbeddingManager;
  projectRoot: string;
  logger?: DaemonLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMcpProxyHandlers(deps: McpProxyDeps) {
  const { machineId, embeddingManager, projectRoot, logger } = deps;

  function toPlanSummary(row: {
    id: string;
    title: string | null;
    status: string;
    content: string | null;
    tags: string | null;
    created_at: number;
  }) {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      progress: toPlanProgress(row.content),
      tags: toPlanTags(row.tags),
      created_at: row.created_at,
    };
  }

  /** POST /api/mcp/remember — create a spore and trigger embedding. */
  async function handleRemember(req: RouteRequest): Promise<RouteResponse> {
    const { content, type, tags } = RememberBody.parse(req.body);
    const { randomBytes } = await import('node:crypto');

    const observationType = type ?? 'discovery';
    const id = `${observationType}-${randomBytes(SPORE_ID_RANDOM_BYTES).toString('hex')}`;
    const now = epochSeconds();

    registerMcpUserAgent(now);

    const spore = insertSpore({
      id,
      agent_id: USER_AGENT_ID,
      machine_id: machineId,
      observation_type: observationType,
      content,
      tags: tags ? tags.join(', ') : null,
      created_at: now,
    });

    embeddingManager.onContentWritten('spores', spore.id, content, {
      status: 'active',
      observation_type: observationType,
      created_at: now,
    }).catch(() => {});

    return {
      body: {
        id: spore.id,
        observation_type: spore.observation_type,
        status: spore.status,
        created_at: spore.created_at,
      },
    };
  }

  /** POST /api/mcp/supersede — mark spore as superseded and record resolution event. */
  async function handleSupersede(req: RouteRequest): Promise<RouteResponse> {
    const { old_spore_id, new_spore_id, reason } = SupersedeBody.parse(req.body);
    const { randomBytes } = await import('node:crypto');
    const now = epochSeconds();

    // Update status to superseded
    updateSporeStatus(old_spore_id, 'superseded', now);
    try { embeddingManager.onStatusChanged('spores', old_spore_id, 'superseded'); } catch { /* best-effort */ }

    registerMcpUserAgent(now);

    // Record resolution event for audit trail
    const resolutionId = `res-${randomBytes(RESOLUTION_ID_RANDOM_BYTES).toString('hex')}`;

    insertResolutionEvent({
      id: resolutionId,
      agent_id: USER_AGENT_ID,
      machine_id: machineId,
      spore_id: old_spore_id,
      action: 'supersede',
      new_spore_id,
      reason: reason ?? null,
      created_at: now,
    });

    return {
      body: {
        old_spore: old_spore_id,
        new_spore: new_spore_id,
        status: 'superseded' as const,
      },
    };
  }

  /**
   * POST /api/mcp/consolidate — merge source spores into a single wisdom spore.
   *
   * Inserts a new spore with the consolidated content, then for each source:
   *   - marks its status as 'superseded'
   *   - records a resolution_events row (action='consolidate', new_spore_id=wisdom)
   *
   * Returns { new_spore_id, sources_superseded, status: 'consolidated' }.
   */
  async function handleConsolidate(req: RouteRequest): Promise<RouteResponse> {
    const { source_spore_ids, consolidated_content, observation_type, tags, reason } = ConsolidateBody.parse(req.body);
    const { randomBytes } = await import('node:crypto');
    const now = epochSeconds();
    const newSporeId = `${observation_type}-${randomBytes(SPORE_ID_RANDOM_BYTES).toString('hex')}`;
    const db = getDatabase();

    registerMcpUserAgent(now);

    const { wisdom, sourcesSuperseded } = db.transaction(() => {
      const insertedWisdom = insertSpore({
        id: newSporeId,
        agent_id: USER_AGENT_ID,
        machine_id: machineId,
        observation_type,
        content: consolidated_content,
        tags: tags ? tags.join(', ') : null,
        created_at: now,
      });

      const supersededSourceIds: string[] = [];
      for (const sourceId of source_spore_ids) {
        updateSporeStatus(sourceId, 'superseded', now);
        insertResolutionEvent({
          id: `res-${randomBytes(RESOLUTION_ID_RANDOM_BYTES).toString('hex')}`,
          agent_id: USER_AGENT_ID,
          machine_id: machineId,
          spore_id: sourceId,
          action: 'consolidate',
          new_spore_id: newSporeId,
          reason: reason ?? null,
          created_at: now,
        });
        supersededSourceIds.push(sourceId);
      }

      return { wisdom: insertedWisdom, sourcesSuperseded: supersededSourceIds };
    })();

    embeddingManager.onContentWritten('spores', wisdom.id, consolidated_content, {
      status: 'active',
      observation_type,
      created_at: now,
    }).catch(() => {});
    for (const sourceId of sourcesSuperseded) {
      try { embeddingManager.onStatusChanged('spores', sourceId, 'superseded'); } catch { /* best-effort */ }
    }

    return {
      body: {
        new_spore_id: newSporeId,
        sources_superseded: sourcesSuperseded,
        status: 'consolidated' as const,
        created_at: now,
      },
    };
  }

  /** POST /api/mcp/plans — persist a plan directly into the current session. */
  async function handleSavePlan(req: RouteRequest): Promise<RouteResponse> {
    const { session_id, content, source_path, plan_key, title, status, tags } = SavePlanBody.parse(req.body);
    const session = getSession(session_id);
    if (!session) return { status: 404, body: errorBody('session-not-found', 'Session not found') };

    const openBatch = getLatestOpenBatch(session_id);
    const normalizedSourcePath = source_path
      ? normalizePlanSourcePath(source_path, projectRoot)
      : null;
    const logicalKey = normalizedSourcePath
      ? buildPathPlanLogicalKey(normalizedSourcePath)
      : buildSessionPlanLogicalKey(session_id, plan_key!);

    const row = persistPlan({
      sessionId: session_id,
      content,
      logicalKey,
      sourcePath: normalizedSourcePath,
      promptBatchId: openBatch?.id,
      title,
      status,
      tags,
      planKey: plan_key ?? null,
      logger,
    });

    return {
      body: {
        id: row.id,
        logical_key: row.logical_key,
        title: row.title,
        status: row.status,
        source_path: row.source_path,
        session_id: row.session_id,
        prompt_batch_id: row.prompt_batch_id,
        tags: toPlanTags(row.tags),
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    };
  }

  /** GET /api/mcp/plans — list plans, or return a single plan with content when id is set.
   *
   * Supports:
   *   - id: single plan lookup (returns plan with content)
   *   - session: filter plans for a given session (mirrors /api/sessions/:id/plans)
   *   - status/limit: list filters
   *
   * `id` and `session` are mutually exclusive; passing both yields a 400.
   */
  async function handlePlans(req: RouteRequest): Promise<RouteResponse> {
    const id = typeof req.query.id === 'string' ? req.query.id : undefined;
    const session = typeof req.query.session === 'string' ? req.query.session : undefined;

    if (id && session) {
      return { status: 400, body: errorBody('mutually-exclusive-query', 'Pass either id or session, not both') };
    }

    if (id) {
      const row = getPlan(id);
      if (!row) return { body: { plans: [] } };
      return {
        body: {
          plans: [{
            ...toPlanSummary(row),
            content: row.content,
          }],
        },
      };
    }

    if (session) {
      const rows = listPlansBySession(session);
      const plans = rows.map(toPlanSummary);
      return { body: { plans } };
    }

    const statusFilter = req.query.status === 'all' ? undefined : req.query.status;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    const rows = listPlans({ status: statusFilter, limit });
    const plans = rows.map(toPlanSummary);

    return { body: { plans } };
  }

  /**
   * GET /api/mcp/sessions — list sessions with optional filters.
   *
   * Supports query params: limit, status, branch, user, since (ISO string), plan.
   * `plan` resolves to the session recorded for that plan via `getPlan().session_id`.
   */
  async function handleSessions(req: RouteRequest): Promise<RouteResponse> {
    const limit = req.query.limit ? Number(req.query.limit) : MCP_SESSIONS_DEFAULT_LIMIT;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const branch = typeof req.query.branch === 'string' ? req.query.branch : undefined;
    const user = typeof req.query.user === 'string' ? req.query.user : undefined;
    const plan = typeof req.query.plan === 'string' ? req.query.plan : undefined;
    const sinceRaw = typeof req.query.since === 'string' ? req.query.since : undefined;

    const since = sinceRaw ? isoToEpochSeconds(sinceRaw) : undefined;

    let id: string | undefined;
    if (plan) {
      const planRow = getPlan(plan);
      if (!planRow || !planRow.session_id) return { body: { sessions: [] } };
      id = planRow.session_id;
    }

    const rows = listSessions({ limit, status, branch, user, since, id });
    const sessions = rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      user: row.user,
      branch: row.branch,
      started_at: row.started_at,
      ended_at: row.ended_at,
      status: row.status,
      title: row.title,
      summary: (row.summary ?? '').slice(0, SESSION_SUMMARY_PREVIEW_CHARS),
      prompt_count: row.prompt_count,
      tool_count: row.tool_count,
      parent_session_id: row.parent_session_id,
    }));

    return { body: { sessions } };
  }

  /** GET /api/mcp/team — list team members from DB. */
  async function handleTeam(_req: RouteRequest): Promise<RouteResponse> {
    const rows = listTeamMembers();
    const members = rows.map((row) => ({
      id: row.id,
      user: row.user,
      role: row.role,
      joined: row.joined,
      tags: row.tags ? row.tags.split(',').map((t) => t.trim()) : [],
    }));

    return { body: { members } };
  }

  return {
    handleRemember,
    handleSupersede,
    handleConsolidate,
    handlePlans,
    handleSavePlan,
    handleSessions,
    handleTeam,
  };
}
