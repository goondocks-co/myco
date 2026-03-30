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
import { epochSeconds, DEFAULT_LIST_LIMIT } from '@myco/constants.js';
import {
  listCandidatesWithCount,
  getCandidate,
  updateCandidate,
} from '@myco/db/queries/skill-candidates.js';
import {
  listSkillRecordsWithCount,
  getSkillRecord,
  getSkillRecordByName,
} from '@myco/db/queries/skill-records.js';
import { listLineageForSkill } from '@myco/db/queries/skill-lineage.js';
import { countUsageForSkill } from '@myco/db/queries/skill-usage.js';
import { getDatabase } from '@myco/db/client.js';

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
 * Query params: status, limit, offset
 */
export async function handleListCandidates(req: RouteRequest): Promise<RouteResponse> {
  const status = req.query.status || undefined;
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIST_LIMIT;
  const offset = req.query.offset ? Number(req.query.offset) : DEFAULT_LIST_OFFSET;

  const { items: candidates, total } = listCandidatesWithCount({ status, limit, offset });

  return { status: 200, body: { candidates, total } };
}

/**
 * Get a single skill candidate by id.
 *
 * Returns 404 if not found.
 */
export async function handleGetCandidate(req: RouteRequest): Promise<RouteResponse> {
  const candidate = getCandidate(req.params.id);
  if (!candidate) {
    return { status: 404, body: { error: `Not found: ${req.params.id}` } };
  }
  return { status: 200, body: { candidate } };
}

/**
 * Update a skill candidate's fields (typically used to advance its status).
 *
 * Automatically sets updated_at to the current epoch seconds.
 * Returns 400 if no body, 404 if candidate not found.
 */
export async function handleUpdateCandidate(req: RouteRequest): Promise<RouteResponse> {
  const id = req.params.id;
  const body = req.body as Record<string, unknown> | undefined;
  if (!body) return { status: 400, body: { error: 'Request body required' } };

  const updated = updateCandidate(id, {
    ...body,
    updated_at: epochSeconds(),
  } as Parameters<typeof updateCandidate>[1]);

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

  const { items: records, total } = listSkillRecordsWithCount({ status, limit, offset });

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

  const record = getSkillRecord(idOrName) ?? getSkillRecordByName(idOrName);

  if (!record) {
    return { status: 404, body: { error: `Not found: ${idOrName}` } };
  }

  const lineage = listLineageForSkill(record.id);
  const usage_total = countUsageForSkill(record.id);

  return { status: 200, body: { ...record, lineage, usage_total } };
}

/**
 * Delete a skill candidate by id.
 */
export async function handleDeleteCandidate(req: RouteRequest): Promise<RouteResponse> {
  const id = req.params.id;
  const candidate = getCandidate(id);
  if (!candidate) return { status: 404, body: { error: `Not found: ${id}` } };

  const db = getDatabase();
  db.prepare('DELETE FROM skill_candidates WHERE id = ?').run(id);

  return { status: 200, body: { deleted: true, id } };
}

/**
 * Delete a skill record by id or name, including lineage and usage data.
 */
export async function handleDeleteSkillRecord(req: RouteRequest): Promise<RouteResponse> {
  const idOrName = req.params.id;
  const record = getSkillRecord(idOrName) ?? getSkillRecordByName(idOrName);
  if (!record) return { status: 404, body: { error: `Not found: ${idOrName}` } };

  const db = getDatabase();
  db.transaction(() => {
    db.prepare('DELETE FROM skill_lineage WHERE skill_id = ?').run(record.id);
    db.prepare('DELETE FROM skill_usage WHERE skill_id = ?').run(record.id);
    // Reset any linked candidate — dismiss it so it doesn't regenerate
    if (record.candidate_id) {
      db.prepare(
        `UPDATE skill_candidates SET status = 'dismissed', skill_id = NULL, updated_at = ? WHERE id = ?`,
      ).run(epochSeconds(), record.candidate_id);
    }
    // Also catch candidates linked via skill_id (may differ from candidate_id)
    db.prepare(
      `UPDATE skill_candidates SET status = 'dismissed', skill_id = NULL, updated_at = ? WHERE skill_id = ?`,
    ).run(epochSeconds(), record.id);
    db.prepare('DELETE FROM skill_records WHERE id = ?').run(record.id);
  })();

  return { status: 200, body: { deleted: true, id: record.id, name: record.name } };
}
