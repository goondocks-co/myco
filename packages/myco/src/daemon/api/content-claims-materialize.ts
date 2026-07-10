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
 * One `dialHostJson` transport backs every remote read below (skill content,
 * OKF content) — a second one must never be added.
 *
 * Two artifact kinds write through the SAME orchestration (spec §0: "one
 * mechanism, unified across skills + OKF + kin"): `skill` runs the two
 * existing chokepoints in `skills/publication.ts`; `okf_page` runs the new
 * `okf/materialize.ts` writer, resolving its published-wiki destination root
 * from the member's own project-tier config (`config.okf.maintain.output_path`
 * — VCS-tracked, so it reads identically whether the project is local or
 * attached; only the grove tier the merged read also touches needs a host
 * fetch, via the same `fetchHostGroveConfig` `attached-config.ts` uses).
 */
import http from 'node:http';
import path from 'node:path';

import {
  HOST_PROTOCOL_HEADER,
  HOST_PROTOCOL_VERSION,
  HOST_PROXY_CONNECT_TIMEOUT_MS,
  HOST_PROXY_HEADERS_TIMEOUT_MS,
  HOST_PROXY_MAX_BUFFERED_BODY_BYTES,
} from '@myco/constants.js';
import { loadMergedConfig, loadAttachedMergedConfig } from '@myco/config/loader.js';
import { withDatabase, type Database } from '@myco/db/client.js';
import { getContentClaimById } from '@myco/db/queries/content-claims.js';
import { getSkillContentAtGeneration } from '@myco/db/queries/skill-lineage.js';
import { getSkillRecord } from '@myco/db/queries/skill-records.js';
import { getOkfPageById, getOkfPageRevisionAtGeneration } from '@myco/db/queries/okf.js';
import { assertGroveProjectId, projectScope, type ProjectScope } from '@myco/grove/ids.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { REQUEST_CONTEXT_HEADERS } from '@myco/grove/request-context.js';
import { remoteTargetFor, type RemoteTarget } from '@myco/host/routing.js';
import { writePublishedSkillFile, syncPublishedSkillSymlinks } from '@myco/skills/publication.js';
import { materializeOkfPage, type OkfPageContent } from '@myco/okf/materialize.js';
import type { PublishFinding } from '@myco/okf/publish-eligibility.js';
import { fetchHostGroveConfig } from '../attached-config.js';
import type { GroveRuntimeCache } from '../grove-runtime-cache.js';
import type { Dialer, ProxyLogger } from '../host-proxy.js';
import type { RouteHandler, RouteRegistrar, RouteResponse } from '../router.js';
import { errorBody } from './error-envelope.js';
import { resolveMemberProjectContext } from './member-project-context.js';

/** OKF's project-tier default (`config/schema.ts`'s `OkfMaintainSchema.output_path`),
 *  repeated here only as the fallback when config cannot be resolved at all —
 *  a missing/corrupt myco.yaml must degrade the published root, never fail
 *  the whole materialize request over an unrelated config read. */
const OKF_DEFAULT_OUTPUT_PATH = 'okf';

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
  getSkillContent(artifactId: string, generation: number): Promise<SkillContent | null>;
  getOkfPageContent(artifactId: string, generation: number): Promise<OkfPageContent | null>;
}

