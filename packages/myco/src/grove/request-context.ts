import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { getMachineId } from '@myco/machine-id.js';
import { vaultDbPath } from '@myco/db/client.js';
import { loadProjectManifest, type ProjectManifest } from '@myco/config/project-manifest.js';
import {
  assertGroveProjectId,
  GLOBAL_SCOPE,
  projectScope,
  type GroveProjectId,
  type ProjectScope,
} from '@myco/grove/ids.js';
import { resolveGroveDbPath, resolveMycoHome, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { findRegisteredProject, loadGroveRecord } from '@myco/grove/registry.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';

export const REQUEST_CONTEXT_HEADERS = {
  projectRoot: 'x-myco-project-root',
  projectId: 'x-myco-project-id',
  groveId: 'x-myco-grove-id',
  machineId: 'x-myco-machine-id',
  sessionId: 'x-myco-session-id',
  /**
   * Caller's actual cwd (per-request, free-form). Distinct from
   * `x-myco-project-root` which is the canonical/registered project
   * root and validated against the Grove registry. `callerRoot`
   * represents "where the user is right now" — typically a git
   * worktree path that differs from the registered main tree — and
   * is preserved through resolution untouched. Filesystem ops that
   * should follow the caller (plan watch dirs, plan source path
   * keys, live Canopy tool paths) use `filesystemRootFromRequestContext`.
   */
  callerRoot: 'x-myco-caller-root',
} as const;

export const REQUEST_CONTEXT_ENV = {
  projectRoot: 'MYCO_PROJECT_ROOT',
  projectId: 'MYCO_PROJECT_ID',
  groveId: 'MYCO_GROVE_ID',
  machineId: 'MYCO_MACHINE_ID',
  sessionId: 'MYCO_SESSION_ID',
  callerRoot: 'MYCO_CALLER_ROOT',
} as const;

/**
 * Header name for the daemon-issued bearer token that gates
 * context-switching requests. The daemon mints this token at startup
 * and exports it via `MYCO_DAEMON_AUTH` so spawned children inherit
 * it; any local process that did not inherit it cannot redirect a
 * request at a different Grove or project than its inherited context
 * already implies.
 *
 * @see RequestContextAuthOptions for the resolver-side enforcement.
 */
export const REQUEST_CONTEXT_AUTH_HEADER = 'x-myco-auth';
export const REQUEST_CONTEXT_AUTH_ENV = 'MYCO_DAEMON_AUTH';

/**
 * Header keys that, when present, switch the request's effective
 * (Grove, project) scope away from the daemon's bootstrap context.
 * If a request carries any of these, the auth gate must verify the
 * caller knows the daemon's bearer token; otherwise a hostile local
 * process could pick which Grove to act against.
 */
const CONTEXT_SWITCHING_HEADERS = [
  REQUEST_CONTEXT_HEADERS.projectRoot,
  REQUEST_CONTEXT_HEADERS.projectId,
  REQUEST_CONTEXT_HEADERS.groveId,
] as const;

/**
 * Thrown when context-switching headers arrive without a valid
 * `x-myco-auth` bearer. Rejected at the transport boundary so handlers
 * can return a 401 (or 403) without ever materializing the spoofed
 * context.
 */
export class UnauthorizedRequestContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedRequestContextError';
  }
}

export interface RequestContextAuthOptions {
  /**
   * Daemon-issued bearer token. When provided, any request that carries
   * a context-switching header (`x-myco-project-root`,
   * `x-myco-grove-id`, or `x-myco-project-id`) must present a matching
   * `x-myco-auth` header.
   * When omitted (no token configured), the gate is disabled — this is
   * the legacy / pre-G4 behavior preserved for backwards compatibility
   * with non-daemon callers (e.g. unit tests).
   */
  expectedAuthToken?: string | null;
}

export type RequestContextSource = 'explicit' | 'headers' | 'legacy-vault' | 'url';

