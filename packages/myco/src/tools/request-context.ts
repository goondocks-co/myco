import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { getMachineId } from '@myco/daemon/machine-id.js';
import { vaultDbPath } from '@myco/db/client.js';
import { resolveCanopyProjectId } from '@myco/canopy/identity.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';

export const REQUEST_CONTEXT_HEADERS = {
  projectRoot: 'x-myco-project-root',
  projectId: 'x-myco-project-id',
  groveId: 'x-myco-grove-id',
  machineId: 'x-myco-machine-id',
  sessionId: 'x-myco-session-id',
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
  const hasContextHeader = Object.values(REQUEST_CONTEXT_HEADERS)
    .some((header) => readHeader(headers, header) !== undefined);

  if (!hasContextHeader) return fallback;

  const projectRoot = readHeader(headers, REQUEST_CONTEXT_HEADERS.projectRoot) ?? fallback.projectRoot;
  const projectVaultDir = projectRoot === fallback.projectRoot
    ? fallback.projectVaultDir
    : path.join(projectRoot, '.myco');

  return {
    ...fallback,
    projectRoot,
    projectId: readHeader(headers, REQUEST_CONTEXT_HEADERS.projectId) ?? fallback.projectId,
    groveId: readHeader(headers, REQUEST_CONTEXT_HEADERS.groveId) ?? fallback.groveId,
    machineId: readHeader(headers, REQUEST_CONTEXT_HEADERS.machineId) ?? fallback.machineId,
    sessionId: readHeader(headers, REQUEST_CONTEXT_HEADERS.sessionId) ?? fallback.sessionId,
    projectVaultDir,
    databasePath: vaultDbPath(projectVaultDir),
    source: 'headers',
  };
}

function compactHeaders(values: Record<string, string | null | undefined>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    headers[key] = value;
  }
  return headers;
}

function readHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
