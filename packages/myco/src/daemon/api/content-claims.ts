/**
 * Content claim system daemon API (Team Host WS2) — the publication-lock
 * surface over DB-resident skills and OKF pages (design:
 * docs/superpowers/specs/2026-07-09-content-claim-system-design.md §3).
 *
 *   GET  /api/content-claims                  claimable inventory + active claims
 *   POST /api/content-claims                  constraint-based claim
 *   POST /api/content-claims/:id/refresh      holder-only generation bump
 *   POST /api/content-claims/:id/release      holder-only release
 *   POST /api/content-claims/:id/published    holder marks published; upserts content_publications
 *
 * Staleness (claimed generation vs the artifact's current lineage-latest) is
 * computed here, host-side, in every response that carries a claim — never
 * by the caller comparing generations itself.
 */

import type { RouteRequest, RouteResponse, RouteRegistrar } from '../router.js';
import type { RequestPrincipal } from '../request-principal.js';
import type { DaemonLogger } from '../logger.js';
import { tenantRoute } from './route-helpers.js';
import { errorBody } from './error-envelope.js';
import { epochSeconds, CONTENT_CLAIM_TTL_MS } from '@myco/constants.js';
import { projectScope, type GroveProjectId, type ProjectScope } from '@myco/grove/ids.js';
import { getSkillRecord, listSkillRecords } from '@myco/db/queries/skill-records.js';
import { getOkfPageById, listOkfPages } from '@myco/db/queries/okf.js';
import {
  insertContentClaim,
  getContentClaimById,
  listActiveContentClaims,
  updateContentClaimGeneration,
  releaseContentClaim,
  markContentClaimPublished,
  listContentPublications,
  type ContentClaimArtifactKind,
  type ContentClaimRow,
} from '@myco/db/queries/content-claims.js';

const VALID_ARTIFACT_KINDS: ReadonlySet<string> = new Set(['skill', 'okf_page']);
const ARTIFACT_INVENTORY_LIMIT = 1000;

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function scopeFor(principal: RequestPrincipal): ProjectScope {
  return projectScope(principal.tenancy.projectId as GroveProjectId);
}

/**
 * The identity making this request. `RequestPrincipal.identity.machineId`
 * (from `tenantRoute`) is the EXECUTING daemon's own machine id — correct
 * for tenancy/authorization, but not for "which member is claiming" on a
 * request the host is serving on a member's behalf over the overlay. The
 * per-request resolved `req.requestContext.machineId` carries the caller's
 * own identity (from `x-myco-machine-id`, forwarded verbatim by the proxy —
 * only tenancy is rewritten to the attach mapping), the same source every
 * other identity-attributing route reads (`sessions.ts`, `session-lifecycle.ts`).
 * Falls back to the executing daemon's id for a caller that supplied none.
 */
function requesterMachineId(req: RouteRequest, principal: RequestPrincipal): string {
  return req.requestContext?.machineId ?? principal.identity.machineId;
}

/** Current lineage-latest generation + a display label for one artifact, or
 *  null when it does not exist (or is not visible in this project's scope). */
function resolveArtifact(
  kind: string,
  id: string,
  scope: ProjectScope,
): { generation: number; label: string } | null {
  if (kind === 'skill') {
    const record = getSkillRecord(id, scope);
    return record ? { generation: record.generation, label: record.display_name || record.name } : null;
  }
  if (kind === 'okf_page') {
    const page = getOkfPageById(scope, id);
    return page ? { generation: page.generation, label: page.title || page.path } : null;
  }
  return null;
}

/** Render a claim row for a response, computing staleness against the
 *  artifact's current lineage-latest generation (null when unknown/deleted). */
function claimView(row: ContentClaimRow, currentGeneration: number | null): Record<string, unknown> {
  return {
    id: row.id,
    artifact_kind: row.artifact_kind,
    artifact_id: row.artifact_id,
    generation: row.generation,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
    expires_at: row.expires_at,
    state: row.state,
    released_at: row.released_at,
    published_at: row.published_at,
    stale: currentGeneration !== null && currentGeneration !== row.generation,
  };
}

// ---------------------------------------------------------------------------
// GET /api/content-claims — claimable inventory + active claims
// ---------------------------------------------------------------------------

