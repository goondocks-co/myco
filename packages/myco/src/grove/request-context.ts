import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { getMachineId } from '@myco/machine-id.js';
import { vaultDbPath } from '@myco/db/client.js';
import { loadProjectManifest, type ProjectManifest } from '@myco/config/project-manifest.js';
import {
  ALL_PROJECTS_SCOPE,
  assertGroveProjectId,
  GLOBAL_SCOPE,
  isGroveEraId,
  projectScope,
  type GroveProjectId,
  type ProjectScope,
} from '@myco/grove/ids.js';
import { resolveGroveDbPath, resolveGroveDir, resolveMycoHome, resolveProjectVaultDir } from '@myco/grove/paths.js';
import {
  findRegisteredProject,
  ForeignGroveError,
  groveOwnedByThisDaemon,
  loadGroveRecord,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import { resolveAttach } from '@myco/host/registry.js';

// Transports that resolve inbound requests catch this alongside the
// resolver's own error types; re-exported so they import one module for
// the full request-resolution error surface.
export { ForeignGroveError };

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

/**
 * The requested tenancy (Grove or project) does not exist in the registry —
 * e.g. a stale/guessed id in a resource URL. Distinct from an internal
 * integrity mismatch: the transport boundary maps this to 404, not 500.
 */
export class UnknownRequestContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownRequestContextError';
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
  /**
   * Enforce home ownership on the Grove this request resolves to: when the
   * Grove lives in another daemon's home (it does not load from this
   * daemon's `<MYCO_HOME>/groves/`), throw {@link ForeignGroveError}
   * instead of returning a context whose `databasePath` points into a
   * foreign Grove. Opt-in, set ONLY where the daemon resolves inbound
   * requests (the HTTP API and `/mcp` transports). The same resolver
   * also runs client-side — hooks, the stdio bridge, the CLI — where a
   * throw would be swallowed and silently drop capture headers, so the
   * default keeps today's non-throwing behavior.
   */
  enforceGroveOwnership?: boolean;
  /**
   * Tolerate an ATTACHED project (served by a remote Team Host, no local Grove
   * registry row) that is named as caller tenancy against an existing LOCAL
   * Grove. When set, a `findRegisteredProject` miss that would otherwise throw
   * {@link UnknownRequestContextError} instead resolves a display-only,
   * grove-scoped, `attachedProject`-flagged context (see
   * {@link MycoRequestContext.attachedProject}) so machine-scoped
   * `localhost-only` surfaces serve instead of 404ing while an attached project
   * is the member's active UI selection.
   *
   * Opt-in, set ONLY at the member daemon's local-dispatch header resolution
   * (`daemon/server.ts` `resolveRouteRequestContext`). The `/mcp` transport, the
   * external MCP listener, URL-tenancy resource routes, and client-side env
   * resolution all leave it off, so their behavior is byte-identical to today.
   * A non-attached miss (genuinely unknown project) still throws exactly as
   * before regardless of this flag.
   */
  tolerateAttachedProject?: boolean;
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
  /** The bound Grove project id, or NULL for the project-less daemon anchor. */
  projectId: GroveProjectId | null;
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
  /**
   * True when this request arrived on the daemon's OVERLAY listener — i.e.
   * the run is being host-served for a remote member over the Team Host
   * overlay (see `isOverlayRequest`, `daemon/host-serve.ts`). Stamped at the
   * transport boundary (`daemon/server.ts`) from the spoofing-proof overlay
   * mark, then carried untouched to the executor's tool surface.
   *
   * Residency constraint: on a host-served run the host holds the Grove DB
   * but NOT the member's working tree, so committed-file publishes (skills)
   * and project-tree reads must not touch a tree the host lacks. Read
   * this through {@link isHostServedRequest}. Absent/false for every local
   * (non-overlay) run — behavior there is byte-identical to today.
   */
  hostServed?: boolean;
  /**
   * True when the caller's tenancy names an ATTACHED project (served by a
   * remote Team Host) that has no local Grove registry row, and the request
   * is a member-local dispatch (a `localhost-only` route classified `local`).
   * Set only by {@link resolveRegisteredRequestContext}'s attach-tolerance
   * branch, gated behind `tolerateAttachedProject` — so it is absent for every
   * non-attached request and for URL-tenancy / client-side resolution.
   *
   * The context it stamps is DISPLAY-ONLY and grove-scoped, project-less at the
   * database layer: `databasePath` is the member's own local display Grove DB
   * (never a project vault — an attached project has none), and project-scoped
   * reads resolve to zero local rows. Read this through
   * {@link isAttachedProjectRequest}; absent/false everywhere else.
   */
  attachedProject?: boolean;
}

