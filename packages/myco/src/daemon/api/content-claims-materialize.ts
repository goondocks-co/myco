/**
 * Content claim system — member-side materialization, the ONLY disk write
 * (design: docs/superpowers/specs/2026-07-09-content-claim-system-design.md
 * §4).
 *
 *   POST /api/content-claims/:id/materialize   { project_root: string }
 *
 * Distinct from the five Grove-DB routes in `content-claims.ts`: those mutate
 * rows the HOST legitimately owns for an attached project, so they `serve`
 * (proxy). This route writes the CALLING member's own working tree — a
 * `serve` stamp would proxy the whole request to the host and the host would
 * run the writers against a tree it doesn't have, violating B1 (the host
 * never writes a member tree). `host/routing.ts` stamps it `localhost-only`
 * instead: never proxied, always dispatched on whichever daemon received the
 * request. Because of that stamp, `isOverlayRequest` is always false for a
 * request that reaches this handler — `requestContext.hostServed` is
 * structurally always false here (a genuine overlay-origin request is
 * refused earlier, at the transport boundary, by `overlayHostStampRefusal`).
 * The explicit `isHostServedRequest` check inside `resolveMemberProjectContext`
 * repeats that guarantee in-handler as defense in depth, matching the host's
 * own independent enforcement elsewhere — it must never rest on the stamp
 * alone.
 *
 * Deliberately bypasses `req.requestContext` for project identity: that
 * context is resolved from `x-myco-*` tenancy headers against the LOCAL
 * Grove registry (`resolveRouteRequestContext`, `daemon/server.ts`), which
 * throws for an attached project (its Grove has no local registry row — see
 * `grove/request-context.ts`'s `requestContextFromHttpHeaders` docstring).
 * The caller sends none of those headers for this route; instead the
 * member's CURRENT project root travels in the JSON body, and identity is
 * resolved from it directly by the shared `resolveMemberProjectContext`
 * prelude (`resolveAttach`, `findRegisteredProject` — both pure disk reads),
 * the same pattern `attached-config.ts` uses for the config carve.
 *
 * Two claim/content sources feed the same orchestration
 * (`materializeContentClaim`): a LOCAL source that queries the project's own
 * Grove DB in-process, and a REMOTE source that dials the host directly
 * (mirroring `attached-config.ts`'s `fetchHostGroveConfig`) rather than
 * proxying the whole request — the member needs the claim state and content
 * snapshot as data to decide whether to write, not a relayed response body.
 * One `dialHostJson` transport backs every remote call below (skill content
 * and the republish auto-close's mark-published POST) — a second one must
 * never be added.
 *
 * Republish auto-close (spec §2(c)): after a successful write, if the
 * claim's own generation equals the artifact's already-recorded
 * `published_generation`, the write IS a republish of already-published
 * content (e.g. the published file was deleted from disk/git and the user
 * re-claimed at the same, unchanged generation) — the claim closes in the
 * same request rather than dangling as an invisible lock. A first-time
 * publish or a materialize at a newer generation leaves the claim `active`
 * for the existing manual Mark-published flow.
 *
 * `skill` is the only artifact kind this route materializes — it runs the
 * two existing chokepoints in `skills/publication.ts`. A claim carrying any
 * other `artifact_kind` (including a surviving pre-retirement `okf_page`
 * row — data preservation keeps such rows in the table) falls through to
 * `unsupported_artifact_kind` (400): the row itself stays readable elsewhere
 * in the claim system (list/release/expiry), it simply cannot be
 * materialized.
 */
import http from 'node:http';

import {
  HOST_PROTOCOL_HEADER,
  HOST_PROTOCOL_VERSION,
  HOST_PROXY_CONNECT_TIMEOUT_MS,
  HOST_PROXY_HEADERS_TIMEOUT_MS,
  HOST_PROXY_MAX_BUFFERED_BODY_BYTES,
  epochSeconds,
} from '@myco/constants.js';
import { withDatabase, type Database } from '@myco/db/client.js';
import {
  getContentClaimById,
  getContentPublication,
  markContentClaimPublished,
} from '@myco/db/queries/content-claims.js';
import { getSkillContentAtGeneration } from '@myco/db/queries/skill-lineage.js';
import { getSkillRecord } from '@myco/db/queries/skill-records.js';
import { assertGroveProjectId, projectScope, type ProjectScope } from '@myco/grove/ids.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { REQUEST_CONTEXT_HEADERS } from '@myco/grove/request-context.js';
import { remoteTargetFor, type RemoteTarget } from '@myco/host/routing.js';
import { writePublishedSkillFile, syncPublishedSkillSymlinks } from '@myco/skills/publication.js';
import type { GroveRuntimeCache } from '../grove-runtime-cache.js';
import type { Dialer, ProxyLogger } from '../host-proxy.js';
import type { RouteHandler, RouteRegistrar, RouteResponse } from '../router.js';
import { errorBody } from './error-envelope.js';
import { resolveMemberProjectContext } from './member-project-context.js';