export async function handleContentClaimsList(
  _req: RouteRequest,
  principal: RequestPrincipal,
): Promise<RouteResponse> {
  const scope = scopeFor(principal);

  const skills = listSkillRecords({ scope, status: 'active', limit: ARTIFACT_INVENTORY_LIMIT });
  const pages = listOkfPages(scope, 'active');
  const publicationByKey = new Map(
    listContentPublications().map((p) => [`${p.artifact_kind}:${p.artifact_id}`, p]),
  );
  const activeClaims = listActiveContentClaims(scope);
  const activeClaimByKey = new Map(activeClaims.map((c) => [`${c.artifact_kind}:${c.artifact_id}`, c]));

  const claimable: Array<Record<string, unknown>> = [];
  const addCandidate = (kind: ContentClaimArtifactKind, id: string, label: string, generation: number) => {
    const key = `${kind}:${id}`;
    const publishedGeneration = publicationByKey.get(key)?.published_generation ?? null;
    if (publishedGeneration === generation) return; // already published at lineage-latest
    const activeClaim = activeClaimByKey.get(key) ?? null;
    claimable.push({
      artifact_kind: kind,
      artifact_id: id,
      label,
      lineage_generation: generation,
      published_generation: publishedGeneration,
      active_claim: activeClaim ? claimView(activeClaim, generation) : null,
    });
  };

  for (const record of skills) {
    addCandidate('skill', record.id, record.display_name || record.name, record.generation);
  }
  for (const page of pages) {
    addCandidate('okf_page', page.id, page.title || page.path, page.generation);
  }

  return {
    status: 200,
    body: {
      ok: true,
      claimable,
      active_claims: activeClaims.map((claim) => {
        const artifact = resolveArtifact(claim.artifact_kind, claim.artifact_id, scope);
        return claimView(claim, artifact?.generation ?? null);
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/content-claims — constraint-based claim
// ---------------------------------------------------------------------------

export async function handleContentClaimCreate(
  req: RouteRequest,
  principal: RequestPrincipal,
): Promise<RouteResponse> {
  const body = asRecord(req.body);
  const artifactKind = body.artifact_kind;
  const artifactId = body.artifact_id;
  if (
    typeof artifactKind !== 'string'
    || !VALID_ARTIFACT_KINDS.has(artifactKind)
    || typeof artifactId !== 'string'
    || artifactId.length === 0
  ) {
    return {
      status: 400,
      body: errorBody('invalid_request', "artifact_kind ('skill'|'okf_page') and artifact_id are required"),
    };
  }

  const scope = scopeFor(principal);
  const artifact = resolveArtifact(artifactKind, artifactId, scope);
  if (!artifact) {
    return { status: 404, body: errorBody('artifact_not_found', `${artifactKind} ${artifactId} not found`) };
  }

  const now = epochSeconds();
  const claimant = requesterMachineId(req, principal);
  const result = insertContentClaim({
    artifactKind: artifactKind as ContentClaimArtifactKind,
    artifactId,
    generation: artifact.generation,
    projectId: principal.tenancy.projectId,
    claimedBy: claimant,
    claimedAt: now,
    expiresAt: now + Math.floor(CONTENT_CLAIM_TTL_MS / 1000),
    machineId: claimant,
  });

  if (!result.ok) {
    return {
      status: 409,
      body: {
        ...errorBody('already_claimed', `${artifactKind} ${artifactId} is already claimed`),
        holder: result.holder ? claimView(result.holder, artifact.generation) : null,
      },
    };
  }

  return {
    status: 201,
    body: {
      ok: true,
      claim: claimView(result.row, artifact.generation),
      content: { artifact_kind: artifactKind, artifact_id: artifactId, generation: artifact.generation },
    },
  };
}

// ---------------------------------------------------------------------------
// Shared pre-checks for the three id-addressed mutations below
// ---------------------------------------------------------------------------

type ClaimGateResult =
  | { ok: true; claim: ContentClaimRow }
  | { ok: false; response: RouteResponse };

/** Loads the claim by id (scoped) and runs the two gates every id-addressed
 *  mutation shares: the claim must still be `active`, and the requester must
 *  be its holder. The holder check compares `claimed_by` to the requester's
 *  machine_id — under v1 flat trust `machine_id` is an unauthenticated
 *  identity (routing.ts:571-578), so this is COOPERATIVE, not a security
 *  boundary: the real serialization guarantee is the ACTIVE-partial unique
 *  index at claim-creation time, which is identity-independent. */
function loadActiveHeldClaim(id: string, requesterId: string, scope: ProjectScope): ClaimGateResult {
  const claim = getContentClaimById(id, scope);
  if (!claim) {
    return { ok: false, response: { status: 404, body: errorBody('claim_not_found', `claim ${id} not found`) } };
  }
  if (claim.state !== 'active') {
    return {
      ok: false,
      response: { status: 409, body: errorBody('claim_not_active', `claim ${id} is ${claim.state}, not active`) },
    };
  }
  if (claim.claimed_by !== requesterId) {
    return {
      ok: false,
      response: { status: 403, body: errorBody('not_holder', 'only the claim holder may do this') },
    };
  }
  return { ok: true, claim };
}

// ---------------------------------------------------------------------------
// POST /api/content-claims/:id/refresh
// ---------------------------------------------------------------------------

export async function handleContentClaimRefresh(
  req: RouteRequest,
  principal: RequestPrincipal,
): Promise<RouteResponse> {
  const scope = scopeFor(principal);
  const gate = loadActiveHeldClaim(req.params.id, requesterMachineId(req, principal), scope);
  if (!gate.ok) return gate.response;

  const artifact = resolveArtifact(gate.claim.artifact_kind, gate.claim.artifact_id, scope);
  if (!artifact) {
    return {
      status: 404,
      body: errorBody('artifact_not_found', `${gate.claim.artifact_kind} ${gate.claim.artifact_id} not found`),
    };
  }

  const updated = updateContentClaimGeneration(gate.claim.id, artifact.generation);
  if (!updated) {
    return {
      status: 409,
      body: errorBody('claim_not_active', `claim ${gate.claim.id} is no longer active`),
    };
  }
  return { status: 200, body: { ok: true, claim: claimView(updated, artifact.generation) } };
}

// ---------------------------------------------------------------------------
// POST /api/content-claims/:id/release
// ---------------------------------------------------------------------------

export async function handleContentClaimRelease(
  req: RouteRequest,
  principal: RequestPrincipal,
): Promise<RouteResponse> {
  const scope = scopeFor(principal);
  const gate = loadActiveHeldClaim(req.params.id, requesterMachineId(req, principal), scope);
  if (!gate.ok) return gate.response;

  const released = releaseContentClaim(gate.claim.id, epochSeconds());
  if (!released) {
    return {
      status: 409,
      body: errorBody('claim_not_active', `claim ${gate.claim.id} is no longer active`),
    };
  }
  return { status: 200, body: { ok: true, claim: claimView(released, null) } };
}

// ---------------------------------------------------------------------------
// POST /api/content-claims/:id/published
// ---------------------------------------------------------------------------

export async function handleContentClaimPublished(
  req: RouteRequest,
  principal: RequestPrincipal,
): Promise<RouteResponse> {
  const scope = scopeFor(principal);
  const claimant = requesterMachineId(req, principal);
  const gate = loadActiveHeldClaim(req.params.id, claimant, scope);
  if (!gate.ok) return gate.response;

  // One transactional operation: the claim transition and the
  // content_publications upsert land together or not at all (the store
  // function owns the pairing — see markContentClaimPublished).
  const result = markContentClaimPublished(gate.claim.id, {
    publishedAt: epochSeconds(),
    publishedBy: claimant,
    machineId: claimant,
  });
  if (!result) {
    return {
      status: 409,
      body: errorBody('claim_not_active', `claim ${gate.claim.id} is no longer active`),
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      claim: claimView(result.claim, result.claim.generation),
      publication: result.publication,
    },
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register every content-claim route on the daemon server, tenancy-wrapped. */
export function registerContentClaimRoutes(
  server: RouteRegistrar,
  tenant: { machineId: string; logger: DaemonLogger },
): void {
  server.registerRoute('GET', '/api/content-claims', tenantRoute(tenant, handleContentClaimsList));
  server.registerRoute('POST', '/api/content-claims', tenantRoute(tenant, handleContentClaimCreate));
  server.registerRoute('POST', '/api/content-claims/:id/refresh', tenantRoute(tenant, handleContentClaimRefresh));
  server.registerRoute('POST', '/api/content-claims/:id/release', tenantRoute(tenant, handleContentClaimRelease));
  server.registerRoute('POST', '/api/content-claims/:id/published', tenantRoute(tenant, handleContentClaimPublished));
}