/**
 * Provenance of the request's (project, grove) tenancy — distinct from
 * `source`, which records *which transport* produced the context.
 *
 * - `'caller'`: explicit project/grove identity (`x-myco-project-id` /
 *   `x-myco-grove-id` headers, or `MYCO_PROJECT_ID` / `MYCO_GROVE_ID` env)
 *   was supplied by the caller AND survived `enforceContextSwitchAuth`.
 * - `'synthesized'`: no caller-supplied tenancy — the context was built
 *   from the daemon's bootstrap-anchor (fallback) vault via
 *   `buildVaultFallback`.
 *
 * The global daemon synthesizes a fallback context for *every* request
 * before handlers run, so "is requestContext present?" can never tell
 * authorized tenancy apart from a fallback. This marker carries that
 * distinction through transport so a later resolver can reject
 * synthesized tenancy and fail loud.
 */
export type TenancySource = 'caller' | 'synthesized' | 'daemon';

/**
 * The single predicate for "this request's tenancy was supplied by the
 * caller" (vs synthesized from the daemon's bootstrap-anchor fallback).
 *
 * Every tenancy gate — the request-principal resolver, the tools-runtime
 * guard, and the MCP-HTTP pre-flight — must decide caller-vs-synthesized
 * through this one function so the rule lives in exactly one place. Each
 * call site keeps its own error envelope (TenancyViolationError /
 * ToolError('legacy_vault') / the legacy_vault wire body); only the
 * predicate is shared.
 */
export function isCallerTenancy(
  context: { tenancySource?: TenancySource } | undefined,
): boolean {
  return context?.tenancySource === 'caller';
}

export function isProjectScopedTenancy(
  context: { tenancySource?: TenancySource } | undefined,
): boolean {
  return context?.tenancySource === 'caller' || context?.tenancySource === 'daemon';
}

export interface MycoRequestContext {
  projectRoot: string;
  /**
   * Caller's actual cwd, populated from `x-myco-caller-root` (or
   * `MYCO_CALLER_ROOT`) and preserved untouched through registry
   * resolution. Null when no caller-root was supplied. Readers that
   * need "where the user is right now" — plan watch dirs, plan
   * source path keys, hook artifact discovery — use
   * `filesystemRootFromRequestContext`. Readers that need
   * canonical project identity (vault dir, db path, Grove
   * registration) stay on `projectRoot`.
   */
  callerRoot: string | null;
  projectId: GroveProjectId;
  groveId: string | null;
  machineId: string;
  sessionId: string | null;
  projectVaultDir: string;
  databasePath: string;
  source: RequestContextSource;
  /**
   * Whether the (project, grove) tenancy was supplied by the caller
   * (`'caller'`), synthesized from the daemon's fallback vault
   * (`'synthesized'`), or derived by daemon-internal iteration over the
   * Grove registry (`'daemon'`). See {@link TenancySource}.
   */
  tenancySource: TenancySource;
}

/** True iff the request is bound to a Grove (vs a legacy project-local vault). */
export function isGroveScoped(context: MycoRequestContext | undefined | null): boolean {
  return Boolean(context?.groveId);
}

/**
 * Filesystem anchor for live, caller-originated paths.
 *
 * Use this when interpreting paths that came from a hook, MCP tool call, or
 * current user action: the caller may be in a git worktree whose filesystem
 * root differs from the registered project root. Do not use this for durable
 * project identity, Grove registration, database selection, or background
 * sweeps; those stay anchored to `context.projectRoot`.
 */
export function filesystemRootFromRequestContext(
  context: Pick<MycoRequestContext, 'callerRoot' | 'projectRoot'>,
): string {
  return context.callerRoot ?? context.projectRoot;
}

export interface LegacyRequestContextOptions {
  projectRoot?: string;
  callerRoot?: string | null;
  projectId?: GroveProjectId;
  groveId?: string | null;
  machineId?: string;
  sessionId?: string | null;
  source?: RequestContextSource;
  tenancySource?: TenancySource;
}

interface ExplicitContextInput {
  projectRoot?: string;
  projectId?: string;
  groveId?: string;
  machineId?: string;
  sessionId?: string | null;
}