/**
 * True when the request is being host-served for a remote member over the
 * Team Host overlay (see {@link MycoRequestContext.hostServed}). The single
 * predicate for the residency write/read gate: committed-file publishes and
 * project-tree reads consult this so the host never writes or reads a member
 * working tree it lacks. Coerces the optional flag so an unstamped context
 * (every local run, daemon sweep, and test fixture) is treated as local.
 */
export function isHostServedRequest(
  context: { hostServed?: boolean } | undefined | null,
): boolean {
  return context?.hostServed === true;
}

/**
 * True when the request resolved to an ATTACHED project (a Team Host member's
 * active UI selection) that has no local Grove registry row — see
 * {@link MycoRequestContext.attachedProject}. Coerces the optional flag so an
 * unstamped context (every non-attached request) reads as false.
 */
export function isAttachedProjectRequest(
  context: { attachedProject?: boolean } | undefined | null,
): boolean {
  return context?.attachedProject === true;
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

  const enforceGroveOwnership = options.enforceGroveOwnership === true;
  const tolerateAttachedProject = options.tolerateAttachedProject === true;
  const callerRoot = normalizeCallerRoot(readHeader(headers, REQUEST_CONTEXT_HEADERS.callerRoot));
  // Base context; caller headers below override to a real project.
  const { context: fallback, manifest } = buildVaultFallbackOrGlobal(fallbackVaultDir, { callerRoot });
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
    if (explicit.groveId) {
      return resolveRegisteredRequestContext(explicit, fallback, 'headers', tenancySource, enforceGroveOwnership, tolerateAttachedProject);
    }
    const manifestContext = resolveManifestHeaderRequestContext(explicit, fallback, 'headers', tenancySource, enforceGroveOwnership);
    if (manifestContext) return manifestContext;
    return resolveLegacyHeaderRequestContext(explicit, fallback, tenancySource);
  }

  return resolveManifestRequestContext(fallback, 'headers', manifest, 'synthesized', enforceGroveOwnership) ?? fallback;
}

/**
 * Cheap inbound tenancy pre-parse for the Team Host routing chokepoint.
 *
 * Yields the effective project id from an inbound HTTP request WITHOUT touching
 * the Grove registry or computing any DB path — the attach decision must run
 * before the full resolver (`requestContextFromHttpHeaders`), which eagerly
 * computes `databasePath` and throws `UnknownRequestContextError` for a Grove
 * that has no local record (exactly what a hosted Grove is).
 *
 * The local bearer gate runs exactly as today: {@link enforceContextSwitchAuth}
 * fires here for both local and remote requests, so the local daemon still
 * authenticates the local caller before it proxies. On the local branch the full
 * resolver re-runs the gate harmlessly (idempotent, no side effects).
 *
 * Resolution order:
 *   1. `x-myco-project-id` header — the common capture/MCP case; zero disk I/O.
 *   2. else `project.toml` at `x-myco-project-root` — a manifest read, NOT a
 *      Grove-registry/DB resolution.
 *   3. else null — a request with no project/root header is the daemon anchor /
 *      no-tenancy path, which is never attached; skip even the manifest read.
 *
 * A header/manifest id that is not a well-formed `proj_<32hex>` resolves to null
 * (it cannot be an attach key) rather than throwing, so a malformed id falls
 * through to today's local resolver, which reports the error exactly as before.
 */
