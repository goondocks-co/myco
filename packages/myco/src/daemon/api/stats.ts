import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILENAME } from '../../config/loader.js';
import { gatherStats } from '@myco/services/stats.js';
import { loadProjectManifest, type ProjectManifest } from '@myco/config/project-manifest.js';
import { resolveMycoHome } from '@myco/grove/paths.js';
import { listGroves, type GroveRecord } from '@myco/grove/registry.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import { projectScopeFromRequestContext, type MycoRequestContext } from '@myco/tools/request-context.js';
import type { RouteHandler, RouteResponse } from '../router.js';

/** Compute config hash from the YAML file on disk. Cache this at startup and after saves. */
export function computeConfigHash(vaultDir: string): string {
  try {
    const configPath = path.join(vaultDir, CONFIG_FILENAME);
    const raw = fs.readFileSync(configPath, 'utf-8');
    return createHash('md5').update(raw).digest('hex');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Live stats factory
// ---------------------------------------------------------------------------

export interface LiveStatsDeps {
  vaultDir: string;
  registry: { sessions: string[] };
  server: { port: number; version: string };
  configHash: { get(): string };
}

export interface StatsContext {
  project: {
    id: string;
    name: string;
    root: string;
    manifest_state: 'present' | 'missing' | 'invalid';
  };
  grove: {
    id: string | null;
    name: string | null;
    slug: string | null;
    mode: 'local' | null;
    binding_id: string | null;
    connection_state: 'local-only' | 'pending' | 'legacy';
  };
  request: {
    source: string;
    project_id: string;
    grove_id: string | null;
    machine_id: string;
    session_id: string | null;
  };
}

export function createLiveStatsHandler(deps: LiveStatsDeps): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const statsVaultDir = req.requestContext?.projectVaultDir ?? deps.vaultDir;
    const scope = projectScopeFromRequestContext(req.requestContext);
    // The daemon's request middleware pins the per-Grove DB handle via
    // withDatabase(requestDb, ...) before invoking the route handler, so
    // gatherStats picks it up via getDatabase() — no need to re-open.
    const stats = gatherStats(statsVaultDir, {
      active_sessions: deps.registry.sessions,
      scope,
    });
    // Overlay live daemon fields from the running process (more accurate than daemon.json)
    stats.daemon.pid = process.pid;
    stats.daemon.port = deps.server.port;
    stats.daemon.version = deps.server.version;
    stats.daemon.uptime_seconds = Math.floor(process.uptime());
    return {
      body: {
        ...stats,
        context: resolveStatsContext(statsVaultDir, req.requestContext),
        config_hash: statsVaultDir === deps.vaultDir ? deps.configHash.get() : computeConfigHash(statsVaultDir),
      },
    };
  };
}

export function resolveStatsContext(
  vaultDir: string,
  requestContext?: MycoRequestContext,
): StatsContext {
  const { manifest, state } = readProjectManifestForStats(vaultDir);
  const projectRoot = requestContext?.projectRoot ?? resolveProjectRoot(vaultDir);
  const projectId = manifest?.project.id ?? requestContext?.projectId ?? projectRoot;
  const projectName = manifest?.project.name ?? path.basename(projectRoot);
  const groves = readGrovesForStats();
  const grove = resolveStatsGrove(groves, manifest, requestContext);
  const manifestGrove = manifest?.grove ?? null;
  const requestedGroveId = requestContext?.groveId ?? null;
  const hasGroveHint = Boolean(grove || requestedGroveId || manifestGrove?.binding_id || manifestGrove?.slug);

  return {
    project: {
      id: projectId,
      name: projectName,
      root: projectRoot,
      manifest_state: state,
    },
    grove: {
      id: grove?.id ?? requestedGroveId,
      name: grove?.name ?? null,
      slug: grove?.slug ?? manifestGrove?.slug ?? null,
      mode: grove?.mode ?? manifestGrove?.mode ?? null,
      binding_id: manifestGrove?.binding_id ?? null,
      connection_state: grove ? 'local-only' : hasGroveHint ? 'pending' : 'legacy',
    },
    request: {
      source: requestContext?.source ?? 'legacy-vault',
      project_id: requestContext?.projectId ?? projectId,
      grove_id: requestedGroveId,
      machine_id: requestContext?.machineId ?? '',
      session_id: requestContext?.sessionId ?? null,
    },
  };
}

function readProjectManifestForStats(vaultDir: string): {
  manifest: ProjectManifest | null;
  state: StatsContext['project']['manifest_state'];
} {
  try {
    const manifest = loadProjectManifest(vaultDir);
    return { manifest, state: manifest ? 'present' : 'missing' };
  } catch {
    return { manifest: null, state: 'invalid' };
  }
}

function readGrovesForStats(): GroveRecord[] {
  try {
    return listGroves(resolveMycoHome());
  } catch {
    return [];
  }
}

function resolveStatsGrove(
  groves: GroveRecord[],
  manifest: ProjectManifest | null,
  requestContext?: MycoRequestContext,
): GroveRecord | null {
  const requestedGroveId = requestContext?.groveId ?? null;
  if (requestedGroveId) {
    const byId = groves.find((grove) => grove.id === requestedGroveId);
    if (byId) return byId;
  }
  const manifestSlug = manifest?.grove?.slug ?? null;
  if (!manifestSlug) return null;
  return groves.find((grove) => grove.slug === manifestSlug) ?? null;
}