/**
 * Build a `MycoRequestContext` for callers that don't yet have one but do
 * know a `GroveProjectId`. The function exists to keep the daemon-startup
 * and tool entry paths typed: `projectId` is required and branded — there
 * is no path-derived fallback. Pre-Grove callers cannot use this; they
 * must complete Grove activation first (auto-registered on first agent hook).
 */
export function resolveLegacyRequestContext(
  vaultDir: string,
  options: LegacyRequestContextOptions & { projectId: GroveProjectId },
): MycoRequestContext {
  const projectRoot = options.projectRoot ?? resolveProjectRoot(vaultDir);
  return {
    projectRoot,
    callerRoot: options.callerRoot ?? null,
    projectId: assertGroveProjectId(options.projectId),
    groveId: options.groveId ?? null,
    machineId: options.machineId ?? process.env.MYCO_MACHINE_ID ?? getMachineId(),
    sessionId: options.sessionId ?? process.env.MYCO_SESSION_ID ?? null,
    projectVaultDir: vaultDir,
    databasePath: vaultDbPath(vaultDir),
    source: options.source ?? 'legacy-vault',
    tenancySource: options.tenancySource ?? 'synthesized',
  };
}

export function requestContextHeaders(context: MycoRequestContext): Record<string, string> {
  return compactHeaders({
    [REQUEST_CONTEXT_HEADERS.projectRoot]: context.projectRoot,
    [REQUEST_CONTEXT_HEADERS.callerRoot]: context.callerRoot,
    [REQUEST_CONTEXT_HEADERS.projectId]: context.projectId,
    [REQUEST_CONTEXT_HEADERS.groveId]: context.groveId,
    [REQUEST_CONTEXT_HEADERS.machineId]: context.machineId,
    [REQUEST_CONTEXT_HEADERS.sessionId]: context.sessionId,
  });
}

export function requestContextFromHttpHeaders(
  headers: IncomingHttpHeaders,
  fallbackVaultDir: string,
  options: RequestContextAuthOptions = {},
): MycoRequestContext {
  // G4: daemon-issued bearer-token gate on context-switching headers.
  // Apply BEFORE buildVaultFallback so an unauthorized caller can't even
  // trigger a manifest read — failure mode is "unauthorized" full stop.
  enforceContextSwitchAuth(headers, options.expectedAuthToken ?? null);

  const callerRoot = normalizeCallerRoot(readHeader(headers, REQUEST_CONTEXT_HEADERS.callerRoot));
  const { context: fallback, manifest } = buildVaultFallback(fallbackVaultDir, { callerRoot });
  const explicit: ExplicitContextInput = {
    projectRoot: readHeader(headers, REQUEST_CONTEXT_HEADERS.projectRoot),
    projectId: readHeader(headers, REQUEST_CONTEXT_HEADERS.projectId),
    groveId: readHeader(headers, REQUEST_CONTEXT_HEADERS.groveId),
    machineId: readHeader(headers, REQUEST_CONTEXT_HEADERS.machineId),
    sessionId: readHeader(headers, REQUEST_CONTEXT_HEADERS.sessionId) ?? null,
  };
  const hasContextHeader = Object.values(explicit).some((value) => value !== undefined && value !== null);

  if (hasContextHeader) {
    // Caller-supplied tenancy is keyed on project/grove identity (the same
    // headers the auth gate guards), not on incidental projectRoot/machine/
    // session headers. Auth has already been enforced above.
    const tenancySource = tenancySourceFromExplicit(explicit);
    if (explicit.groveId) return resolveRegisteredRequestContext(explicit, fallback, 'headers', tenancySource);
    const manifestContext = resolveManifestHeaderRequestContext(explicit, fallback, 'headers', tenancySource);
    if (manifestContext) return manifestContext;
    return resolveLegacyHeaderRequestContext(explicit, fallback, tenancySource);
  }

  return resolveManifestRequestContext(fallback, 'headers', manifest) ?? fallback;
}

