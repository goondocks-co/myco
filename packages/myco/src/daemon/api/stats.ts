import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILENAME } from '../../config/loader.js';
import { gatherStats } from '@myco/services/stats.js';
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

export function createLiveStatsHandler(deps: LiveStatsDeps): RouteHandler {
  return async (): Promise<RouteResponse> => {
    const stats = gatherStats(deps.vaultDir, { active_sessions: deps.registry.sessions });
    // Overlay live daemon fields from the running process (more accurate than daemon.json)
    stats.daemon.pid = process.pid;
    stats.daemon.port = deps.server.port;
    stats.daemon.version = deps.server.version;
    stats.daemon.uptime_seconds = Math.floor(process.uptime());
    return { body: { ...stats, config_hash: deps.configHash.get() } };
  };
}