export function resolveInboundProjectId(
  headers: IncomingHttpHeaders,
  fallbackVaultDir: string,
  options: { expectedAuthToken: string | null },
): { projectId: GroveProjectId | null } {
  enforceContextSwitchAuth(headers, options.expectedAuthToken ?? null);

  const headerProjectId = readHeader(headers, REQUEST_CONTEXT_HEADERS.projectId);
  if (headerProjectId) {
    return { projectId: isGroveEraId(headerProjectId, 'project') ? (headerProjectId as GroveProjectId) : null };
  }

  const projectRoot = readHeader(headers, REQUEST_CONTEXT_HEADERS.projectRoot);
  if (!projectRoot) return { projectId: null };

  const manifest = readManifest(resolveProjectVaultDir(path.resolve(projectRoot)));
  const manifestId = manifest?.project?.id;
  return {
    projectId: manifestId && isGroveEraId(manifestId, 'project') ? (manifestId as GroveProjectId) : null,
  };
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
 * Bearer-token gate: the URL params ARE the context switch, so the daemon
 * token is required *unconditionally* (the header path only gates when x-myco-*
 * switching headers are present, which browser subresource loads never send).
 * Callers that can't attach the `x-myco-auth` header — bare `<img src>` — must
 * fetch the resource with the header and stream it into a blob instead. When no
 * token is configured (legacy / unit-test callers) the gate is a no-op.
 */
export function requestContextFromTenancyIds(
  ids: { groveId: string; projectId: string },
  fallbackVaultDir: string,
  options: { headers: IncomingHttpHeaders; expectedAuthToken: string | null; enforceGroveOwnership?: boolean } = {
    headers: {},
    expectedAuthToken: null,
  },
): MycoRequestContext {
  enforceUrlTenancyAuth(options.headers, options.expectedAuthToken);
  // Base context; the URL (Grove, project) ids below override to the project.
  const { context: fallback } = buildVaultFallbackOrGlobal(fallbackVaultDir);
  const explicit: ExplicitContextInput = {
    groveId: ids.groveId,
    projectId: ids.projectId,
    sessionId: null,
  };
  return resolveRegisteredRequestContext(
    explicit,
    fallback,
    'url',
    tenancySourceFromExplicit(explicit),
    options.enforceGroveOwnership === true,
    // URL-tenancy resource routes for an attached project are serve-stamped and
    // proxied to the host before this resolver runs, so they never reach the
    // attach-tolerance branch; keep it off to stay byte-identical to today.
    false,
  );
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
/**
 * Verify the `x-myco-auth` header for a URL-scoped resource route. Unlike
 * {@link enforceContextSwitchAuth}, this requires the token unconditionally
 * because the URL path itself asserts the (Grove, project) — there are no
 * switching headers to gate on. No-op when no daemon token is configured.
 */
export function enforceUrlTenancyAuth(
  headers: IncomingHttpHeaders,
  expectedToken: string | null,
): void {
  if (!expectedToken) return;
  const presented = readHeader(headers, REQUEST_CONTEXT_AUTH_HEADER);
  if (!presented || !timingSafeStringEqual(presented, expectedToken)) {
    throw new UnauthorizedRequestContextError(
      'URL-scoped resource routes require the daemon-issued bearer token',
    );
  }
}

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
 *
 * Exported so the Team Host transport-boundary gate (`daemon/host-serve.ts`)
 * compares the overlay bearer with the SAME constant-time primitive the daemon
 * token gate uses — one comparison discipline for every daemon-issued secret.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    const ai = i < a.length ? a.charCodeAt(i) : 0;
    const bi = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= ai ^ bi;
  }
  return mismatch === 0;
}

export interface EnvRequestContextOptions {
  /**
   * Treat a REGISTRY-VALIDATED manifest resolved from `fallbackVaultDir` as
   * caller-determined tenancy (`tenancySource: 'caller'`) instead of the
   * default `'synthesized'`, when the environment carries no explicit
   * project/grove identity.
   *
   * Set this ONLY from launch-context entry points whose `fallbackVaultDir` is
   * the caller's OWN cwd-resolved project vault — the `myco` CLI tool runtime
   * and direct-DB CLI reads, which resolve the vault by walking up from
   * `process.cwd()` to the git/`.myco` root. Running `myco` inside a
   * registered, Grove-bound project IS the caller asserting "act on THIS
   * project" — the same assertion `tenancySourceFromExplicit` already honors
   * for a caller-supplied projectRoot/projectId/groveId. The agent and the user
   * supply nothing; the launch directory is the signal.
   *
   * It is NOT a synthesis from the daemon's bootstrap-anchor vault: resolution
   * still runs through `findRegisteredProject` (a Grove-registry lookup), so an
   * unregistered or unbound launch context resolves nothing and stays the
   * `'synthesized'` fallback (→ rejected by the tenancy guard). The anchor can
   * never masquerade as caller tenancy.
   *
   * The daemon's bootstrap-anchor path derivation (`resolveDaemonDataPaths`)
   * MUST NOT set this — it passes the anchor vault and consumes only paths.
   */
  launchContextTenancy?: boolean;
}