/**
 * Build a request context from a (Grove, project) id pair carried in a URL
 * path — e.g. `/api/g/:groveId/p/:projectId/attachments/:filename`.
 *
 * Browser subresource loads (`<img>`, `<video>`, file downloads) cannot
 * attach the `x-myco-*` tenancy headers the scripted API uses, so resource
 * routes encode tenancy in the URL instead. Resolution runs through the same
 * registry-validated path as the header resolver
 * (`resolveRegisteredRequestContext`), so an unknown Grove or an unregistered
 * project still fails loud, and the resolved context is stamped
 * `tenancySource: 'caller'` so project-scoped reads apply — without it the
 * lookup falls back to `GLOBAL_SCOPE` (`project_id IS NULL`) and can never
 * match a Grove-bound row.
 *
 * No bearer-token gate: the auth gate guards context-switching *headers*
 * (which a hostile local process could attach to redirect a write at another
 * Grove). A URL-scoped resource route is read-only, loopback-bound, and
 * CSRF-guarded; the URL itself is the asserted, registry-validated scope.
 */
export function requestContextFromTenancyIds(
  ids: { groveId: string; projectId: string },
  fallbackVaultDir: string,
): MycoRequestContext {
  const { context: fallback } = buildVaultFallback(fallbackVaultDir);
  const explicit: ExplicitContextInput = {
    groveId: ids.groveId,
    projectId: ids.projectId,
    sessionId: null,
  };
  return resolveRegisteredRequestContext(explicit, fallback, 'url', tenancySourceFromExplicit(explicit));
}

/**
 * Decide tenancy provenance from an explicit (header/env) context input.
 * `'caller'` iff the caller supplied a project id, a Grove id, OR a project
 * root — all three are caller assertions of "act against THIS project". A
 * caller-supplied `projectRoot` (x-myco-project-root / MYCO_PROJECT_ROOT)
 * resolves a real registered project via its `project.toml`/Grove manifest;
 * stamping that 'synthesized' wrongly rejected a legitimate project pivot
 * (the regression this widening fixes). Incidental fields (machineId,
 * sessionId) still leave the context synthesized.
 *
 * This only ever sees CALLER-supplied input: the daemon's fallback root is
 * applied by `tryBuildVaultFallback` (tenancySource 'synthesized') and the
 * server-anchor manifest backfill by `resolveManifestRequestContext`
 * (tenancySource 'synthesized'), neither of which routes through here. So a
 * project id/grove id back-filled from the SERVER's fallback root stays
 * synthesized; only a root the caller themselves asserted counts as 'caller'.
 */
function tenancySourceFromExplicit(input: ExplicitContextInput): TenancySource {
  return input.projectId || input.groveId || input.projectRoot ? 'caller' : 'synthesized';
}

/**
 * Verify the caller's `x-myco-auth` header against the daemon's bearer
 * token whenever context-switching headers are present. When no token
 * is configured (legacy / unit-test path) the gate is a no-op so the
 * function preserves backwards compatibility for non-daemon callers.
 *
 * Throws `UnauthorizedRequestContextError` on mismatch — call sites at
 * the HTTP transport boundary translate this into a 401 response.
 */
function enforceContextSwitchAuth(
  headers: IncomingHttpHeaders,
  expectedToken: string | null,
): void {
  // No daemon-issued token configured (e.g. legacy callers, unit tests
  // that build a context directly). Preserve legacy behavior.
  if (!expectedToken) return;

  const switching = CONTEXT_SWITCHING_HEADERS.some(
    (name) => readHeader(headers, name) !== undefined,
  );
  if (!switching) return;

  const presented = readHeader(headers, REQUEST_CONTEXT_AUTH_HEADER);
  if (!presented || !timingSafeStringEqual(presented, expectedToken)) {
    throw new UnauthorizedRequestContextError(
      'Context-switching headers require the daemon-issued bearer token',
    );
  }
}

