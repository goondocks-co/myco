import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { getMachineId } from '@myco/daemon/machine-id.js';
import { vaultDbPath } from '@myco/db/client.js';
import { loadProjectManifest, type ProjectManifest } from '@myco/config/project-manifest.js';
import { assertGroveProjectId, type GroveProjectId } from '@myco/grove/ids.js';
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
  const fallback = resolveRequestContextForVault(fallbackVaultDir);
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
    return resolveLegacyHeaderRequestContext(explicit, fallback);
  }

  return resolveManifestRequestContext(fallback, 'headers') ?? fallback;
}

export function requestContextFromEnvironment(
  env: Record<string, string | undefined>,
  fallbackVaultDir: string,
): MycoRequestContext {
  const machineId = readEnv(env, REQUEST_CONTEXT_ENV.machineId);
  const sessionId = readEnv(env, REQUEST_CONTEXT_ENV.sessionId);
  const fallback = resolveRequestContextForVault(fallbackVaultDir, { machineId, sessionId });
  const hasExplicitProjectContext = [
    REQUEST_CONTEXT_ENV.projectRoot,
    REQUEST_CONTEXT_ENV.projectId,
    REQUEST_CONTEXT_ENV.groveId,
  ].some((key) => readEnv(env, key) !== undefined);

  if (!hasExplicitProjectContext) {
    return resolveManifestRequestContext(fallback, 'explicit') ?? fallback;
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
 */
export function resolveRequestContextForVault(
  vaultDir: string,
  overrides: { machineId?: string; sessionId?: string | null } = {},
): MycoRequestContext {
  const projectRoot = resolveProjectRoot(vaultDir);
  const manifest = readManifest(vaultDir);
  if (!manifest?.project?.id) {
    throw new Error(
      `No Grove project id available for vault ${vaultDir}. Run \`myco init\` to activate a Grove for this project.`,
    );
  }
  return {
    projectRoot,
    projectId: assertGroveProjectId(manifest.project.id),
    groveId: null,
    machineId: overrides.machineId ?? getMachineId(vaultDir),
    sessionId: overrides.sessionId ?? null,
    projectVaultDir: vaultDir,
    databasePath: vaultDbPath(vaultDir),
    source: 'legacy-vault',
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
): MycoRequestContext | null {
  const manifest = readManifest(fallback.projectVaultDir);
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
    projectId: assertGroveProjectId(input.projectId),
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
