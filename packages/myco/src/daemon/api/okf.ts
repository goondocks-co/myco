/**
 * OKF daemon API — the HTTP surface over the DB-resident wiki, wrapped in
 * tenancy authorization. All writes funnel into the single `OkfStore`
 * capability; reads come from the okf query layer; typed `OkfError`s map to
 * the frozen HTTP status set.
 *
 *   POST /api/okf/acknowledge
 *   GET  /api/okf/status
 *   POST /api/okf/validate
 *   GET  /api/okf/pages                (list — wiki page heads)
 *   GET  /api/okf/pages/*              (get — prefix route, slash-safe paths)
 *   GET  /api/okf/pages/by-id/:id      (get by okf_pages.id — revision history)
 *   POST /api/okf/concepts             (save — editorial authored-page surface)
 *   POST /api/okf/concepts/supersede
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RouteRequest, RouteResponse, RouteRegistrar } from '../router.js';
import type { RequestPrincipal } from '../request-principal.js';
import type { DaemonLogger } from '../logger.js';
import { tenantRoute } from './route-helpers.js';
import { errorBody } from './error-envelope.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { capabilityEnabled } from '@myco/config/capabilities.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import { projectScope, type GroveProjectId, type ProjectScope } from '@myco/grove/ids.js';
import { OkfStore } from '@myco/okf/store.js';
import { OkfError, OKF_ERROR_HTTP_STATUS } from '@myco/okf/errors.js';
import { validateWikiRows } from '@myco/okf/validate.js';
import { parseConceptDoc } from '@myco/okf/frontmatter.js';
import {
  latestOkfGeneration,
  latestRevisionForPage,
  listOkfPages,
  listRevisionsForPage,
  getOkfPageByPath,
  getOkfPageById,
} from '@myco/db/queries/okf.js';
import type { MycoConfig } from '@myco/config/schema.js';

const PAGES_PREFIX = '/api/okf/pages/';

interface OkfContext {
  store: OkfStore;
  config: MycoConfig;
  projectRoot: string;
  vaultDir: string;
  scope: ProjectScope;
  machineId: string;
}

function contextFor(principal: RequestPrincipal): OkfContext {
  const vaultDir = principal.tenancy.projectVaultDir;
  const projectRoot = resolveProjectRoot(vaultDir);
  // A Team Host serving this project for a member has no local working
  // tree — the checkout lives on the member's machine. Degrade to
  // machine+grove tiers (empty project tier) instead of throwing "myco.yaml
  // not found", the same signal + mechanism `task-scheduling.ts` and
  // `power-jobs.ts` use for the identical served-project shape.
  const treeAvailable = fs.existsSync(projectRoot);
  const config = loadMergedConfig(vaultDir, {
    groveId: principal.tenancy.groveId,
    projectTierOptional: !treeAvailable,
  });
  const scope = projectScope(principal.tenancy.projectId as GroveProjectId);
  const store = new OkfStore({
    scope,
    projectId: principal.tenancy.projectId,
    machineId: principal.identity.machineId,
    config,
  });
  return { store, config, projectRoot, vaultDir, scope, machineId: principal.identity.machineId };
}

/** Map a thrown OkfError to its frozen HTTP envelope; rethrow anything else. */
function okfErrorResponse(err: unknown): RouteResponse {
  if (err instanceof OkfError) {
    return {
      status: OKF_ERROR_HTTP_STATUS[err.code],
      body: { ...errorBody(err.code, err.message), ...(err.details ? { details: err.details } : {}) },
    };
  }
  throw err;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

/**
 * The on-disk CLAIMED bundle probe — a plain marker check, never an OkfBundle
 * construction. True when a user has materialized the wiki into the repo
 * (e.g. this repository's committed `okf/`); drives claim-conditional UI
 * affordances (Open in VS Code, the AGENTS.md pointer expectation).
 */
function claimedBundleExists(projectRoot: string, outputPath: string): boolean {
  return fs.existsSync(path.join(projectRoot, outputPath.replace(/\/+$/, ''), 'index.md'));
}

/** Current wiki rows (active heads + their latest revisions) for validation. */
function currentWikiRows(ctx: OkfContext): Array<{ path: string; frontmatter: Record<string, unknown>; body: string }> {
  const rows: Array<{ path: string; frontmatter: Record<string, unknown>; body: string }> = [];
  for (const head of listOkfPages(ctx.scope, 'active')) {
    const revision = latestRevisionForPage(head.id);
    if (!revision) continue;
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = JSON.parse(revision.frontmatter) as Record<string, unknown>;
    } catch {
      frontmatter = { type: head.type };
    }
    rows.push({ path: head.path, frontmatter, body: revision.body });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Raw handlers — wrapped with tenantRoute at registration.
// ---------------------------------------------------------------------------

export async function handleOkfStatus(_req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const ctx = contextFor(principal);
  try {
    const enabled = capabilityEnabled(ctx.config, 'okf');
    const outputPath = ctx.config.okf.maintain.output_path;
    const pages = listOkfPages(ctx.scope, 'active');
    const published = latestOkfGeneration(ctx.scope, ['published']);
    const latest = latestOkfGeneration(ctx.scope);

    let validation: { ok: boolean; level: string; filesChecked: number; conceptsChecked: number } | null = null;
    if (pages.length > 0) {
      const report = validateWikiRows(currentWikiRows(ctx));
      validation = {
        ok: report.ok,
        level: report.level,
        filesChecked: report.filesChecked,
        conceptsChecked: report.conceptsChecked,
      };
    }

    const byType: Record<string, number> = {};
    for (const page of pages) byType[page.type] = (byType[page.type] ?? 0) + 1;

    // AGENTS.md pointer state. The pointer is only EXPECTED once a claimed
    // on-disk bundle exists — a DB-only wiki has nothing in the repo for
    // other agents to read yet (claim-flow scope).
    const claimed = claimedBundleExists(ctx.projectRoot, outputPath);
    const pointerExpected = enabled && claimed && ctx.config.okf.maintain.managed_agents_md_pointer !== false;
    let pointerPresent = false;
    try {
      const agents = fs.readFileSync(path.join(ctx.projectRoot, 'AGENTS.md'), 'utf8');
      pointerPresent = agents.includes(`${outputPath.replace(/\/+$/, '')}/index.md`);
    } catch {
      pointerPresent = false;
    }

    // A blocked LATEST generation is the one publish-block state: its
    // findings drive the load-time banner, and acknowledge flips it.
    const blocked = latest?.status === 'blocked' ? latest : null;
    let pendingFindings: Array<{ code: string; path: string; hash?: string }> = [];
    if (blocked) {
      try {
        pendingFindings = JSON.parse(blocked.findings) as Array<{ code: string; path: string; hash?: string }>;
      } catch {
        pendingFindings = [];
      }
    }

    return {
      status: 200,
      body: {
        outputRoot: path.resolve(ctx.projectRoot, outputPath),
        bundleExists: pages.length > 0,
        claimedBundleExists: claimed,
        bundleGeneration: published?.generation ?? null,
        inputsHash: published?.inputs_hash || null,
        generatedAt: published ? new Date(published.updated_at * 1000).toISOString() : null,
        lastResult: latest ? latest.status : null,
        byType: pages.length > 0 ? byType : null,
        pageCount: pages.length > 0 ? pages.length : null,
        publishAcknowledged: !blocked,
        pendingFindings,
        enabled,
        outputPath,
        validation,
        agentsPointer: { present: pointerPresent, stale: pointerPresent !== pointerExpected },
        publishEligibility: {
          // `ok` means "nothing is blocked awaiting acknowledgement" — the
          // latest generation is published (or nothing has run yet).
          ok: !blocked,
          findings: pendingFindings.map((f) => ({ code: f.code, path: f.path, excerpt: '' })),
        },
        lastRun: null, // filled from agent_runs once the okf-synthesize task reports its own run history
      },
    };
  } catch (err) {
    return okfErrorResponse(err);
  }
}

/**
 * Acknowledge the latest blocked wiki generation and publish it — the content
 * is already synthesized as durable rows, so acknowledging means ship, not
 * run-again. Returns the published generation number, or published:false when
 * nothing was blocked.
 */
export async function handleOkfAcknowledge(_req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const ctx = contextFor(principal);
  try {
    const published = ctx.store.acknowledge();
    return {
      status: 200,
      body: {
        ok: true,
        published: published !== null,
        ...(published ? { generation: published.generation, pageCount: published.page_count } : {}),
      },
    };
  } catch (err) {
    return okfErrorResponse(err);
  }
}

export async function handleOkfValidate(_req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const ctx = contextFor(principal);
  try {
    return { status: 200, body: { ok: true, validation: validateWikiRows(currentWikiRows(ctx)) } };
  } catch (err) {
    return okfErrorResponse(err);
  }
}

/** List wiki page heads — the read primitive behind the UI structure tree. */
export async function handleOkfPagesList(_req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const ctx = contextFor(principal);
  const pages = listOkfPages(ctx.scope, 'active').map((p) => {
    let tags: string[];
    try {
      tags = JSON.parse(p.tags) as string[];
    } catch {
      tags = [];
    }
    return {
      path: p.path,
      type: p.type,
      title: p.title,
      description: p.description,
      tags,
      timestamp: new Date(p.updated_at * 1000).toISOString(),
    };
  });
  return { status: 200, body: { ok: true, pages } };
}

/**
 * One wiki page's identity plus its full `page_generation` revision history,
 * by `okf_pages.id` — a claim's `artifact_id` is this id, not the bundle
 * path (`db/queries/okf.ts`'s `getOkfPageById` doc comment). This is the
 * content-claim materialize path's remote content-fetch surface for a
 * pinned generation (design §4): an attached member dials this route and
 * picks the claimed generation out of `revisions` client-side, the same
 * shape `GET /api/skill-records/:id`'s `lineage` array gives skills.
 */
export async function handleOkfPageRevisionsById(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const ctx = contextFor(principal);
  const page = getOkfPageById(ctx.scope, req.params.id);
  if (!page) return { status: 404, body: errorBody('not_found', `Not found: ${req.params.id}`) };
  const revisions = listRevisionsForPage(ctx.scope, page.id).map((r) => ({
    page_generation: r.page_generation,
    frontmatter: r.frontmatter,
    body: r.body,
  }));
  return { status: 200, body: { ok: true, path: page.path, title: page.title, revisions } };
}

/** Get one wiki page's frontmatter fields + markdown body, by bundle-relative path. */
export async function handleOkfPageGet(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const ctx = contextFor(principal);
  if (!req.pathname.startsWith(PAGES_PREFIX)) {
    return { status: 400, body: errorBody('invalid_request', 'malformed page path') };
  }
  let pagePath: string;
  try {
    pagePath = decodeURIComponent(req.pathname.slice(PAGES_PREFIX.length));
  } catch {
    return { status: 400, body: errorBody('invalid_request', 'undecodable page path') };
  }
  const page = ctx.store.readPage(pagePath);
  if (!page) return { status: 200, body: { ok: true, page: null } };
  const fm = page.frontmatter as Record<string, unknown>;
  return {
    status: 200,
    body: {
      ok: true,
      page: {
        path: page.path,
        type: typeof fm.type === 'string' ? fm.type : 'note',
        title: typeof fm.title === 'string' ? fm.title : undefined,
        description: typeof fm.description === 'string' ? fm.description : undefined,
        timestamp: typeof fm.timestamp === 'string' ? fm.timestamp : undefined,
        body: page.body,
      },
    },
  };
}

export async function handleOkfConceptSave(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const ctx = contextFor(principal);
  const body = asRecord(req.body);
  if (typeof body.id !== 'string' || typeof body.markdown !== 'string') {
    return { status: 400, body: errorBody('invalid_request', 'id and markdown are required') };
  }
  try {
    // Optimistic concurrency: the caller pins the published generation it
    // read; a mismatch means the wiki moved underneath the edit.
    if (typeof body.expectedGeneration === 'number') {
      const current = latestOkfGeneration(ctx.scope, ['published'])?.generation ?? null;
      if (current !== null && current !== body.expectedGeneration) {
        throw new OkfError('okf_generation_conflict', `wiki is at generation ${current}, caller expected ${body.expectedGeneration}`);
      }
    }
    const { frontmatter, body: pageBody } = parseConceptDoc(body.markdown);
    const result = ctx.store.writeAuthoredPage({
      path: body.id,
      type: typeof frontmatter.type === 'string' ? frontmatter.type : 'concept',
      title: typeof frontmatter.title === 'string' ? frontmatter.title : body.id,
      description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
      body: pageBody,
      tags: Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : undefined,
    });
    return {
      status: 200,
      body: {
        ok: true,
        status: result.status,
        generation: result.generation.generation,
        findings: result.findings,
      },
    };
  } catch (err) {
    return okfErrorResponse(err);
  }
}

export async function handleOkfConceptSupersede(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const ctx = contextFor(principal);
  const body = asRecord(req.body);
  if (typeof body.oldId !== 'string' || typeof body.newId !== 'string' || typeof body.reason !== 'string') {
    return { status: 400, body: errorBody('invalid_request', 'oldId, newId, and reason are required') };
  }
  try {
    const result = ctx.store.supersedePage(body.oldId, body.newId, body.reason);
    return { status: 200, body: { ok: true, ...result } };
  } catch (err) {
    return okfErrorResponse(err);
  }
}

/** Register every OKF route on the daemon server, tenancy-wrapped. */
export function registerOkfRoutes(
  server: RouteRegistrar,
  tenant: { machineId: string; logger: DaemonLogger },
): void {
  server.registerRoute('POST', '/api/okf/acknowledge', tenantRoute(tenant, handleOkfAcknowledge));
  server.registerRoute('GET', '/api/okf/status', tenantRoute(tenant, handleOkfStatus));
  server.registerRoute('POST', '/api/okf/validate', tenantRoute(tenant, handleOkfValidate));
  server.registerRoute('GET', '/api/okf/pages', tenantRoute(tenant, handleOkfPagesList));
  server.registerRoute('POST', '/api/okf/concepts', tenantRoute(tenant, handleOkfConceptSave));
  server.registerRoute('POST', '/api/okf/concepts/supersede', tenantRoute(tenant, handleOkfConceptSupersede));
  server.registerRoute('GET', '/api/okf/pages/by-id/:id', tenantRoute(tenant, handleOkfPageRevisionsById));
  server.registerRoute('GET', '/api/okf/pages/*', tenantRoute(tenant, handleOkfPageGet));
}

/** Wildcard route helper — exported for tests that build page paths. */
export const OKF_PAGES_ROUTE_PREFIX = PAGES_PREFIX;