/**
 * Constant-time string equality — same shape as the worker-side helper
 * but kept local so this module has no Node-vs-Workers dependency
 * differences. Both inputs are length-padded to the longer of the two
 * before XOR, so a length mismatch still walks the whole comparison.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    const ai = i < a.length ? a.charCodeAt(i) : 0;
    const bi = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= ai ^ bi;
  }
  return mismatch === 0;
}

export function requestContextFromEnvironment(
  env: Record<string, string | undefined>,
  fallbackVaultDir: string,
): MycoRequestContext {
  const machineId = readEnv(env, REQUEST_CONTEXT_ENV.machineId);
  const sessionId = readEnv(env, REQUEST_CONTEXT_ENV.sessionId);
  const callerRoot = normalizeCallerRoot(readEnv(env, REQUEST_CONTEXT_ENV.callerRoot));
  const { context: fallback, manifest } = buildVaultFallback(fallbackVaultDir, { machineId, sessionId, callerRoot });
  const hasExplicitProjectContext = [
    REQUEST_CONTEXT_ENV.projectRoot,
    REQUEST_CONTEXT_ENV.projectId,
    REQUEST_CONTEXT_ENV.groveId,
  ].some((key) => readEnv(env, key) !== undefined);

  if (!hasExplicitProjectContext) {
    return resolveManifestRequestContext(fallback, 'explicit', manifest) ?? fallback;
  }

  const explicit: ExplicitContextInput = {
    projectRoot: readEnv(env, REQUEST_CONTEXT_ENV.projectRoot),
    projectId: readEnv(env, REQUEST_CONTEXT_ENV.projectId),
    groveId: readEnv(env, REQUEST_CONTEXT_ENV.groveId),
    machineId,
    sessionId,
  };
  return resolveRegisteredRequestContext(explicit, fallback, 'explicit', tenancySourceFromExplicit(explicit));
}

/**
 * Resolve a `MycoRequestContext` from a vault directory alone, when the
 * caller hasn't been handed one by the request transport. The `projectId`
 * is read from the project manifest (`project.toml`) and validated as a
 * `GroveProjectId`. Pre-Grove vaults — where the manifest is missing or
 * lacks a `proj_<32hex>` id — throw with an explicit message instead of
 * silently producing a path-derived id.
 *
 * For tool/MCP entry points that prefer a soft-fail path (so MCP clients
 * see a friendly "this project hasn't been auto-registered yet" message
 * instead of `tool_call_failed`), use `tryResolveRequestContextForVault`
 * instead.
 */
export function resolveRequestContextForVault(
  vaultDir: string,
  overrides: { machineId?: string; sessionId?: string | null } = {},
): MycoRequestContext {
  const result = tryResolveRequestContextForVault(vaultDir, overrides);
  if (result.kind === 'legacy') {
    // Preserve the historical hard-error contract for callers that
    // explicitly chose the throwing entry point.
    throw new Error(result.reason);
  }
  return result.context;
}

/**
 * Result of `tryResolveRequestContextForVault`. The `kind: 'grove'`
 * variant carries the same `MycoRequestContext` the throwing function
 * would have returned. The `kind: 'legacy'` variant carries the
 * vault directory and a human-readable reason — surfaced by tool
 * runtimes as a degraded-mode error so MCP clients render
 * "this project hasn't been auto-registered yet" instead of an
 * opaque `tool_call_failed`.
 */
export type TryRequestContextResult =
  | { kind: 'grove'; context: MycoRequestContext }
  | { kind: 'legacy'; vaultDir: string; reason: string };

/**
 * Soft-fail variant of `resolveRequestContextForVault` for entry
 * points that need to keep the daemon responsive on pre-Grove vaults
 * (the project manifest is absent, the `project.toml` lacks a
 * `proj_<32hex>` id, etc.). The caller decides what to do with the
 * legacy state — the canonical pattern is to surface a
 * `legacy_vault` typed tool error with the included `reason` rather
 * than letting `resolveRequestContextForVault` throw `tool_call_failed`
 * inside the MCP runtime.
 */
export function tryResolveRequestContextForVault(
  vaultDir: string,
  overrides: { machineId?: string; sessionId?: string | null } = {},
): TryRequestContextResult {
  const result = tryBuildVaultFallback(vaultDir, overrides);
  if (result.kind === 'legacy') {
    return result;
  }
  const context = resolveManifestRequestContext(result.context, 'legacy-vault', result.manifest)
    ?? result.context;
  return { kind: 'grove', context };
}

