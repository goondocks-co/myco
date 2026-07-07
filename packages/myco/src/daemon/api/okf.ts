/**
 * Daemon HTTP surface for the OKF capability. Every route is `tenantRoute`-
 * wrapped at registration: the wrapper resolves + authorizes the principal
 * (rejecting missing tenancy with 400 `tenancy-violation`) BEFORE the handler
 * runs, so a handler never trusts "is requestContext present?" as
 * authorization. All routes funnel into the single `OkfBundle` capability;
 * typed `OkfError`s map to the frozen HTTP status set.
 *
 *   POST /api/okf/maintain
 *   GET  /api/okf/status
 *   POST /api/okf/validate
 *   GET  /api/okf/pages                (list — OKF document pages)
 *   GET  /api/okf/pages/*              (get — prefix route, slash-safe paths)
 *   POST /api/okf/concepts             (save — legacy editorial concept surface)
 *   POST /api/okf/concepts/supersede
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { RequestPrincipal } from '../request-principal.js';
import type { DaemonLogger } from '../logger.js';
import { tenantRoute } from './route-helpers.js';
import { errorBody } from './error-envelope.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { capabilityEnabled } from '@myco/config/capabilities.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { projectScope, type GroveProjectId, type ProjectScope } from '@myco/grove/ids.js';
import { OkfBundle } from '@myco/okf/bundle.js';
import { OkfError, OKF_ERROR_HTTP_STATUS } from '@myco/okf/errors.js';
import { scanStagedBundle } from '@myco/okf/publish-eligibility.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { OkfBundleInclude } from '@myco/okf/types.js';

const PAGES_PREFIX = '/api/okf/pages/';

interface OkfContext {
  bundle: OkfBundle;
  config: MycoConfig;
  projectRoot: string;
  vaultDir: string;
  scope: ProjectScope;
  machineId: string;
}

function contextFor(principal: RequestPrincipal): OkfContext {
  const vaultDir = principal.tenancy.projectVaultDir;
  const projectRoot = resolveProjectRoot(vaultDir);
  const config = loadMergedConfig(vaultDir, { groveId: principal.tenancy.groveId });
  const scope = projectScope(principal.tenancy.projectId as GroveProjectId);
  const bundle = new OkfBundle({
    projectRoot,
    vault: new ProjectVault(projectRoot),
    scope,
    projectId: principal.tenancy.projectId,
    machineId: principal.identity.machineId,
    config,
  });
  return { bundle, config, projectRoot, vaultDir, scope, machineId: principal.identity.machineId };
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

/** Validate the maintain body's include the way the CLI does; returns an error envelope or null. */
function validateMaintainBody(body: Record<string, unknown>): RouteResponse | null {
  if (body.include !== undefined) {
    const inc = body.include;
    const keysOk =
      inc !== null &&
      typeof inc === 'object' &&
      !Array.isArray(inc) &&
      Object.keys(inc as object).every((k) => ['spores', 'canopy', 'concepts', 'guides'].includes(k)) &&
      Object.values(inc as Record<string, unknown>).every((v) => typeof v === 'boolean');
    if (!keysOk) {
      return { status: 400, body: errorBody('invalid_request', 'include must be an object of {spores,canopy,concepts,guides}: boolean') };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Raw handlers — wrapped with tenantRoute at registration.
// ---------------------------------------------------------------------------

export async function handleOkfMaintain(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const ctx = contextFor(principal);
  const body = asRecord(req.body);
  const invalid = validateMaintainBody(body);
  if (invalid) return invalid;
  try {
    const result = await ctx.bundle.maintain({
      scope: ctx.scope,
      projectRoot: ctx.projectRoot,
      machineId: ctx.machineId,
      mode: 'published',
      include: body.include as OkfBundleInclude | undefined,
      // sporeStatus/includeUndescribedCanopy have no document-model
      // equivalent (Task 4.2 retired the Myco-shaped include surface) —
      // fixed constants matching OkfMaintainSchema's old defaults, not
      // read from the request body.
      sporeStatus: 'active',
      includeUndescribedCanopy: false,
      outputRoot: typeof body.outputRoot === 'string' ? body.outputRoot : undefined,
      dryRun: body.dryRun === true,
      oneShot: body.oneShot === true,
      allowExternalOutput: typeof body.outputRoot === 'string',
      overwrite: body.overwrite === true,
      acknowledgePublish: body.acknowledgePublish === true,
    });
    return { status: 200, body: { ok: true, result } };
  } catch (err) {
    return okfErrorResponse(err);
  }
}

export async function handleOkfStatus(_req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const ctx = contextFor(principal);
  try {
    const status = ctx.bundle.status();
    const enabled = capabilityEnabled(ctx.config, 'okf');
    const outputPath = ctx.config.okf.maintain.output_path;

    let validation: { ok: boolean; level: string; filesChecked: number; conceptsChecked: number } | null = null;
    const publishFindings = status.bundleExists ? scanStagedBundle(status.outputRoot) : [];
    if (status.bundleExists) {
      const report = ctx.bundle.validate(status.outputRoot);
      validation = {
        ok: report.ok,
        level: report.level,
        filesChecked: report.filesChecked,
        conceptsChecked: report.conceptsChecked,
      };
    }

    // AGENTS.md pointer state (managed block reflects the reconciler's view).
    const pointerExpected = enabled && ctx.config.okf.maintain.managed_agents_md_pointer !== false;
    let pointerPresent = false;
    try {
      const agents = fs.readFileSync(path.join(ctx.projectRoot, 'AGENTS.md'), 'utf8');
      pointerPresent = agents.includes(`${outputPath.replace(/\/+$/, '')}/index.md`);
    } catch {
      pointerPresent = false;
    }

    return {
      status: 200,
      body: {
        ...status,
        enabled,
        outputPath,
        validation,
        agentsPointer: { present: pointerPresent, stale: pointerPresent !== pointerExpected },
        publishEligibility: {
          // `ok` means "a repo-visible publish is NOT blocked" — i.e. every
          // current finding is already acknowledged. It is NOT "zero findings"
          // (see `findings` for the raw list). Plan 7 renders `ok` as the
          // publishable state and `findings` as the reviewable detail.
          ok: status.publishAcknowledged,
          findings: publishFindings.map((f) => ({ code: f.code, path: f.path, excerpt: f.excerpt })),
        },
        lastRun: null, // filled by Plan 6 (okf-maintain task) from agent_runs
      },
    };
  } catch (err) {
    return okfErrorResponse(err);
  }
}

export async function handleOkfValidate(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const ctx = contextFor(principal);
  const body = asRecord(req.body);
  const target = typeof body.path === 'string' ? path.resolve(ctx.projectRoot, body.path) : undefined;
  try {
    return { status: 200, body: { ok: true, validation: ctx.bundle.validate(target) } };
  } catch (err) {
    return okfErrorResponse(err);
  }
}

/** List published OKF document pages — the document-model read primitive behind the knowledge browser (Task 5.1). */
export async function handleOkfPagesList(_req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const ctx = contextFor(principal);
  return { status: 200, body: { ok: true, pages: ctx.bundle.listPages() } };
}

/** Get one published OKF document page's frontmatter fields + rendered-markdown body, by bundle-relative path. */
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
  const page = ctx.bundle.getPage(pagePath);
  return { status: 200, body: { ok: true, page } };
}

export async function handleOkfConceptSave(req: RouteRequest, principal: RequestPrincipal): Promise<RouteResponse> {
  const ctx = contextFor(principal);
  const body = asRecord(req.body);
  if (typeof body.id !== 'string' || typeof body.markdown !== 'string') {
    return { status: 400, body: errorBody('invalid_request', 'id and markdown are required') };
  }
  try {
    const result = await ctx.bundle.saveConcept({
      id: body.id,
      markdown: body.markdown,
      expectedGeneration: typeof body.expectedGeneration === 'number' ? body.expectedGeneration : undefined,
      provenance: { actor: 'cli' },
    });
    return { status: 200, body: { ok: true, ...result } };
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
    const result = await ctx.bundle.supersedeConcept({
      oldId: body.oldId,
      newId: body.newId,
      reason: body.reason,
      provenance: { actor: 'cli' },
    });
    return { status: 200, body: { ok: true, ...result } };
  } catch (err) {
    return okfErrorResponse(err);
  }
}

/** Register every OKF route on the daemon server, tenancy-wrapped. */
export function registerOkfRoutes(
  server: { registerRoute(method: string, routePath: string, handler: (req: RouteRequest) => Promise<RouteResponse>): void },
  tenant: { machineId: string; logger: DaemonLogger },
): void {
  server.registerRoute('POST', '/api/okf/maintain', tenantRoute(tenant, handleOkfMaintain));
  server.registerRoute('GET', '/api/okf/status', tenantRoute(tenant, handleOkfStatus));
  server.registerRoute('POST', '/api/okf/validate', tenantRoute(tenant, handleOkfValidate));
  server.registerRoute('GET', '/api/okf/pages', tenantRoute(tenant, handleOkfPagesList));
  server.registerRoute('POST', '/api/okf/concepts', tenantRoute(tenant, handleOkfConceptSave));
  server.registerRoute('POST', '/api/okf/concepts/supersede', tenantRoute(tenant, handleOkfConceptSupersede));
  server.registerRoute('GET', '/api/okf/pages/*', tenantRoute(tenant, handleOkfPageGet));
}
