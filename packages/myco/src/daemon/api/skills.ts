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
import type { RequestPrincipal } from '../request-principal.js';
import type { DaemonLogger } from '../logger.js';
import { epochSeconds, DEFAULT_LIST_LIMIT } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
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
import { getPublishedSkillContent, getSkillContentAtGeneration, listLineageForSkill } from '@myco/db/queries/skill-lineage.js';
import { countUsageForSkill } from '@myco/db/queries/skill-usage.js';
import { CANDIDATE_STATUS, REST_SETTABLE_STATUSES } from '@myco/constants/skill-candidate-status.js';
import { parseCsvList } from '@myco/utils/parse-csv-list.js';
import { projectScope, type GroveProjectId, type ProjectScope } from '@myco/grove/ids.js';
import { isHostServedRequest } from '@myco/grove/request-context.js';
import { validateSkillCandidateQualityContract } from '@myco/agent/skill-candidate-quality.js';
import { extractFrontmatterFields } from '@myco/agent/tools/skill-validator.js';
import { isSafeSkillNameForFs } from '@myco/skills/names.js';
import {
  removePublishedSkillFileOrDirectoryIfLocal,
  syncPublishedSkillSymlinksIfLocal,
} from '@myco/skills/publication.js';

export { isSafeSkillNameForFs };

/**
 * Tenant scope for a skill route that ran through `tenantRoute`. The wrapper
 * has already proved `principal.tenancy.projectId`/`groveId` are caller-
 * supplied (a synthesized/anchor context was rejected with 400 before the
 * handler ran), so every skill read/mutate is scoped to the REQUEST's own
 * project — never the daemon's bootstrap anchor.
 */