/**
 * Internal: resolve the vault-derived context AND return the manifest
 * we already had to read. Two transport entry points
 * (`requestContextFromEnvironment`, `requestContextFromHttpHeaders`)
 * pass the manifest through to `resolveManifestRequestContext` so it
 * doesn't read the same `project.toml` from disk twice.
 *
 * Throws on legacy vaults to preserve the historical hard-error
 * contract for header/env paths. Tool runtimes that need a graceful
 * degraded mode should call `tryBuildVaultFallback` directly.
 */
function buildVaultFallback(
  vaultDir: string,
  overrides: { machineId?: string; sessionId?: string | null; callerRoot?: string | null } = {},
): { context: MycoRequestContext; manifest: ProjectManifest | null } {
  const result = tryBuildVaultFallback(vaultDir, overrides);
  if (result.kind === 'legacy') {
    throw new Error(result.reason);
  }
  return { context: result.context, manifest: result.manifest };
}

/**
 * Internal: soft-fail variant of `buildVaultFallback`. Returns a
 * discriminated union so call sites can branch on legacy state
 * instead of catching exceptions. `kind: 'grove'` carries the
 * resolved context plus the manifest we already had to read (so
 * `resolveManifestRequestContext` doesn't re-read it). `kind:
 * 'legacy'` carries the vault directory and a friendly reason.
 */
function tryBuildVaultFallback(
  vaultDir: string,
  overrides: { machineId?: string; sessionId?: string | null; callerRoot?: string | null } = {},
): { kind: 'grove'; context: MycoRequestContext; manifest: ProjectManifest } | { kind: 'legacy'; vaultDir: string; reason: string } {
  const manifest = readManifest(vaultDir);
  if (!manifest?.project?.id) {
    return {
      kind: 'legacy',
      vaultDir,
      reason: `No Grove project id available for vault ${vaultDir}. Open the dashboard and commit Myco config to this project from the Symbionts page.`,
    };
  }
  const projectRoot = resolveProjectRoot(vaultDir);
  return {
    kind: 'grove',
    context: {
      projectRoot,
      callerRoot: overrides.callerRoot ?? null,
      projectId: assertGroveProjectId(manifest.project.id),
      groveId: null,
      machineId: overrides.machineId ?? getMachineId(),
      sessionId: overrides.sessionId ?? null,
      projectVaultDir: vaultDir,
      databasePath: vaultDbPath(vaultDir),
      source: 'legacy-vault',
      // Built from the daemon's fallback vault, not caller-supplied
      // tenancy. Explicit-header/env branches override this to 'caller'.
      tenancySource: 'synthesized',
    },
    manifest,
  };
}

/**
 * Translate a transport-level request context into the project_id predicate
 * expected by first-generation Grove-aware row helpers.
 *
 * Undefined means the caller has no request context and should preserve the
 * existing broad helper behavior. A legacy project-local context maps to
 * NULL rows because pre-Grove vault data has no project_id. Once a Grove id
 * is present, the resolved project id becomes mandatory row scope.
 */
export function rowProjectIdFromRequestContext(
  context?: MycoRequestContext,
): GroveProjectId | null | undefined {
  if (!context) return undefined;
  return context.groveId ? context.projectId : null;
}

/**
 * Build a strict `ProjectScope` from a request context for read-side
 * filtering. Grove-bound requests scope to their project; legacy
 * project-local contexts scope to global (NULL project_id) rows.
 *
 * Throws on a missing context. Consumers that genuinely want a cross-
 * project read must opt into `ALL_PROJECTS_SCOPE` from `@myco/grove/ids`
 * explicitly — the historical silent fallthrough to `{ kind: 'all' }`
 * caused unintended cross-project leaks for any handler whose request
 * arrived without context (P2 #35).
 */
