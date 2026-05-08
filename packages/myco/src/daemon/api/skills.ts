/**
 * API route handlers for skill lifecycle endpoints.
 *
 * Provides read access to skill candidates and skill records, plus status
 * updates for candidates (the primary lifecycle transition surface).
 *
 * Route overview:
 *   GET /api/skill-candidates        — list candidates (filterable by status)
 *   GET /api/skill-candidates/:id    — get a single candidate
 *   PUT /api/skill-candidates/:id    — update candidate fields (status, etc.)
 *   GET /api/skill-records           — list promoted skills
 *   GET /api/skill-records/:id       — get a single skill record with lineage + usage
 */

import type { RouteRequest, RouteResponse } from '../router.js';
import type { DaemonLogger } from '../logger.js';
import { epochSeconds, DEFAULT_LIST_LIMIT } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import {
  listCandidatesWithCount,
  getCandidate,
  updateCandidate,
  deleteCandidate,
} from '@myco/db/queries/skill-candidates.js';
import {
  listSkillRecordsWithCount,
  getSkillRecord,
  getSkillRecordByName,
  deleteSkillRecordCascade,
} from '@myco/db/queries/skill-records.js';
import { listLineageForSkill } from '@myco/db/queries/skill-lineage.js';
import { countUsageForSkill } from '@myco/db/queries/skill-usage.js';
import { enqueueOutbox } from '@myco/db/queries/team-outbox.js';
import { isTeamSyncEnabled, getTeamMachineId } from '@myco/daemon/team-context.js';
import { REST_SETTABLE_STATUSES } from '@myco/constants/skill-candidate-status.js';
import { parseCsvList } from '@myco/utils/parse-csv-list.js';
import { projectScopeFromRequestContext } from '@myco/tools/request-context.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIST_OFFSET = 0;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * List skill candidates with optional status filter and pagination.
 *
 * Query params:
 *   - status: exact match, or a comma-separated list for multi-status
 *     filtering (e.g. `status=approved,generated`)
 *   - limit, offset: standard pagination
 */
export async function handleListCandidates(req: RouteRequest): Promise<RouteResponse> {
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIST_LIMIT;
  const offset = req.query.offset ? Number(req.query.offset) : DEFAULT_LIST_OFFSET;
  const scope = projectScopeFromRequestContext(req.requestContext);

  const { items: candidates, total } = listCandidatesWithCount({
    scope,
    statuses: parseCsvList(req.query.status),
    limit,
    offset,
  });

  return { status: 200, body: { candidates, total } };
}

/**
 * Get a single skill candidate by id.
 *
 * Returns 404 if not found.
 */
export async function handleGetCandidate(req: RouteRequest): Promise<RouteResponse> {
  const scope = projectScopeFromRequestContext(req.requestContext);
  const candidate = getCandidate(req.params.id, scope);
  if (!candidate) {
    return { status: 404, body: { error: `Not found: ${req.params.id}` } };
  }
  return { status: 200, body: { candidate } };
}

/**
 * Status values REST callers (UI + MCP) are allowed to set.
 * 'generated' is internal — only vault_finalize_skill sets it, and that
 * path calls updateCandidate directly rather than going through REST.
 */
const ALLOWED_REST_STATUSES = new Set<string>(REST_SETTABLE_STATUSES);

/**
 * Update a skill candidate's fields (typically used to advance its status).
 *
 * Automatically sets updated_at to the current epoch seconds.
 * Returns 400 if no body or if the status value is not in ALLOWED_REST_STATUSES,
 * 404 if candidate not found.
 */
export async function handleUpdateCandidate(req: RouteRequest): Promise<RouteResponse> {
  const id = req.params.id;
  const body = req.body as Record<string, unknown> | undefined;
  const scope = projectScopeFromRequestContext(req.requestContext);
  if (!body) return { status: 400, body: { error: 'Request body required' } };

  // Pick only allowed mutable fields — reject arbitrary body fields
  const { status, topic, rationale, confidence, source_ids, skill_id } = body as Record<string, unknown>;

  // Status whitelist guard — defense in depth against a compromised or
  // misconfigured MCP client reaching this endpoint with an internal
  // status. The agent-facing vault_skill_candidates tool also narrows
  // its Zod enum to the same set.
  if (status !== undefined) {
    if (typeof status !== 'string' || !ALLOWED_REST_STATUSES.has(status)) {
      return {
        status: 400,
        body: {
          error:
            `Invalid status '${String(status)}'. REST callers may only set: ` +
            `${[...ALLOWED_REST_STATUSES].join(', ')}. The 'generated' status ` +
            "is set internally by vault_finalize_skill after validation.",
        },
      };
    }
  }

  const updated = updateCandidate(id, {
    ...(status !== undefined ? { status: status as string } : {}),
    ...(topic !== undefined ? { topic: topic as string } : {}),
    ...(rationale !== undefined ? { rationale: rationale as string } : {}),
    ...(confidence !== undefined ? { confidence: confidence as number } : {}),
    ...(source_ids !== undefined ? { source_ids: source_ids as string } : {}),
    ...(skill_id !== undefined ? { skill_id: skill_id as string | null } : {}),
    updated_at: epochSeconds(),
  }, scope);

  if (!updated) return { status: 404, body: { error: `Candidate not found: ${id}` } };
  return { status: 200, body: { candidate: updated } };
}

