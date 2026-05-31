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

import { z } from 'zod';
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
import { CANDIDATE_STATUS, REST_SETTABLE_STATUSES } from '@myco/constants/skill-candidate-status.js';
import { parseCsvList } from '@myco/utils/parse-csv-list.js';
import { projectScopeFromRequestContext } from '@myco/tools/request-context.js';
import { validateSkillCandidateQualityContract } from '@myco/agent/skill-candidate-quality.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIST_OFFSET = 0;

/**
 * Filesystem-safe shape for a skill `name`. The same regex is used as a
 * filesystem-path gate before `fs.rmSync(recursive, force)` and as a
 * defense-in-depth check before the resolved-path containment guard
 * (`path.relative` startsWith `..`).
 *
 * Rules:
 *   - lowercase a-z, 0-9, and hyphen only
 *   - must start with [a-z0-9]
 *   - length capped at 100 to keep symlink targets within typical PATH_MAX
 *
 * A skill_record row reaches this handler via team sync (peer Worker
 * push), and the name field is replayed onto the local filesystem to
 * cascade the delete. Without this gate, a peer-controlled name like
 * `../../etc` or `../../../foo` would resolve outside `.agents/skills/`
 * and `fs.rmSync({ recursive: true, force: true })` would happily walk
 * the traversed path.
 */
