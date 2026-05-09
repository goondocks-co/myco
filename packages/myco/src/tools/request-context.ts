import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { getMachineId } from '@myco/daemon/machine-id.js';
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
} as const;

export const REQUEST_CONTEXT_ENV = {
  projectRoot: 'MYCO_PROJECT_ROOT',
  projectId: 'MYCO_PROJECT_ID',
  groveId: 'MYCO_GROVE_ID',
  machineId: 'MYCO_MACHINE_ID',
  sessionId: 'MYCO_SESSION_ID',
} as const;

export type RequestContextSource = 'explicit' | 'headers' | 'legacy-vault';

export interface MycoRequestContext {
  projectRoot: string;
  projectId: GroveProjectId;
  groveId: string | null;
  machineId: string;
  sessionId: string | null;
  projectVaultDir: string;
  databasePath: string;
  source: RequestContextSource;
}

/** True iff the request is bound to a Grove (vs a legacy project-local vault). */
export function isGroveScoped(context: MycoRequestContext | undefined | null): boolean {
  return Boolean(context?.groveId);
}

export interface LegacyRequestContextOptions {
  projectRoot?: string;
  projectId?: GroveProjectId;
  groveId?: string | null;
  machineId?: string;
  sessionId?: string | null;
  source?: RequestContextSource;
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
 * must complete Grove activation first (see `myco init`).
 */
export function resolveLegacyRequestContext(
  vaultDir: string,
  options: LegacyRequestContextOptions & { projectId: GroveProjectId },
): MycoRequestContext {
  const projectRoot = options.projectRoot ?? resolveProjectRoot(vaultDir);
  return {
    projectRoot,
    projectId: assertGroveProjectId(options.projectId),
    groveId: options.groveId ?? null,
    machineId: options.machineId ?? process.env.MYCO_MACHINE_ID ?? getMachineId(vaultDir),
    sessionId: options.sessionId ?? process.env.MYCO_SESSION_ID ?? null,
    projectVaultDir: vaultDir,
    databasePath: vaultDbPath(vaultDir),
    source: options.source ?? 'legacy-vault',
  };
}

export function requestContextHeaders(context: MycoRequestContext): Record<string, string> {
  return compactHeaders({
    [REQUEST_CONTEXT_HEADERS.projectRoot]: context.projectRoot,
    [REQUEST_CONTEXT_HEADERS.projectId]: context.projectId,
    [REQUEST_CONTEXT_HEADERS.groveId]: context.groveId,
    [REQUEST_CONTEXT_HEADERS.machineId]: context.machineId,
    [REQUEST_CONTEXT_HEADERS.sessionId]: context.sessionId,
  });
}

export function requestContextFromHttpHeaders(
  headers: IncomingHttpHeaders,
  fallbackVaultDir: string,
): MycoRequestContext {
  const { context: fallback, manifest } = buildVaultFallback(fallbackVaultDir);
  const explicit: ExplicitContextInput = {
    projectRoot: readHeader(headers, REQUEST_CONTEXT_HEADERS.projectRoot),
    projectId: readHeader(headers, REQUEST_CONTEXT_HEADERS.projectId),
    groveId: readHeader(headers, REQUEST_CONTEXT_HEADERS.groveId),
    machineId: readHeader(headers, REQUEST_CONTEXT_HEADERS.machineId),
    sessionId: readHeader(headers, REQUEST_CONTEXT_HEADERS.sessionId) ?? null,
  };
  const hasContextHeader = Object.values(explicit).some((value) => value !== undefined && value !== null);

  if (hasContextHeader) {
    if (explicit.groveId) return resolveRegisteredRequestContext(explicit, fallback, 'headers');
    const manifestContext = resolveManifestHeaderRequestContext(explicit, fallback, 'headers');
    if (manifestContext) return manifestContext;
    return resolveLegacyHeaderRequestContext(explicit, fallback);
  }

  return resolveManifestRequestContext(fallback, 'headers', manifest) ?? fallback;
}

export function requestContextFromEnvironment(
  env: Record<string, string | undefined>,
  fallbackVaultDir: string,
): MycoRequestContext {
  const machineId = readEnv(env, REQUEST_CONTEXT_ENV.machineId);
  const sessionId = readEnv(env, REQUEST_CONTEXT_ENV.sessionId);
  const { context: fallback, manifest } = buildVaultFallback(fallbackVaultDir, { machineId, sessionId });
  const hasExplicitProjectContext = [
    REQUEST_CONTEXT_ENV.projectRoot,
    REQUEST_CONTEXT_ENV.projectId,
    REQUEST_CONTEXT_ENV.groveId,
  ].some((key) => readEnv(env, key) !== undefined);

  if (!hasExplicitProjectContext) {
    return resolveManifestRequestContext(fallback, 'explicit', manifest) ?? fallback;
  }

  return resolveRegisteredRequestContext({
    projectRoot: readEnv(env, REQUEST_CONTEXT_ENV.projectRoot),
    projectId: readEnv(env, REQUEST_CONTEXT_ENV.projectId),
    groveId: readEnv(env, REQUEST_CONTEXT_ENV.groveId),
    machineId,
    sessionId,
  }, fallback, 'explicit');
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
 * see a friendly "run `myco init`" message instead of `tool_call_failed`),
 * use `tryResolveRequestContextForVault` instead.
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
 * "run \`myco init\` to activate Grove features" instead of an
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
  overrides: { machineId?: string; sessionId?: string | null } = {},
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
  overrides: { machineId?: string; sessionId?: string | null } = {},
): { kind: 'grove'; context: MycoRequestContext; manifest: ProjectManifest } | { kind: 'legacy'; vaultDir: string; reason: string } {
  const manifest = readManifest(vaultDir);
  if (!manifest?.project?.id) {
    return {
      kind: 'legacy',
      vaultDir,
      reason: `No Grove project id available for vault ${vaultDir}. Run \`myco init\` to activate a Grove for this project.`,
    };
  }
  const projectRoot = resolveProjectRoot(vaultDir);
  return {
    kind: 'grove',
    context: {
      projectRoot,
      projectId: assertGroveProjectId(manifest.project.id),
      groveId: null,
      machineId: overrides.machineId ?? getMachineId(vaultDir),
      sessionId: overrides.sessionId ?? null,
      projectVaultDir: vaultDir,
      databasePath: vaultDbPath(vaultDir),
      source: 'legacy-vault',
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
  return context.groveId ? projectScope(context.projectId) : GLOBAL_SCOPE;
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
): MycoRequestContext {
  return {
    ...fallback,
    machineId: input.machineId ?? fallback.machineId,
    sessionId: input.sessionId ?? fallback.sessionId,
    source: 'headers',
  };
}

function buildRegisteredRequestContext(input: {
  fallback: MycoRequestContext;
  source: RequestContextSource;
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
  };
}

function readManifest(projectVaultDir: string): ProjectManifest | null {
  try {
    return loadProjectManifest(projectVaultDir);
  } catch {
    return null;
  }
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
