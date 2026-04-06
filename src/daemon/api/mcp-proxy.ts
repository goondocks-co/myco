/**
 * MCP proxy API handlers — routes that the MCP server proxies through the
 * daemon instead of opening its own SQLite connection.
 *
 * Factory function injects machineId and embeddingManager; returns handlers
 * for remember, supersede, plans, sessions, and team endpoints.
 */

import { z } from 'zod';
import { epochSeconds, USER_AGENT_ID, USER_AGENT_NAME } from '@myco/constants.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSpore, updateSporeStatus } from '@myco/db/queries/spores.js';
import { listPlans } from '@myco/db/queries/plans.js';
import { listSessions } from '@myco/db/queries/sessions.js';
import { listTeamMembers } from '@myco/db/queries/team-members.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPORE_ID_RANDOM_BYTES = 4;
const RESOLUTION_ID_RANDOM_BYTES = 8;

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpProxyDeps {
  machineId: string;
  embeddingManager: EmbeddingManager;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMcpProxyHandlers(deps: McpProxyDeps) {
  const { machineId, embeddingManager } = deps;

  /** POST /api/mcp/remember — create a spore and trigger embedding. */
  async function handleRemember(req: RouteRequest): Promise<RouteResponse> {
    const { content, type, tags } = RememberBody.parse(req.body);
    const { randomBytes } = await import('node:crypto');

    const observationType = type ?? 'discovery';
    const id = `${observationType}-${randomBytes(SPORE_ID_RANDOM_BYTES).toString('hex')}`;
    const now = epochSeconds();

    // Ensure the user agent exists (idempotent upsert)
    registerAgent({
      id: USER_AGENT_ID,
      name: USER_AGENT_NAME,
      created_at: now,
    });

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

    // Ensure user agent exists (idempotent)
    registerAgent({
      id: USER_AGENT_ID,
      name: USER_AGENT_NAME,
      created_at: now,
    });

    // Record resolution event for audit trail
    const { insertResolutionEvent } = await import('@myco/db/queries/resolution-events.js');
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

  /** GET /api/mcp/plans — list plans with progress calculation. */
  async function handlePlans(req: RouteRequest): Promise<RouteResponse> {
    const statusFilter = req.query.status === 'all' ? undefined : req.query.status;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    const rows = listPlans({ status: statusFilter, limit });

    const plans = rows.map((row) => {
      const content = row.content ?? '';
      const checked = (content.match(/- \[x\]/gi) ?? []).length;
      const unchecked = (content.match(/- \[ \]/g) ?? []).length;
      const total = checked + unchecked;
      const progress = total === 0 ? 'N/A' : `${checked}/${total}`;

      return {
        id: row.id,
        title: row.title,
        status: row.status,
        progress,
        tags: row.tags ? row.tags.split(',').map((t) => t.trim()) : [],
        created_at: row.created_at,
      };
    });

    return { body: { plans } };
  }

  /** GET /api/mcp/sessions — list sessions with field mapping. */
  async function handleSessions(req: RouteRequest): Promise<RouteResponse> {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const status = req.query.status;

    const rows = listSessions({ limit, status });
    const sessions = rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      user: row.user,
      branch: row.branch,
      started_at: row.started_at,
      ended_at: row.ended_at,
      status: row.status,
      title: row.title,
      summary: (row.summary ?? '').slice(0, 300),
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
    handlePlans,
    handleSessions,
    handleTeam,
  };
}