const SAFE_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export function isSafeSkillNameForFs(name: string): boolean {
  return SAFE_SKILL_NAME_RE.test(name);
}

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
 * Schema for PUT /api/skill-candidates/:id bodies.
 *
 * Every field is optional (the handler patches only what's supplied). The
 * `status` whitelist is checked after parsing because Zod doesn't carry the
 * REST/agent split that {@link REST_SETTABLE_STATUSES} encodes.
 *
 * `quality_failures` and `coverage_matches` reject `null` because v42 stores
 * them as `NOT NULL DEFAULT '[]'` JSON-text columns — a null write would
 * violate the schema constraint downstream.
 */
const UpdateCandidateBody = z.object({
  status: z.string().optional(),
  topic: z.string().optional(),
  rationale: z.string().optional(),
  confidence: z.number().optional(),
  source_ids: z.string().optional(),
  skill_id: z.string().nullable().optional(),
  evidence_bundle_id: z.string().nullable().optional(),
  quality_score: z.number().nullable().optional(),
  quality_failures: z.string().optional(),
  coverage_matches: z.string().optional(),
  last_reconciled_at: z.number().int().nullable().optional(),
  reconciliation_reason: z.string().nullable().optional(),
});

/**
 * Update a skill candidate's fields (typically used to advance its status).
 *
 * Automatically sets updated_at to the current epoch seconds.
 * Returns 400 if no body or if the status value is not in ALLOWED_REST_STATUSES,
 * 404 if candidate not found.
 */
export async function handleUpdateCandidate(req: RouteRequest): Promise<RouteResponse> {
  const id = req.params.id;
  const scope = projectScopeFromRequestContext(req.requestContext);
  if (req.body === undefined || req.body === null) {
    return { status: 400, body: { error: 'Request body required' } };
  }

  // Validate the shape FIRST. Field-level typeof guards land here so a
  // client sending `quality_score: "high"` or `last_reconciled_at: "today"`
  // is rejected with a structured error envelope rather than silently
  // storing a wrong-typed value that downstream validators read back as
  // garbage. The schema's `.optional()` defaults mean callers still patch
  // only the fields they supply; unknown fields are stripped.
  const parsed = UpdateCandidateBody.safeParse(req.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        error: 'Invalid request body',
        details: { issues: parsed.error.issues },
      },
    };
  }
  const patch = parsed.data;
  const {
    status,
    topic,
    rationale,
    confidence,
    source_ids,
    skill_id,
    evidence_bundle_id,
    quality_score,
    quality_failures,
    coverage_matches,
    last_reconciled_at,
    reconciliation_reason,
  } = patch;

  // Status whitelist guard — defense in depth against a compromised or
  // misconfigured MCP client reaching this endpoint with an internal
  // status. The agent-facing vault_skill_candidates tool also narrows
  // its Zod enum to the same set.
  if (status !== undefined && !ALLOWED_REST_STATUSES.has(status)) {
    return {
      status: 400,
      body: {
        error:
          `Invalid status '${status}'. REST callers may only set: ` +
          `${[...ALLOWED_REST_STATUSES].join(', ')}. The 'generated' status ` +
          "is set internally by vault_finalize_skill after validation.",
      },
    };
  }

  const existing = getCandidate(id, scope);
  if (!existing) return { status: 404, body: { error: `Candidate not found: ${id}` } };

  const resultingStatus = status ?? existing.status;
  const approvalWarnings: string[] = [];
  if (resultingStatus === CANDIDATE_STATUS.APPROVED) {
    // A row is treated as "legacy" — predating the v42 quality pipeline —
    // when none of the v42 metadata fields are populated on the existing
    // row AND the patch doesn't supply any. Any row the v42 pipeline has
    // touched will have evidence_bundle_id set (or one of the other
    // metadata columns moved off its default), so this only matches rows
    // that existed in user vaults before v42 shipped. Those rows must
    // remain approvable — refusing them would strand candidates the user
    // already triaged. Post-v42 candidates always go through the gate.
    const isLegacyCandidate =
      existing.evidence_bundle_id === null && evidence_bundle_id === undefined
      && existing.quality_score === null && quality_score === undefined
      && existing.quality_failures === '[]' && quality_failures === undefined
      && existing.coverage_matches === '[]' && coverage_matches === undefined
      && existing.last_reconciled_at === null && last_reconciled_at === undefined
      && existing.reconciliation_reason === null && reconciliation_reason === undefined;

    if (isLegacyCandidate) {
      approvalWarnings.push('legacy-candidate-approved-without-v42-quality-gate');
    } else {
      const candidateForValidation = {
        ...existing,
        ...(source_ids !== undefined ? { source_ids } : {}),
        ...(evidence_bundle_id !== undefined ? { evidence_bundle_id } : {}),
        ...(quality_score !== undefined ? { quality_score } : {}),
        ...(quality_failures !== undefined ? { quality_failures } : {}),
        ...(coverage_matches !== undefined ? { coverage_matches } : {}),
      };
      const issues = validateSkillCandidateQualityContract(candidateForValidation, {
        requireResolvedSources: true,
        scope,
      });
      if (issues.length > 0) {
        return {
          status: 400,
          body: {
            error: 'Candidate cannot be approved until its evidence metadata is complete and resolvable.',
            details: { issues },
          },
        };
      }
    }
  }

  const updated = updateCandidate(id, {
    ...(status !== undefined ? { status } : {}),
    ...(topic !== undefined ? { topic } : {}),
    ...(rationale !== undefined ? { rationale } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(source_ids !== undefined ? { source_ids } : {}),
    ...(skill_id !== undefined ? { skill_id } : {}),
    ...(evidence_bundle_id !== undefined ? { evidence_bundle_id } : {}),
    ...(quality_score !== undefined ? { quality_score } : {}),
    ...(quality_failures !== undefined ? { quality_failures } : {}),
    ...(coverage_matches !== undefined ? { coverage_matches } : {}),
    ...(last_reconciled_at !== undefined ? { last_reconciled_at } : {}),
    ...(reconciliation_reason !== undefined ? { reconciliation_reason } : {}),
    updated_at: epochSeconds(),
  }, scope);

  if (!updated) return { status: 404, body: { error: `Candidate not found: ${id}` } };
  return {
    status: 200,
    body: {
      candidate: updated,
      ...(approvalWarnings.length > 0 ? { warnings: approvalWarnings } : {}),
    },
  };
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

  // The DELETE FROM skill_records inside deleteSkillRecordCascade fires the
  // skill_records_team_ad trigger, which journals the delete to team_outbox
  // when this Grove's team_sync_state.enabled = 1. No manual enqueue needed.
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
        // Path-traversal gate: a peer-controlled skill name (rows arrive
        // via team-sync from the cloud Worker) reaching `fs.rmSync({
        // recursive: true, force: true })` is a destructive primitive
        // gated on attacker input. Two stacked checks:
        //   1. Charset gate — reject anything that isn't a slug.
        //   2. Containment gate — even if the charset check were too
        //      permissive (defense in depth), the resolved path must
        //      live under `<projectRoot>/.agents/skills/`.
        if (!isSafeSkillNameForFs(record.name)) {
          logger.warn(LOG_KINDS.PROCESSOR_BATCH, 'Refused skill cleanup: unsafe name shape', { name: record.name });
          return result;
        }
        const projectRoot = resolveProjectRoot(vaultDir);
        const skillsRoot = path.resolve(projectRoot, '.agents', 'skills');
        const skillDir = path.resolve(skillsRoot, record.name);
        const rel = path.relative(skillsRoot, skillDir);
        if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
          logger.warn(LOG_KINDS.PROCESSOR_BATCH, 'Refused skill cleanup: resolved path escapes skills root', {
            name: record.name,
            resolved: skillDir,
          });
          return result;
        }
        try { fs.rmSync(skillDir, { recursive: true, force: true }); } catch (err) {
          logger.warn(LOG_KINDS.PROCESSOR_BATCH, 'Failed to remove skill directory', { name: record.name, error: String(err) });
        }
        // Remove agent-specific symlinks (e.g., .claude/skills/<name>).
        // syncSkillSymlinks also touches filesystem paths derived from
        // `record.name`; it now applies the same charset gate internally
        // (see symbionts/installer.ts), but the outer guard above means
        // we don't reach it with an unsafe name in the first place.
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