// ---------------------------------------------------------------------------
// Claim/content source abstraction — LOCAL (in-process DB) and REMOTE (dial
// the host) both resolve to the same shape so the orchestration below never
// branches on residency.
// ---------------------------------------------------------------------------

export interface ResolvedClaim {
  id: string;
  artifactKind: string;
  artifactId: string;
  generation: number;
}

export interface SkillContent {
  name: string;
  content: string;
}

/** Exported as a test seam — orchestration-level tests drive
 *  `materializeContentClaim` with a hand-rolled source to simulate the
 *  fetch/re-assert race without needing real network or DB timing. */
export interface ClaimSource {
  /** The claim's current state, or null when it does not exist / is not
   *  `active`. Called TWICE by the orchestration: once to learn what to
   *  fetch, once immediately before the write (spec §4 step 3). */
  getActiveClaim(claimId: string): Promise<ResolvedClaim | null>;
  /**
   * True when the MOST RECENT `getActiveClaim` call returned null because
   * the host could not be reached at all (a transport failure — dial
   * threw, timed out, or the response never arrived), as opposed to a
   * reachable host reporting the claim isn't active. Optional: the LOCAL
   * source has no network failure mode and omits it — a missing
   * implementation reads as "not unreachable" (a genuine claim-state
   * miss). Lets the orchestration surface a distinct `host_unreachable`
   * outcome on materialize's first check instead of the misleading
   * `claim_not_active` ("re-claim and try again") when the real problem
   * is a down host — re-claiming would fail the identical way.
   */
  wasLastActiveClaimCheckHostUnreachable?(): boolean;
  getSkillContent(artifactId: string, generation: number): Promise<SkillContent | null>;
  /** The durable `published_generation` already on record for this artifact,
   *  or null if it has never been published. Read AFTER a successful write to
   *  decide republish auto-close (spec §2(c)): never throws — a resolution
   *  failure degrades to null (no auto-close) rather than failing the write
   *  that already landed. */
  getPublishedGeneration(artifactKind: string, artifactId: string): Promise<number | null>;
  /** Marks the claim published through the branch's pinned close path
   *  (local: `markContentClaimPublished`; attached: the host's `POST
   *  /api/content-claims/:id/published`). Returns true on success, false on
   *  any failure — never throws, so a bookkeeping failure after a successful
   *  disk write never turns into a failed materialize response. Every false
   *  return carries exactly ONE warn, logged by the source itself at the
   *  point of detection (where the failure's specifics live); the
   *  orchestration adds no second, generic warn on top. */
  markPublished(claimId: string): Promise<boolean>;
}

