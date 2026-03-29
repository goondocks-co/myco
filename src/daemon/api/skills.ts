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
import { epochSeconds } from '@myco/constants.js';
import {
  listCandidates,
  getCandidate,
  updateCandidate,
  countCandidates,
} from '@myco/db/queries/skill-candidates.js';
import {
  listSkillRecords,
  getSkillRecord,
  getSkillRecordByName,
  countSkillRecords,
} from '@myco/db/queries/skill-records.js';
import { listLineageForSkill } from '@myco/db/queries/skill-lineage.js';
import { countUsageForSkill } from '@myco/db/queries/skill-usage.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;
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

  const candidates = listCandidates({ status, limit, offset });
  const total = countCandidates({ status });

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
  if (!req.body) {
    return { status: 400, body: { error: 'Missing request body' } };
  }

  const existing = getCandidate(req.params.id);
  if (!existing) {
    return { status: 404, body: { error: `Not found: ${req.params.id}` } };
  }

  const updates = {
    ...(req.body as Record<string, unknown>),
    updated_at: epochSeconds(),
  };

  const updated = updateCandidate(req.params.id, updates as Parameters<typeof updateCandidate>[1]);

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

  const records = listSkillRecords({ status, limit, offset });
  const total = countSkillRecords({ status });

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