export function requestContextFromEnvironment(
  env: Record<string, string | undefined>,
  fallbackVaultDir: string,
  options: EnvRequestContextOptions = {},
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
    const manifestTenancy: TenancySource = options.launchContextTenancy ? 'caller' : 'synthesized';
    return resolveManifestRequestContext(fallback, 'explicit', manifest, manifestTenancy) ?? fallback;
  }

  const explicit: ExplicitContextInput = {
    projectRoot: readEnv(env, REQUEST_CONTEXT_ENV.projectRoot),
    projectId: readEnv(env, REQUEST_CONTEXT_ENV.projectId),
    groveId: readEnv(env, REQUEST_CONTEXT_ENV.groveId),
    machineId,
    sessionId,
  };
  // Client-side resolution (hooks, stdio bridge, CLI): never enforce
  // Grove ownership here — a throw would be swallowed by the hook
  // client's catch and silently drop capture headers. The daemon
  // enforces ownership when it resolves the inbound request. Attach
  // tolerance stays off too: it is a member daemon local-dispatch affordance.
  return resolveRegisteredRequestContext(explicit, fallback, 'explicit', tenancySourceFromExplicit(explicit), false, false);
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
    // Unregistered project root: the vault has no Grove project id.
    // UnknownRequestContextError maps to 404 at the transport boundary
    // (server.ts, mcp/http.ts) instead of falling through to the 500 catch-all.
    throw new UnknownRequestContextError(result.reason);
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
    // Unregistered project root: maps to 404 at the transport boundary
    // (server.ts, mcp/http.ts) instead of the 500 catch-all.
    throw new UnknownRequestContextError(result.reason);
  }
  return { context: result.context, manifest: result.manifest };
}

/**
 * Like `buildVaultFallback` but returns the daemon-global context instead of
 * throwing when the vault has no manifest. Resolves a real project vault to its
 * project and the project-less anchor vault to the daemon-global context. Used
 * by the daemon transport paths (header / URL-param).
 */
function buildVaultFallbackOrGlobal(
  vaultDir: string,
  overrides: { machineId?: string; sessionId?: string | null; callerRoot?: string | null } = {},
): { context: MycoRequestContext; manifest: ProjectManifest | null } {
  const result = tryBuildVaultFallback(vaultDir, overrides);
  if (result.kind === 'grove') {
    return { context: result.context, manifest: result.manifest };
  }
  const context = daemonGlobalRequestContext(vaultDir, {
    machineId: overrides.machineId,
    sessionId: overrides.sessionId,
  });
  return { context: { ...context, callerRoot: overrides.callerRoot ?? null }, manifest: null };
}

/**
 * Build a request context synthesized from a daemon-owned vault directory
 * (not caller-supplied tenancy). `projectId` is the vault's manifest project
 * for a Grove-bound vault, or null for the global daemon's project-less
 * startup anchor. Explicit-header/env branches override `tenancySource` to
 * 'caller'.
 */
function synthesizedVaultContext(
  vaultDir: string,
  projectId: GroveProjectId | null,
  overrides: { machineId?: string; sessionId?: string | null; callerRoot?: string | null } = {},
): MycoRequestContext {
  return {
    projectRoot: resolveProjectRoot(vaultDir),
    callerRoot: overrides.callerRoot ?? null,
    projectId,
    groveId: null,
    machineId: overrides.machineId ?? getMachineId(),
    sessionId: overrides.sessionId ?? null,
    projectVaultDir: vaultDir,
    databasePath: vaultDbPath(vaultDir),
    source: 'legacy-vault',
    tenancySource: 'synthesized',
  };
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
  return {
    kind: 'grove',
    context: synthesizedVaultContext(vaultDir, assertGroveProjectId(manifest.project.id), overrides),
    manifest,
  };
}

/**
 * Builds the project-less request context for the global daemon's startup
 * anchor: `projectId` and `groveId` are both null, so
 * `rowProjectIdFromRequestContext` resolves to NULL and
 * `projectScopeFromRequestContext` to GLOBAL_SCOPE.
 */