function localClaimSource(
  db: Database,
  scope: ProjectScope,
  machineId: string,
  logger: ProxyLogger,
): ClaimSource {
  return {
    async getActiveClaim(claimId) {
      return withDatabase(db, () => {
        const row = getContentClaimById(claimId, scope);
        if (!row || row.state !== 'active') return null;
        return {
          id: row.id,
          artifactKind: row.artifact_kind,
          artifactId: row.artifact_id,
          generation: row.generation,
        };
      });
    },
    async getSkillContent(artifactId, generation) {
      return withDatabase(db, () => {
        const record = getSkillRecord(artifactId, scope);
        if (!record) return null;
        const content = getSkillContentAtGeneration(artifactId, generation);
        return content ? { name: record.name, content } : null;
      });
    },
    async getPublishedGeneration(artifactKind, artifactId) {
      try {
        return withDatabase(db, () => getContentPublication(artifactKind, artifactId)?.published_generation ?? null);
      } catch (err) {
        logger.warn('materialize: local publication-row read failed during auto-close check', {
          artifact_kind: artifactKind,
          artifact_id: artifactId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
    async markPublished(claimId) {
      try {
        return withDatabase(db, () => {
          const result = markContentClaimPublished(claimId, {
            publishedAt: epochSeconds(),
            publishedBy: machineId,
            machineId,
          });
          if (result === null) {
            logger.warn('materialize: auto-close found the claim no longer active after the write; it closes via the manual Mark-published flow or TTL instead', {
              claim_id: claimId,
            });
            return false;
          }
          return true;
        });
      } catch (err) {
        logger.warn('materialize: local mark-published call failed after the write; the claim stays active for the manual Mark-published flow or TTL', {
          claim_id: claimId,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
  };
}

interface ContentClaimsListBody {
  active_claims?: Array<{
    id: string;
    artifact_kind: string;
    artifact_id: string;
    generation: number;
    state: string;
  }>;
  /** The inventory's already-published-at-latest artifacts (Task 1.2). Reused
   *  here, from the SAME dial `getActiveClaim` already makes, as the attached
   *  branch's publication read for the republish auto-close check — no second
   *  host surface. */
  published?: Array<{
    artifact_kind: string;
    artifact_id: string;
    published_generation: number;
  }>;
}

interface SkillRecordBody {
  name?: string;
  lineage?: Array<{ generation: number; content_snapshot: string }>;
  /** Present only when the request carried `?generation=` — the exact
   *  requested generation's snapshot, resolved independently of the
   *  (capped) `lineage` page above. Absent on an older host that predates
   *  this field; callers fall back to searching `lineage`. */
  requested_generation_content?: string | null;
}

/**
 * One-shot request against the host over the overlay, returning the parsed
 * JSON body alongside the status code — or null on any transport failure
 * (unreachable, timeout, oversized, unparseable). Deliberately does not
 * special-case non-2xx: callers need to see a 404 body (e.g. a deleted skill
 * record) to render the right materialize failure, not have it degrade
 * silently the way a config read (which always has a sane default) does.
 *
 * Defaults to GET with no body; a caller doing the republish auto-close's
 * mark-published call passes `method: 'POST'` and, when the target route
 * needs one, `body` (JSON-serialized and given a `content-length`/
 * `content-type` so the host's mutating-body CSRF gate accepts it) and
 * `machineId` (stamped as `REQUEST_CONTEXT_HEADERS.machineId` so the host
 * attributes the write to the calling member, not itself).
 */
function dialHostJson<T>(
  target: RemoteTarget,
  pathname: string,
  dial: Dialer,
  options: { method?: string; body?: unknown; machineId?: string } = {},
): Promise<{ status: number; body: T } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: { status: number; body: T } | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const method = options.method ?? 'GET';
    const bodyBytes = options.body !== undefined ? Buffer.from(JSON.stringify(options.body), 'utf-8') : null;

    let dialed: http.ClientRequest | Promise<http.ClientRequest>;
    try {
      dialed = dial(target, {
        method,
        path: pathname,
        headers: {
          authorization: `Bearer ${target.bearer}`,
          [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
          [REQUEST_CONTEXT_HEADERS.groveId]: target.groveId,
          [REQUEST_CONTEXT_HEADERS.projectId]: target.projectId,
          ...(options.machineId ? { [REQUEST_CONTEXT_HEADERS.machineId]: options.machineId } : {}),
          accept: 'application/json',
          ...(bodyBytes
            ? { 'content-type': 'application/json', 'content-length': String(bodyBytes.length) }
            : {}),
        },
      });
    } catch {
      done(null);
      return;
    }

    Promise.resolve(dialed).then((proxyReq) => {
      proxyReq.setTimeout(HOST_PROXY_CONNECT_TIMEOUT_MS + HOST_PROXY_HEADERS_TIMEOUT_MS, () => {
        proxyReq.destroy();
        done(null);
      });
      proxyReq.on('error', () => done(null));
      proxyReq.on('response', (proxyRes) => {
        const status = proxyRes.statusCode ?? 502;
        const chunks: Buffer[] = [];
        let total = 0;
        proxyRes.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > HOST_PROXY_MAX_BUFFERED_BODY_BYTES) {
            proxyRes.destroy();
            done(null);
          } else {
            chunks.push(chunk);
          }
        });
        proxyRes.on('error', () => done(null));
        proxyRes.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T;
            done({ status, body: parsed });
          } catch {
            done(null);
          }
        });
      });
      if (bodyBytes) proxyReq.write(bodyBytes);
      proxyReq.end();
    }).catch(() => done(null));
  });
}

