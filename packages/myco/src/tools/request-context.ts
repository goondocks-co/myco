import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { getMachineId } from '@myco/daemon/machine-id.js';
import { vaultDbPath } from '@myco/db/client.js';
import { resolveCanopyProjectId } from '@myco/canopy/identity.js';
import { loadProjectManifest, type ProjectManifest } from '@myco/config/project-manifest.js';
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
  projectId: string;
  groveId: string | null;
  machineId: string;
  sessionId: string | null;
  projectVaultDir: string;
  databasePath: string;
  source: RequestContextSource;
}

export interface LegacyRequestContextOptions {
  projectRoot?: string;
  projectId?: string;
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

export function resolveLegacyRequestContext(
  vaultDir: string,
  options: LegacyRequestContextOptions = {},
): MycoRequestContext {
  const projectRoot = options.projectRoot ?? resolveProjectRoot(vaultDir);
  return {
    projectRoot,
    projectId: options.projectId ?? resolveCanopyProjectId(vaultDir),
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
  const fallback = resolveLegacyRequestContext(fallbackVaultDir);
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
  const fallbackProjectRoot = resolveProjectRoot(fallbackVaultDir);
  const fallback: MycoRequestContext = {
    projectRoot: fallbackProjectRoot,
    projectId: resolveCanopyProjectId(fallbackVaultDir),
    groveId: null,
    machineId: machineId ?? getMachineId(fallbackVaultDir),
    sessionId: sessionId ?? null,
    projectVaultDir: fallbackVaultDir,
    databasePath: vaultDbPath(fallbackVaultDir),
    source: 'legacy-vault',
  };
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
): string | null | undefined {
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
    projectId: registered.project.project_id,
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
  const projectRoot = input.projectRoot ?? fallback.projectRoot;
  const projectId = input.projectId ?? readManifest(resolveProjectVaultDir(projectRoot))?.project.id;
  const groveId = input.groveId;
  const missing: string[] = [];
  if (!projectRoot) missing.push('project root');
  if (!projectId) missing.push('project id');
  if (!groveId) missing.push('Grove id');
  if (missing.length > 0) {
    throw new Error(`Incomplete Myco request context: missing ${missing.join(', ')}`);
  }

  const normalizedRoot = path.resolve(projectRoot);
  const mycoHome = resolveMycoHome();
  const grove = loadGroveRecord(groveId!, mycoHome);
  if (!grove) throw new Error(`Unknown Grove in request context: ${groveId}`);

  const manifest = readManifest(resolveProjectVaultDir(normalizedRoot));
  if (manifest && manifest.project.id !== projectId) {
    throw new Error(`Request context project id ${projectId} does not match project.toml id ${manifest.project.id}`);
  }

  const registered = findRegisteredProject({
    projectId: projectId!,
    groveId: grove.id,
    bindingId: manifest?.grove?.binding_id ?? null,
    projectRoot: normalizedRoot,
  }, mycoHome);
  if (!registered) {
    throw new Error(`Project ${projectId} is not registered in Grove ${grove.id}`);
  }

  return buildRegisteredRequestContext({
    fallback,
    source,
    projectRoot: normalizedRoot,
    projectId: projectId!,
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
  projectId: string;
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