/**
 * List skill records with optional status filter and pagination.
 *
 * Query params: status, limit, offset
 */
export async function handleListSkillRecords(req: RouteRequest): Promise<RouteResponse> {
  const status = req.query.status || undefined;
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIST_LIMIT;
  const offset = req.query.offset ? Number(req.query.offset) : DEFAULT_LIST_OFFSET;
  const scope = projectScopeFromRequestContext(req.requestContext);

  const { items: records, total } = listSkillRecordsWithCount({ scope, status, limit, offset });

  return { status: 200, body: { records, total } };
}

/**
 * Get a single skill record by id or name, including its lineage history and
 * total usage count.
 *
 * Tries id first, then falls back to name lookup. Returns 404 if not found.
 */
export async function handleGetSkillRecord(req: RouteRequest): Promise<RouteResponse> {
  const idOrName = req.params.id;
  const scope = projectScopeFromRequestContext(req.requestContext);

  const record = getSkillRecord(idOrName, scope) ?? getSkillRecordByName(idOrName, scope);

  if (!record) {
    return { status: 404, body: { error: `Not found: ${idOrName}` } };
  }

  const lineage = listLineageForSkill(record.id, scope, 50);
  const usage_total = countUsageForSkill(record.id);

  // Parse frontmatter from latest lineage snapshot so the UI avoids client-side regex
  const latestSnapshot = lineage[0]?.content_snapshot;
  const frontmatterFields: Record<string, string> = {};
  if (latestSnapshot) {
    const fmMatch = latestSnapshot.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      for (const line of fmMatch[1].split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trim();
          if (key && val) frontmatterFields[key] = val;
        }
      }
    }
  }

  return { status: 200, body: { ...record, lineage, usage_total, frontmatter: frontmatterFields } };
}

/**
 * Delete a skill candidate by id.
 */
export async function handleDeleteCandidate(req: RouteRequest): Promise<RouteResponse> {
  const id = req.params.id;
  const scope = projectScopeFromRequestContext(req.requestContext);
  const deleted = deleteCandidate(id, scope);
  if (!deleted) return { status: 404, body: { error: `Not found: ${id}` } };

  return { status: 200, body: { deleted: true, id } };
}

/**
 * Delete a skill record by id or name, including lineage and usage data.
 */
export async function handleDeleteSkillRecord(req: RouteRequest): Promise<RouteResponse> {
  const idOrName = req.params.id;
  const scope = projectScopeFromRequestContext(req.requestContext);
  const result = deleteSkillRecordCascade(idOrName, scope);
  if (!result) return { status: 404, body: { error: `Not found: ${idOrName}` } };

  // Sync deletion to team outbox (best-effort)
  if (isTeamSyncEnabled()) {
    try {
      enqueueOutbox({
        table_name: 'skill_records',
        row_id: result.id,
        operation: 'delete',
        payload: JSON.stringify({ id: result.id, project_id: result.project_id, name: result.name }),
        machine_id: getTeamMachineId(),
        created_at: epochSeconds(),
      });
    } catch (err) {
      // Best-effort sync — log for diagnosability
      console.warn('[team-sync] Failed to enqueue skill record deletion:', err instanceof Error ? err.message : err);
    }
  }

  return { status: 200, body: { deleted: true, id: result.id, name: result.name } };
}

// ---------------------------------------------------------------------------
// Skill record delete with disk cleanup — factory
// ---------------------------------------------------------------------------

export interface SkillDeleteDeps {
  vaultDir: string;
  logger: DaemonLogger;
}

/**
 * Creates a DELETE /api/skill-records/:id handler that wraps
 * `handleDeleteSkillRecord` with post-deletion file/symlink cleanup.
 */
export function createSkillRecordDeleteHandler(deps: SkillDeleteDeps) {
  const { vaultDir, logger } = deps;

  return async function handleDeleteSkillRecordWithCleanup(req: RouteRequest): Promise<RouteResponse> {
    const result = await handleDeleteSkillRecord(req);
    // Delete skill file and symlinks from disk if the DB delete succeeded
    if ((result.body as Record<string, unknown>)?.deleted) {
      const record = result.body as { name?: string };
      if (record.name) {
        const projectRoot = resolveProjectRoot(vaultDir);
        const skillDir = path.resolve(projectRoot, '.agents', 'skills', record.name);
        try { fs.rmSync(skillDir, { recursive: true, force: true }); } catch (err) {
          logger.warn(LOG_KINDS.PROCESSOR_BATCH, 'Failed to remove skill directory', { name: record.name, error: String(err) });
        }
        // Remove agent-specific symlinks (e.g., .claude/skills/<name>)
        try {
          const { syncSkillSymlinks } = await import('@myco/symbionts/installer.js');
          syncSkillSymlinks(projectRoot, record.name, { remove: true });
        } catch (err) {
          logger.warn(LOG_KINDS.PROCESSOR_BATCH, 'Failed to remove skill symlinks', { name: record.name, error: String(err) });
        }
      }
    }
    return result;
  };
}