function remoteClaimSource(target: RemoteTarget, dial: Dialer, logger: ProxyLogger, machineId: string): ClaimSource {
  // Populated by every `getActiveClaim` dial from that SAME response's
  // `published[]` array — the republish auto-close check below reads this
  // cache instead of issuing a second `/api/content-claims` dial ("one dial
  // covers claim state and publication row"). `getActiveClaim` runs at least
  // once, and immediately before the write (spec §4 step 3), before the
  // auto-close check ever runs, so the cache is always fresh by then.
  let lastPublicationByKey: Map<string, number> | null = null;
  // Set on every `getActiveClaim` call — true only for the transport-failure
  // branch (`dialHostJson` returned null: the host itself couldn't be
  // reached), false for a reachable host regardless of what it answered.
  // Read by the orchestration immediately after a null result to tell
  // "host down" apart from "claim genuinely not active".
  let lastActiveClaimHostUnreachable = false;

  return {
    async getActiveClaim(claimId) {
      const result = await dialHostJson<ContentClaimsListBody>(target, '/api/content-claims', dial);
      if (!result) {
        logger.warn('materialize: host unreachable while checking claim state', {
          host_id: target.host.host_id,
          claim_id: claimId,
        });
        lastPublicationByKey = null;
        lastActiveClaimHostUnreachable = true;
        return null;
      }
      lastActiveClaimHostUnreachable = false;
      if (result.status !== 200) {
        lastPublicationByKey = null;
        return null;
      }
      lastPublicationByKey = new Map(
        (result.body.published ?? []).map((p) => [`${p.artifact_kind}:${p.artifact_id}`, p.published_generation]),
      );
      const claim = result.body.active_claims?.find((c) => c.id === claimId);
      if (!claim || claim.state !== 'active') return null;
      return {
        id: claim.id,
        artifactKind: claim.artifact_kind,
        artifactId: claim.artifact_id,
        generation: claim.generation,
      };
    },
    wasLastActiveClaimCheckHostUnreachable() {
      return lastActiveClaimHostUnreachable;
    },
    async getSkillContent(artifactId, generation) {
      // `?generation=` asks the host to resolve this EXACT generation
      // directly (`getSkillContentAtGeneration`), independent of the
      // capped `lineage` page below — a claim pinned at a generation
      // older than the skill's most-recent-50 lineage window would
      // otherwise read back as `content_unavailable` even though the
      // content still exists. Falls back to searching `lineage` for an
      // older host that doesn't send the new field (additive, no
      // HOST_PROTOCOL_VERSION bump needed).
      const result = await dialHostJson<SkillRecordBody>(
        target,
        `/api/skill-records/${encodeURIComponent(artifactId)}?generation=${encodeURIComponent(String(generation))}`,
        dial,
      );
      if (!result) {
        logger.warn('materialize: host unreachable while fetching skill content', {
          host_id: target.host.host_id,
          artifact_id: artifactId,
        });
        return null;
      }
      if (result.status !== 200 || !result.body.name) return null;
      const snapshot = result.body.requested_generation_content
        ?? result.body.lineage?.find((l) => l.generation === generation)?.content_snapshot;
      return snapshot ? { name: result.body.name, content: snapshot } : null;
    },
    async getPublishedGeneration(artifactKind, artifactId) {
      return lastPublicationByKey?.get(`${artifactKind}:${artifactId}`) ?? null;
    },
    async markPublished(claimId) {
      const result = await dialHostJson<{ ok: boolean }>(
        target,
        `/api/content-claims/${encodeURIComponent(claimId)}/published`,
        dial,
        { method: 'POST', machineId },
      );
      if (!result || result.status !== 200) {
        logger.warn('materialize: host mark-published dial failed after the write; the claim stays active for the manual Mark-published flow or TTL', {
          host_id: target.host.host_id,
          claim_id: claimId,
          status: result?.status ?? null,
        });
        return false;
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestration — identical for both sources.
// ---------------------------------------------------------------------------

type MaterializeFailureCode =
  | 'claim_not_active'
  | 'claim_no_longer_active'
  | 'host_unreachable'
  | 'unsupported_artifact_kind'
  | 'content_unavailable'
  | 'unsafe_skill_name'
  | 'path_escape';

export type MaterializeOutcome =
  | { ok: true; artifactKind: 'skill'; path: string; skillName: string; generation: number; autoPublished: boolean }
  | { ok: false; code: MaterializeFailureCode };

/**
 * Republish auto-close (spec §2(c)): after a successful write, close the
 * claim through the branch's pinned mark-published path when the claim's own
 * generation matches the artifact's already-recorded `published_generation`
 * — this write republished already-published content unchanged. Never
 * throws and never turns a bookkeeping failure into a failed materialize
 * response (Step 2's failure posture): a `markPublished` false degrades to
 * `autoPublished: false`, leaving the claim `active` for the pre-existing
 * manual Mark-published flow or TTL expiry to close it instead.
 *
 * Log discipline: one warn per failure, at the point of detection. The
 * sources own the `markPublished`-false warn (they hold the failure's
 * specifics — dial status, DB error); this helper adds nothing on top of a
 * false return. Its own catch is its own detection point — the sources
 * contractually never throw, so it only fires for a source that breaks
 * that contract (e.g. a test seam), and warns because that path has no
 * other logger.
 */
async function attemptAutoClose(
  source: ClaimSource,
  logger: ProxyLogger,
  claimId: string,
  artifactKind: string,
  artifactId: string,
  generation: number,
): Promise<boolean> {
  try {
    const publishedGeneration = await source.getPublishedGeneration(artifactKind, artifactId);
    if (publishedGeneration !== generation) return false;
    return await source.markPublished(claimId);
  } catch (err) {
    logger.warn(
      'materialize: same-generation republish wrote to disk but the auto-close check threw; '
      + 'the claim stays active for the manual Mark-published flow or TTL expiry',
      {
        claim_id: claimId,
        artifact_kind: artifactKind,
        artifact_id: artifactId,
        generation,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return false;
  }
}

/**
 * Fetch claim + snapshot, re-assert the claim is still `active` immediately
 * before writing (spec §4 step 3 — closes the race where the claim
 * expires/is released/is reassigned between the fetch and the write; if it
 * fires between THIS check and the actual write below, the file still lands
 * — acceptable-by-design, git resolves it), then write through the two
 * existing chokepoints, in order: `writePublishedSkillFile` then
 * `syncPublishedSkillSymlinks` (`skills/publication.ts`, the same order
 * `skill-tools.ts`'s hostServed-gated wrappers encode).
 *
 * A claim whose `artifactKind` is not `skill` — including a surviving
 * pre-retirement `okf_page` row — falls through to `unsupported_artifact_kind`
 * without touching the filesystem; the row itself stays readable elsewhere in
 * the claim system (list/release/expiry), it simply cannot be materialized.
 *
 * After a successful write, {@link attemptAutoClose} runs the republish
 * auto-close check — the disk write is already committed by that point, so
 * its result never changes whether this function returns `ok: true`, only
 * the `autoPublished` flag carried on it.
 *
 * Exported as a test seam alongside {@link ClaimSource}.
 */
export async function materializeContentClaim(
  claimId: string,
  currentRoot: string,
  source: ClaimSource,
  logger: ProxyLogger,
): Promise<MaterializeOutcome> {
  const initial = await source.getActiveClaim(claimId);
  if (!initial) {
    // A down host on this FIRST check reads identically to a genuinely
    // inactive claim (both are `null`) unless the source can tell them
    // apart — distinguish so the caller doesn't get told to re-claim
    // (`claim_not_active`) when re-claiming would fail the same way.
    if (source.wasLastActiveClaimCheckHostUnreachable?.()) {
      return { ok: false, code: 'host_unreachable' };
    }
    return { ok: false, code: 'claim_not_active' };
  }

  if (initial.artifactKind === 'skill') {
    const content = await source.getSkillContent(initial.artifactId, initial.generation);
    if (!content) return { ok: false, code: 'content_unavailable' };

    const reasserted = await source.getActiveClaim(claimId);
    if (!reasserted) return { ok: false, code: 'claim_no_longer_active' };

    const written = writePublishedSkillFile(currentRoot, content.name, content.content);
    if (!written.ok) {
      return { ok: false, code: written.reason === 'unsafe_name' ? 'unsafe_skill_name' : 'path_escape' };
    }
    syncPublishedSkillSymlinks(currentRoot, content.name);
    const autoPublished = await attemptAutoClose(
      source,
      logger,
      claimId,
      initial.artifactKind,
      initial.artifactId,
      initial.generation,
    );
    return {
      ok: true,
      artifactKind: 'skill',
      path: written.paths.skillPath,
      skillName: content.name,
      generation: initial.generation,
      autoPublished,
    };
  }

  return { ok: false, code: 'unsupported_artifact_kind' };
}

function responseForOutcome(outcome: MaterializeOutcome): RouteResponse {
  if (outcome.ok) {
    return {
      status: 200,
      body: {
        ok: true,
        path: outcome.path,
        skill_name: outcome.skillName,
        generation: outcome.generation,
        auto_published: outcome.autoPublished,
      },
    };
  }
  switch (outcome.code) {
    case 'claim_not_active':
      return {
        status: 409,
        body: errorBody('claim_not_active', 'This claim is no longer active. Re-claim before materializing.'),
      };
    case 'host_unreachable':
      // Distinct from `claim_not_active` (409): the claim's real state is
      // unknown, not confirmed inactive, and re-claiming would fail the
      // identical way while the host stays down. 503 (not 409) — this is
      // upstream unavailability, not a conflict over the claim's state.
      return {
        status: 503,
        body: errorBody(
          'host_unreachable',
          'The Team Host could not be reached. Check your connection and try again.',
        ),
      };
    case 'claim_no_longer_active':
      return {
        status: 409,
        body: errorBody(
          'claim_no_longer_active',
          'The claim expired, was released, or was reassigned before the write. Re-claim and try again.',
        ),
      };
    case 'unsupported_artifact_kind':
      return {
        status: 400,
        body: errorBody('unsupported_artifact_kind', 'Only skill artifacts are materialized by this route.'),
      };
    case 'content_unavailable':
      return {
        status: 422,
        body: errorBody('content_unavailable', 'No content snapshot was found for the claimed generation.'),
      };
    case 'unsafe_skill_name':
      return {
        status: 400,
        body: errorBody('unsafe_skill_name', 'The skill name is not safe to materialize to disk.'),
      };
    case 'path_escape':
      return {
        status: 400,
        body: errorBody('path_escape', 'The resolved path escapes the published artifact root.'),
      };
  }
}

// ---------------------------------------------------------------------------
// Handler + registration
// ---------------------------------------------------------------------------

export interface ContentClaimMaterializeDeps {
  cache: GroveRuntimeCache;
  dial: Dialer;
  logger: ProxyLogger;
  /** This daemon's own machine id — the identity stamped on a local
   *  mark-published call (`publishedBy`/`machineId`) and sent as
   *  `REQUEST_CONTEXT_HEADERS.machineId` on the attached branch's
   *  mark-published dial, so the host's holder gate attributes the
   *  republish auto-close to the calling member, not itself. */
  machineId: string;
  mycoHome?: string;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

export function createContentClaimMaterializeHandler(deps: ContentClaimMaterializeDeps): RouteHandler {
  return async (req) => {
    const claimId = req.params.id;
    const body = asRecord(req.body);

    const context = await resolveMemberProjectContext(req, body, deps.mycoHome);
    if ('status' in context) {
      return context;
    }
    const { currentRoot, projectId } = context;

    if (context.source === 'attached') {
      const { attach } = context;
      let target: RemoteTarget;
      try {
        target = remoteTargetFor(assertGroveProjectId(projectId), attach);
      } catch {
        return { status: 404, body: errorBody('project_not_registered', `Malformed project id ${projectId}`) };
      }
      const source = remoteClaimSource(target, deps.dial, deps.logger, deps.machineId);
      const outcome = await materializeContentClaim(claimId, currentRoot, source, deps.logger);
      return responseForOutcome(outcome);
    }

    const { registered } = context;
    const db = deps.cache.getDatabase(resolveGroveDbPath(registered.grove.id, deps.mycoHome));
    let scope: ProjectScope;
    try {
      scope = projectScope(assertGroveProjectId(projectId));
    } catch {
      return { status: 404, body: errorBody('project_not_registered', `Malformed project id ${projectId}`) };
    }
    const source = localClaimSource(db, scope, deps.machineId, deps.logger);
    const outcome = await materializeContentClaim(claimId, currentRoot, source, deps.logger);
    return responseForOutcome(outcome);
  };
}

/** Register the materialize route on the daemon server. */
export function registerContentClaimMaterializeRoute(
  server: RouteRegistrar,
  deps: ContentClaimMaterializeDeps,
): void {
  server.registerRoute('POST', '/api/content-claims/:id/materialize', createContentClaimMaterializeHandler(deps));
}