function localClaimSource(db: Database, scope: ProjectScope): ClaimSource {
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
    async getOkfPageContent(artifactId, generation) {
      return withDatabase(db, () => {
        const page = getOkfPageById(scope, artifactId);
        if (!page) return null;
        const revision = getOkfPageRevisionAtGeneration(page.id, generation);
        return revision ? { path: page.path, frontmatter: revision.frontmatter, body: revision.body } : null;
      });
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
}

interface SkillRecordBody {
  name?: string;
  lineage?: Array<{ generation: number; content_snapshot: string }>;
}

interface OkfPageRevisionsBody {
  path?: string;
  revisions?: Array<{ page_generation: number; frontmatter: string; body: string }>;
}

/**
 * One-shot GET against the host over the overlay, returning the parsed JSON
 * body alongside the status code — or null on any transport failure
 * (unreachable, timeout, oversized, unparseable). Deliberately does not
 * special-case non-2xx: callers need to see a 404 body (e.g. a deleted skill
 * record) to render the right materialize failure, not have it degrade
 * silently the way a config read (which always has a sane default) does.
 */
function dialHostJson<T>(
  target: RemoteTarget,
  pathname: string,
  dial: Dialer,
): Promise<{ status: number; body: T } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: { status: number; body: T } | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let dialed: http.ClientRequest | Promise<http.ClientRequest>;
    try {
      dialed = dial(target, {
        method: 'GET',
        path: pathname,
        headers: {
          authorization: `Bearer ${target.bearer}`,
          [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
          [REQUEST_CONTEXT_HEADERS.groveId]: target.groveId,
          [REQUEST_CONTEXT_HEADERS.projectId]: target.projectId,
          accept: 'application/json',
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
      proxyReq.end();
    }).catch(() => done(null));
  });
}

function remoteClaimSource(target: RemoteTarget, dial: Dialer, logger: ProxyLogger): ClaimSource {
  return {
    async getActiveClaim(claimId) {
      const result = await dialHostJson<ContentClaimsListBody>(target, '/api/content-claims', dial);
      if (!result) {
        logger.warn('materialize: host unreachable while checking claim state', {
          host_id: target.host.host_id,
          claim_id: claimId,
        });
        return null;
      }
      if (result.status !== 200) return null;
      const claim = result.body.active_claims?.find((c) => c.id === claimId);
      if (!claim || claim.state !== 'active') return null;
      return {
        id: claim.id,
        artifactKind: claim.artifact_kind,
        artifactId: claim.artifact_id,
        generation: claim.generation,
      };
    },
    async getSkillContent(artifactId, generation) {
      const result = await dialHostJson<SkillRecordBody>(
        target,
        `/api/skill-records/${encodeURIComponent(artifactId)}`,
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
      const snapshot = result.body.lineage?.find((l) => l.generation === generation)?.content_snapshot;
      return snapshot ? { name: result.body.name, content: snapshot } : null;
    },
    async getOkfPageContent(artifactId, generation) {
      const result = await dialHostJson<OkfPageRevisionsBody>(
        target,
        `/api/okf/pages/by-id/${encodeURIComponent(artifactId)}`,
        dial,
      );
      if (!result) {
        logger.warn('materialize: host unreachable while fetching okf page content', {
          host_id: target.host.host_id,
          artifact_id: artifactId,
        });
        return null;
      }
      if (result.status !== 200 || !result.body.path) return null;
      const revision = result.body.revisions?.find((r) => r.page_generation === generation);
      return revision ? { path: result.body.path, frontmatter: revision.frontmatter, body: revision.body } : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestration — identical for both sources.
// ---------------------------------------------------------------------------

type MaterializeFailureCode =
  | 'claim_not_active'
  | 'claim_no_longer_active'
  | 'unsupported_artifact_kind'
  | 'content_unavailable'
  | 'unsafe_skill_name'
  | 'path_escape'
  | 'render_failed'
  | 'scan_blocked';

export type MaterializeOutcome =
  | { ok: true; artifactKind: 'skill'; path: string; skillName: string; generation: number }
  | { ok: true; artifactKind: 'okf_page'; path: string; pagePath: string; generation: number }
  | { ok: false; code: Exclude<MaterializeFailureCode, 'scan_blocked'> }
  | { ok: false; code: 'scan_blocked'; findings: PublishFinding[] };

/**
 * Resolve the member's published-wiki root for an OKF write:
 * `<currentRoot>/<config.okf.maintain.output_path>`. `output_path` is
 * project-tier (VCS-tracked — `config/schema.ts`'s `ProjectConfigSchema`),
 * so it reads identically for a local or an attached project; only the
 * merged read's grove tier differs — LOCAL resolves it from this machine's
 * own Grove file, ATTACHED fetches it from the host via the same
 * `fetchHostGroveConfig` `attached-config.ts` uses (no second dial
 * transport). Any resolution failure (missing/corrupt myco.yaml, host
 * unreachable for the grove tier) degrades to the schema default rather
 * than failing the whole materialize request over a config read that is
 * orthogonal to whether the claimed content exists.
 */
async function resolveOkfPublishedRoot(
  currentRoot: string,
  loadConfig: () => Promise<{ okf: { maintain: { output_path: string } } }>,
  logger: ProxyLogger,
): Promise<string> {
  try {
    const config = await loadConfig();
    return path.resolve(currentRoot, config.okf.maintain.output_path);
  } catch (err) {
    logger.warn('materialize: falling back to the default published OKF wiki path', {
      error: err instanceof Error ? err.message : String(err),
    });
    return path.resolve(currentRoot, OKF_DEFAULT_OUTPUT_PATH);
  }
}

/**
 * Fetch claim + snapshot, re-assert the claim is still `active` immediately
 * before writing (spec §4 step 3 — closes the race where the claim
 * expires/is released/is reassigned between the fetch and the write; if it
 * fires between THIS check and the actual write below, the file still lands
 * — acceptable-by-design, git resolves it), then write through the ONE
 * disk-writing path for the claimed artifact kind:
 *
 *   - `skill`    — the two existing chokepoints, in order: `writePublishedSkillFile`
 *                  then `syncPublishedSkillSymlinks` (`skills/publication.ts`, the
 *                  same order `skill-tools.ts`'s hostServed-gated wrappers encode).
 *   - `okf_page` — `okf/materialize.ts`'s `materializeOkfPage`, the one
 *                  file-writing code path for DB-resident OKF content (spec §4 step 5).
 *
 * `resolveOkfPublishedRoot` is lazy (called only for an `okf_page` claim) so
 * a skill materialize never pays for a config read it doesn't need.
 *
 * Exported as a test seam alongside {@link ClaimSource}.
 */
export async function materializeContentClaim(
  claimId: string,
  currentRoot: string,
  source: ClaimSource,
  resolveOkfPublishedRootFn: () => Promise<string>,
): Promise<MaterializeOutcome> {
  const initial = await source.getActiveClaim(claimId);
  if (!initial) return { ok: false, code: 'claim_not_active' };

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
    return {
      ok: true,
      artifactKind: 'skill',
      path: written.paths.skillPath,
      skillName: content.name,
      generation: initial.generation,
    };
  }

  if (initial.artifactKind === 'okf_page') {
    const content = await source.getOkfPageContent(initial.artifactId, initial.generation);
    if (!content) return { ok: false, code: 'content_unavailable' };

    const reasserted = await source.getActiveClaim(claimId);
    if (!reasserted) return { ok: false, code: 'claim_no_longer_active' };

    const publishedRoot = await resolveOkfPublishedRootFn();
    const written = materializeOkfPage(publishedRoot, content);
    if (!written.ok) {
      return written.reason === 'scan_blocked'
        ? { ok: false, code: 'scan_blocked', findings: written.findings }
        : { ok: false, code: written.reason };
    }
    return {
      ok: true,
      artifactKind: 'okf_page',
      path: written.absolutePath,
      pagePath: written.relativePath,
      generation: initial.generation,
    };
  }

  return { ok: false, code: 'unsupported_artifact_kind' };
}

function responseForOutcome(outcome: MaterializeOutcome): RouteResponse {
  if (outcome.ok) {
    return outcome.artifactKind === 'skill'
      ? {
          status: 200,
          body: { ok: true, path: outcome.path, skill_name: outcome.skillName, generation: outcome.generation },
        }
      : {
          status: 200,
          body: { ok: true, path: outcome.path, page_path: outcome.pagePath, generation: outcome.generation },
        };
  }
  switch (outcome.code) {
    case 'claim_not_active':
      return {
        status: 409,
        body: errorBody('claim_not_active', 'This claim is no longer active. Re-claim before materializing.'),
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
        body: errorBody('unsupported_artifact_kind', 'Only skill and okf_page artifacts are materialized by this route.'),
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
    case 'render_failed':
      return {
        status: 422,
        body: errorBody('render_failed', 'The claimed OKF revision could not be rendered to a published document.'),
      };
    case 'scan_blocked':
      return {
        status: 422,
        body: {
          ...errorBody('scan_blocked', 'The publish-eligibility scan found a blocking issue; nothing was written.'),
          findings: outcome.findings,
        },
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
      const source = remoteClaimSource(target, deps.dial, deps.logger);
      const outcome = await materializeContentClaim(claimId, currentRoot, source, () =>
        resolveOkfPublishedRoot(
          currentRoot,
          () =>
            loadAttachedMergedConfig(resolveProjectVaultDir(currentRoot), {
              mycoHome: deps.mycoHome,
              fetchGroveDoc: async () => (await fetchHostGroveConfig(target, deps.dial, deps.logger)).doc,
            }),
          deps.logger,
        ));
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
    const source = localClaimSource(db, scope);
    const outcome = await materializeContentClaim(claimId, currentRoot, source, () =>
      resolveOkfPublishedRoot(
        currentRoot,
        async () =>
          loadMergedConfig(resolveProjectVaultDir(currentRoot), {
            groveId: registered.grove.id,
            mycoHome: deps.mycoHome,
            projectTierOptional: true,
          }),
        deps.logger,
      ));
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