export function projectScopeFromRequestContext(
  context: MycoRequestContext | undefined,
): ProjectScope {
  if (!context) {
    throw new Error(
      'projectScopeFromRequestContext requires a MycoRequestContext. '
      + 'If a cross-project read is intended, pass ALL_PROJECTS_SCOPE explicitly.',
    );
  }
  // Enforce provenance at the scope seam so EVERY read consumer
  // (sessions/spores/search/reports/notifications/…) is protected at once,
  // not per-route. A synthesized context carries the daemon's bootstrap-anchor
  // project id; binding it to `projectScope(anchorId)` would leak the anchor's
  // rows to an unauthorized request. Only a caller-asserted, Grove-bound
  // context may bind to a specific project scope; everything else resolves to
  // GLOBAL_SCOPE (`project_id IS NULL`), which returns zero cross-project rows.
  return isProjectScopedTenancy(context) && context.groveId
    ? projectScope(context.projectId)
    : GLOBAL_SCOPE;
}

function compactHeaders(values: Record<string, string | null | undefined>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    headers[key] = value;
  }
  return headers;
}

function resolveManifestRequestContext(
  fallback: MycoRequestContext,
  source: RequestContextSource,
  cachedManifest?: ProjectManifest | null,
): MycoRequestContext | null {
  const manifest = cachedManifest ?? readManifest(fallback.projectVaultDir);
  if (!manifest?.grove?.binding_id) return null;
  const registered = findRegisteredProject({
    projectId: manifest.project.id,
    bindingId: manifest.grove.binding_id,
    projectRoot: fallback.projectRoot,
  });
  if (!registered) return null;
  return buildRegisteredRequestContext({
    fallback,
    source,
    // Resolved from the daemon's anchor-vault manifest, not from
    // caller-supplied project/grove identity — tenancy stays synthesized.
    tenancySource: 'synthesized',
    projectRoot: registered.project.root,
    projectId: assertGroveProjectId(registered.project.project_id),
    groveId: registered.grove.id,
    machineId: fallback.machineId,
    sessionId: fallback.sessionId,
    manifest,
  });
}

function resolveManifestHeaderRequestContext(
  input: ExplicitContextInput,
  fallback: MycoRequestContext,
  source: RequestContextSource,
  tenancySource: TenancySource,
): MycoRequestContext | null {
  const inputProjectRoot = input.projectRoot ? path.resolve(input.projectRoot) : null;
  if (!inputProjectRoot && !input.projectId) return null;

  const projectRoot = inputProjectRoot ?? fallback.projectRoot;
  const manifest = readManifest(resolveProjectVaultDir(projectRoot));
  if (!manifest?.grove?.binding_id) return null;

  const projectId = input.projectId ?? manifest.project.id;
  if (!projectId) return null;
  if (manifest.project.id !== projectId) {
    throw new Error(`Request context project id ${projectId} does not match project.toml id ${manifest.project.id}`);
  }

  const registered = findRegisteredProject({
    projectId,
    bindingId: manifest.grove.binding_id,
    projectRoot,
  });
  if (!registered) {
    throw new Error(`Project ${projectId} is not registered from request context`);
  }

  return buildRegisteredRequestContext({
    fallback,
    source,
    tenancySource,
    projectRoot: registered.project.root,
    projectId: assertGroveProjectId(projectId),
    groveId: registered.grove.id,
    machineId: input.machineId ?? fallback.machineId,
    sessionId: input.sessionId ?? fallback.sessionId,
    manifest,
  });
}