export function daemonGlobalRequestContext(
  vaultDir: string,
  overrides: { machineId?: string; sessionId?: string | null } = {},
): MycoRequestContext {
  return synthesizedVaultContext(vaultDir, null, overrides);
}

/**
 * Returns the context's Grove project id, or throws when it is null. Use at
 * sites reached only by caller/registered (grove-bound) contexts — an agent
 * run, a tenant-route handler.
 */
export function requireProjectId(
  context: MycoRequestContext,
  what = 'operation',
): GroveProjectId {
  if (context.projectId == null) {
    throw new Error(
      `${what} requires a resolved Grove project, but the request context has none `
      + '(the daemon-global anchor must not reach this path).',
    );
  }
  return context.projectId;
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
  context: MycoRequestContext,
): GroveProjectId | null;
export function rowProjectIdFromRequestContext(
  context: MycoRequestContext | undefined,
): GroveProjectId | null | undefined;
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
  if (!isProjectScopedTenancy(context) || !context.groveId) return GLOBAL_SCOPE;
  if (context.projectId) return projectScope(context.projectId);
  // Caller-asserted Grove tenancy with NO project id (the external MCP
  // listener's served-grove default, Task 10 Fix Round 1) — the safe,
  // narrow widening: `context.databasePath` is already scoped to this ONE
  // Grove's own DB (see `resolveRegisteredRequestContext`'s grove-only
  // branch), so "all projects" never crosses a Grove boundary. This branch
  // was unreachable before that widening — every other caller-tenancy
  // resolver path supplies both ids together or neither.
  return ALL_PROJECTS_SCOPE;
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
  // Provenance to stamp on a successfully registry-validated manifest
  // resolution. Defaults to 'synthesized': for the daemon's no-header /
  // bootstrap-anchor fallback paths, a manifest resolved from the SERVER's
  // own vault is the daemon's assertion, not the caller's. Launch-context
  // entry points (the `myco` CLI, which resolves its vault by walking up from
  // the caller's cwd) pass 'caller' so a project the caller is physically
  // inside is honored as caller-supplied tenancy. Resolution still runs through
  // `findRegisteredProject` either way, so an unregistered/unbound vault never
  // reaches this stamp — the anchor cannot masquerade as caller tenancy.
  tenancySource: TenancySource = 'synthesized',
  enforceGroveOwnership = false,
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
    tenancySource,
    enforceGroveOwnership,
    projectRoot: registered.project.root,
    projectId: assertGroveProjectId(registered.project.project_id),
    grove: registered.grove,
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
  enforceGroveOwnership: boolean,
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
    enforceGroveOwnership,
    projectRoot: registered.project.root,
    projectId: assertGroveProjectId(projectId),
    grove: registered.grove,
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
  enforceGroveOwnership: boolean,
  tolerateAttachedProject: boolean,
): MycoRequestContext {
  const inputProjectRoot = input.projectRoot ? path.resolve(input.projectRoot) : null;
  const manifestFromInputRoot = inputProjectRoot
    ? readManifest(resolveProjectVaultDir(inputProjectRoot))
    : null;
  const projectId = input.projectId ?? manifestFromInputRoot?.project.id;
  const groveId = input.groveId;
  if (!groveId) {
    throw new Error('Incomplete Myco request context: missing Grove id');
  }

  const mycoHome = resolveMycoHome();
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new UnknownRequestContextError(`Unknown Grove in request context: ${groveId}`);

  if (manifestFromInputRoot && projectId && manifestFromInputRoot.project.id !== projectId) {
    throw new Error(`Request context project id ${projectId} does not match project.toml id ${manifestFromInputRoot.project.id}`);
  }

  if (!projectId) {
    // Grove-scoped, project-less caller tenancy (server-mode external MCP
    // contract, Task 10 Fix Round 1: server-mode-e1#external-surface-tenancy):
    // the caller named a Grove but no project. Every OTHER header-resolution
    // branch requires both ids together — before this widening, omitting
    // `project id` here always threw "Incomplete Myco request context",
    // so no existing caller could reach this branch or rely on the throw.
    // `projectScopeFromRequestContext` reads `groveId set + projectId null`
    // as ALL_PROJECTS_SCOPE (grove-wide), which is safe specifically because
    // the resolved `databasePath` below is already the ONE Grove's own DB —
    // "all projects" never crosses a Grove boundary.
    if (enforceGroveOwnership && !groveOwnedByThisDaemon(grove, mycoHome)) {
      throw new ForeignGroveError(grove.id);
    }
    return {
      ...fallback,
      projectRoot: resolveGroveDir(grove.id, mycoHome),
      callerRoot: fallback.callerRoot,
      projectId: null,
      groveId: grove.id,
      machineId: input.machineId ?? fallback.machineId,
      sessionId: input.sessionId ?? fallback.sessionId,
      projectVaultDir: resolveGroveDir(grove.id, mycoHome),
      databasePath: resolveGroveDbPath(grove.id, mycoHome),
      source,
      tenancySource,
    };
  }

  const registered = findRegisteredProject({
    projectId,
    groveId: grove.id,
    bindingId: manifestFromInputRoot?.grove?.binding_id ?? null,
    projectRoot: inputProjectRoot,
  }, mycoHome);
  if (!registered) {
    // Team Host member local-dispatch tolerance (E-4 local-view requirement):
    // the caller named a project with no local Grove row against an existing
    // LOCAL Grove (validated above). If that project is ATTACHED to a remote
    // host, it legitimately has no local row (the never-materialize invariant),
    // yet it can be the member's ACTIVE UI selection — so every `localhost-only`
    // route then carries (localGroveId, attachedProjectId) and would 404 here.
    // Resolve a display-only, grove-scoped, project-LESS-at-the-DB context so
    // machine-scoped surfaces serve. `resolveAttach` is a pure disk read (no
    // host dial); a non-attached miss falls through to the unchanged throw.
    if (tolerateAttachedProject && resolveAttach(projectId)) {
      if (enforceGroveOwnership && !groveOwnedByThisDaemon(grove, mycoHome)) {
        throw new ForeignGroveError(grove.id);
      }
      // Mirror the grove-scoped/project-less branch above: `databasePath` is the
      // member's own local display Grove DB, NOT a project vault (an attached
      // project has none) — so nothing binds or creates a local project vault,
      // and project-scoped reads resolve to zero local rows (correct: the
      // project's data lives on the host). `projectId` is retained for the
      // handlers/observability that key on it, and `attachedProject` marks the
      // context so it is never mistaken for a locally-registered project.
      return {
        ...fallback,
        projectRoot: resolveGroveDir(grove.id, mycoHome),
        callerRoot: fallback.callerRoot,
        projectId: assertGroveProjectId(projectId),
        groveId: grove.id,
        machineId: input.machineId ?? fallback.machineId,
        sessionId: input.sessionId ?? fallback.sessionId,
        projectVaultDir: resolveGroveDir(grove.id, mycoHome),
        databasePath: resolveGroveDbPath(grove.id, mycoHome),
        source,
        tenancySource,
        attachedProject: true,
      };
    }
    throw new UnknownRequestContextError(`Project ${projectId} is not registered in Grove ${grove.id}`);
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
    enforceGroveOwnership,
    projectRoot: registeredRoot,
    projectId: assertGroveProjectId(projectId),
    grove,
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
  /**
   * Daemon-side ownership gate (see RequestContextAuthOptions). Every
   * registered-context branch funnels through here, so one check covers
   * the grove-id header path, both manifest paths, and URL tenancy.
   */
  enforceGroveOwnership: boolean;
  projectRoot: string;
  projectId: GroveProjectId;
  grove: GroveRecord;
  machineId: string;
  sessionId: string | null;
  manifest: ProjectManifest | null;
}): MycoRequestContext {
  if (input.enforceGroveOwnership && !groveOwnedByThisDaemon(input.grove)) {
    throw new ForeignGroveError(input.grove.id);
  }
  const projectRoot = path.resolve(input.projectRoot);
  const projectVaultDir = resolveProjectVaultDir(projectRoot);
  if (input.manifest && input.manifest.project.id !== input.projectId) {
    throw new Error(`Registered project ${input.projectId} does not match project.toml id ${input.manifest.project.id}`);
  }
  return {
    ...input.fallback,
    projectRoot,
    projectId: input.projectId,
    groveId: input.grove.id,
    machineId: input.machineId,
    sessionId: input.sessionId,
    projectVaultDir,
    databasePath: resolveGroveDbPath(input.grove.id),
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