function tenantProjectScope(principal: RequestPrincipal): ProjectScope {
  return projectScope(principal.tenancy.projectId as GroveProjectId);
}

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
export async function handleListCandidates(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIST_LIMIT;
  const offset = req.query.offset ? Number(req.query.offset) : DEFAULT_LIST_OFFSET;
  const scope = tenantProjectScope(principal);

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
export async function handleGetCandidate(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const scope = tenantProjectScope(principal);
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
export async function handleUpdateCandidate(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const id = req.params.id;
  const scope = tenantProjectScope(principal);
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
export async function handleListSkillRecords(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const status = req.query.status || undefined;
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIST_LIMIT;
  const offset = req.query.offset ? Number(req.query.offset) : DEFAULT_LIST_OFFSET;
  const scope = tenantProjectScope(principal);

  const { items: records, total } = listSkillRecordsWithCount({ scope, status, limit, offset });

  return { status: 200, body: { records, total } };
}

/**
 * Get a single skill record by id or name, including its lineage history and
 * total usage count.
 *
 * Tries id first, then falls back to name lookup. Returns 404 if not found.
 */
export async function handleGetSkillRecord(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const idOrName = req.params.id;
  const scope = tenantProjectScope(principal);

  const record = getSkillRecord(idOrName, scope) ?? getSkillRecordByName(idOrName, scope);

  if (!record) {
    return { status: 404, body: { error: `Not found: ${idOrName}` } };
  }

  const lineage = listLineageForSkill(record.id, scope, 50);
  const usage_total = countUsageForSkill(record.id);

  // Parse frontmatter from the latest snapshot with the same YAML parse the
  // write gates use, so the UI shows the fields exactly as validation sees
  // them. The tenant-scoped history list already holds the latest row in
  // the dominant path; the unscoped-by-id read recovers content when legacy
  // lineage rows carry a project_id the tenant scope filters out.
  const latestSnapshot = lineage[0]?.content_snapshot ?? getPublishedSkillContent(record) ?? undefined;
  const frontmatterFields: Record<string, string> = latestSnapshot
    ? extractFrontmatterFields(latestSnapshot)
    : {};

  // A caller pinned to one SPECIFIC generation (the content-claim remote
  // materialize path — `content-claims-materialize.ts`'s `getSkillContent`)
  // passes `?generation=N`. A claim can be pinned at a generation older
  // than the 50-row lineage window above once a skill has been evolved
  // past it, so resolve the requested generation directly via
  // `getSkillContentAtGeneration` instead of requiring it to land inside
  // the display-oriented page — a real, existing generation must never
  // read back as "content unavailable" purely because of the window size.
  // Additive field, ignored by any caller that doesn't send the param.
  const requestedGenerationRaw = req.query.generation;
  const requestedGeneration = requestedGenerationRaw !== undefined && requestedGenerationRaw !== ''
    ? Number(requestedGenerationRaw)
    : NaN;
  const extra = Number.isInteger(requestedGeneration)
    ? { requested_generation_content: getSkillContentAtGeneration(record.id, requestedGeneration) }
    : {};

  return { status: 200, body: { ...record, lineage, usage_total, frontmatter: frontmatterFields, ...extra } };
}

/**
 * Delete a skill candidate by id.
 */
export async function handleDeleteCandidate(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const id = req.params.id;
  const scope = tenantProjectScope(principal);
  const deleted = deleteCandidate(id, scope);
  if (!deleted) return { status: 404, body: { error: `Not found: ${id}` } };

  return { status: 200, body: { deleted: true, id } };
}

/**
 * Delete a skill record by id or name, including lineage and usage data.
 */
export async function handleDeleteSkillRecord(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const idOrName = req.params.id;
  const scope = tenantProjectScope(principal);
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
  logger: DaemonLogger;
}

/**
 * Creates a DELETE /api/skill-records/:id handler that wraps
 * `handleDeleteSkillRecord` with post-deletion file/symlink cleanup.
 *
 * Registered as a `tenantRoute`, so the handler always runs with an
 * authorized `principal` — a synthesized/anchor context is rejected (400 +
 * `tenancy.violation`) by the wrapper before this handler runs. The fs
 * cascade resolves its project root from the REQUEST's tenancy
 * (`principal.tenancy.projectVaultDir`), never a baked-in bootstrap anchor:
 * a delete from project B must remove B's `.agents/skills/<name>` and must
 * never touch the anchor project's files.
 *
 * Team Host residency: on a host-served delete (the host running this route
 * on a remote member's behalf) the host holds the Grove DB but NOT the
 * member's working tree, so the fs cascade below must never run — only the
 * DB delete (and its claim cancel, inside `deleteSkillRecordCascade`) does.
 * `removePublishedSkillFileOrDirectoryIfLocal` / `syncPublishedSkillSymlinksIfLocal`
 * (`skills/publication.ts`) are the single shared chokepoint for this
 * residency check — the same wrappers gate the write-side path at
 * `agent/tools/skill-tools.ts`, so the `if (hostServed) skip` guard exists
 * in exactly one place rather than being reimplemented at each call site.
 */
export function createSkillRecordDeleteHandler(deps: SkillDeleteDeps) {
  const { logger } = deps;

  return async function handleDeleteSkillRecordWithCleanup(
    req: RouteRequest,
    principal: RequestPrincipal,
  ): Promise<RouteResponse> {
    const result = await handleDeleteSkillRecord(req, principal);
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
        // Team Host residency gate — see the chokepoint note above. Both
        // fs calls below route through the `*IfLocal` wrappers, which no-op
        // when host-served instead of this handler re-checking `hostServed`
        // around each call.
        const hostServed = isHostServedRequest(req.requestContext);
        // Scope the fs cascade to the REQUEST project, not the daemon's
        // bootstrap anchor: `principal.tenancy.projectVaultDir` is the
        // caller-authorized vault that survived the context-switch auth gate
        // (tenantRoute rejects synthesized/anchor tenancy before we get
        // here). Deleting a skill from project B must remove B's files and
        // never the anchor project's.
        const projectRoot = resolveProjectRoot(principal.tenancy.projectVaultDir);
        try {
          const removeResult = removePublishedSkillFileOrDirectoryIfLocal(projectRoot, record.name, hostServed);
          if (!removeResult.ok) {
            logger.warn(LOG_KINDS.PROCESSOR_BATCH, 'Refused skill cleanup: resolved path escapes skills root', {
              name: record.name,
              resolved: removeResult.skillDir,
            });
            return result;
          }
        } catch (err) {
          logger.warn(LOG_KINDS.PROCESSOR_BATCH, 'Failed to remove skill directory', { name: record.name, error: String(err) });
        }
        // Remove agent-specific symlinks (e.g., .claude/skills/<name>).
        // syncSkillSymlinks also touches filesystem paths derived from
        // `record.name`; it now applies the same charset gate internally
        // (see symbionts/installer.ts), but the outer guard above means
        // we don't reach it with an unsafe name in the first place.
        try {
          syncPublishedSkillSymlinksIfLocal(projectRoot, record.name, hostServed, { remove: true });
        } catch (err) {
          logger.warn(LOG_KINDS.PROCESSOR_BATCH, 'Failed to remove skill symlinks', { name: record.name, error: String(err) });
        }
      }
    }
    return result;
  };
}