function resolveRegisteredRequestContext(
  input: ExplicitContextInput,
  fallback: MycoRequestContext,
  source: RequestContextSource,
  tenancySource: TenancySource,
): MycoRequestContext {
  const inputProjectRoot = input.projectRoot ? path.resolve(input.projectRoot) : null;
  const manifestFromInputRoot = inputProjectRoot
    ? readManifest(resolveProjectVaultDir(inputProjectRoot))
    : null;
  const projectId = input.projectId ?? manifestFromInputRoot?.project.id;
  const groveId = input.groveId;
  const missing: string[] = [];
  if (!projectId) missing.push('project id');
  if (!groveId) missing.push('Grove id');
  if (missing.length > 0) {
    throw new Error(`Incomplete Myco request context: missing ${missing.join(', ')}`);
  }

  const mycoHome = resolveMycoHome();
  const grove = loadGroveRecord(groveId!, mycoHome);
  if (!grove) throw new Error(`Unknown Grove in request context: ${groveId}`);

  if (manifestFromInputRoot && manifestFromInputRoot.project.id !== projectId) {
    throw new Error(`Request context project id ${projectId} does not match project.toml id ${manifestFromInputRoot.project.id}`);
  }

  const registered = findRegisteredProject({
    projectId: projectId!,
    groveId: grove.id,
    bindingId: manifestFromInputRoot?.grove?.binding_id ?? null,
    projectRoot: inputProjectRoot,
  }, mycoHome);
  if (!registered) {
    throw new Error(`Project ${projectId} is not registered in Grove ${grove.id}`);
  }

  const registeredRoot = path.resolve(registered.project.root);
  const manifest = readManifest(resolveProjectVaultDir(registeredRoot));
  if (manifest && manifest.project.id !== projectId) {
    throw new Error(`Registered project ${projectId} does not match project.toml id ${manifest.project.id}`);
  }
  if (
    manifest?.grove?.binding_id
    && registered.project.binding_id
    && manifest.grove.binding_id !== registered.project.binding_id
  ) {
    throw new Error(`Registered project ${projectId} binding does not match project.toml binding`);
  }

  return buildRegisteredRequestContext({
    fallback,
    source,
    tenancySource,
    projectRoot: registeredRoot,
    projectId: assertGroveProjectId(projectId),
    groveId: grove.id,
    machineId: input.machineId ?? fallback.machineId,
    sessionId: input.sessionId ?? fallback.sessionId,
    manifest,
  });
}

function resolveLegacyHeaderRequestContext(
  input: ExplicitContextInput,
  fallback: MycoRequestContext,
  tenancySource: TenancySource,
): MycoRequestContext {
  return {
    ...fallback,
    machineId: input.machineId ?? fallback.machineId,
    sessionId: input.sessionId ?? fallback.sessionId,
    source: 'headers',
    tenancySource,
  };
}

function buildRegisteredRequestContext(input: {
  fallback: MycoRequestContext;
  source: RequestContextSource;
  tenancySource: TenancySource;
  projectRoot: string;
  projectId: GroveProjectId;
  groveId: string;
  machineId: string;
  sessionId: string | null;
  manifest: ProjectManifest | null;
}): MycoRequestContext {
  const projectRoot = path.resolve(input.projectRoot);
  const projectVaultDir = resolveProjectVaultDir(projectRoot);
  if (input.manifest && input.manifest.project.id !== input.projectId) {
    throw new Error(`Registered project ${input.projectId} does not match project.toml id ${input.manifest.project.id}`);
  }
  return {
    ...input.fallback,
    projectRoot,
    projectId: input.projectId,
    groveId: input.groveId,
    machineId: input.machineId,
    sessionId: input.sessionId,
    projectVaultDir,
    databasePath: resolveGroveDbPath(input.groveId),
    source: input.source,
    tenancySource: input.tenancySource,
  };
}

function readManifest(projectVaultDir: string): ProjectManifest | null {
  // No try/catch: loadProjectManifest returns null on ENOENT (legitimate
  // pre-Grove vault) but throws on parse/validation errors. Swallowing
  // those would silently route a grove-bound project to legacy-project
  // scope and create a divergent database — the bug class we keep getting
  // bitten by. Let the caller decide how to react to a corrupt manifest.
  //
  // `manifest.grove?.binding_id` is reconstituted from `project.local.toml`
  // by `overlayLocalBinding` in `loadProjectManifest`; consumers must read
  // that field from this loader rather than calling `loadProjectLocalManifest`
  // directly so the legacy-vault and post-migration code paths stay unified.
  return loadProjectManifest(projectVaultDir);
}

/**
 * Resolve a caller-root value (header or env) to an absolute path,
 * or null when the caller did not supply one. Centralized so the
 * HTTP and env entry points apply the same `path.resolve` normalization
 * — readers downstream get a value that is always absolute when present.
 */
function normalizeCallerRoot(raw: string | undefined): string | null {
  if (!raw) return null;
  return path.resolve(raw);
}

function readHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
