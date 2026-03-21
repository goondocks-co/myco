import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MycoIndex } from '../../index/sqlite.js';
import type { VectorIndex } from '../../index/vectors.js';
import type { MycoConfig } from '../../config/schema.js';
import { gatherStats } from '../../services/stats.js';
import type { RouteResponse } from '../router.js';
import type { Metabolism } from '../digest.js';
import { CONFIG_FILENAME } from '../../config/loader.js';

export interface StatsHandlerDeps {
  vaultDir: string;
  index: MycoIndex;
  vectorIndex: VectorIndex | null;
  version: string;
  config: MycoConfig;
  configHash: string;
  metabolism?: Metabolism | null;
}

export async function handleGetStats(deps: StatsHandlerDeps): Promise<RouteResponse> {
  const baseStats = gatherStats(deps.vaultDir, deps.index, deps.vectorIndex ?? undefined);

  // Digest state — match the spec's StatsResponse shape
  const digestConfig = deps.config.digest;
  const digest = {
    enabled: digestConfig.enabled,
    consolidation_enabled: digestConfig.consolidation,
    metabolism_state: deps.metabolism?.state ?? null,
    last_cycle: null as { timestamp: string; tier: number; substrate_count: number } | null,
    substrate_queue: 0,
  };

  return {
    body: {
      daemon: {
        ...baseStats.daemon,
        pid: baseStats.daemon?.pid ?? process.pid,
        port: baseStats.daemon?.port ?? 0,
        version: deps.version,
        uptime_seconds: process.uptime(),
        active_sessions: baseStats.daemon?.active_sessions ?? [],
        config_hash: deps.configHash,
      },
      vault: baseStats.vault,
      index: baseStats.index,
      digest,
      intelligence: {
        processor: {
          provider: deps.config.intelligence.llm.provider,
          model: deps.config.intelligence.llm.model,
        },
        digest: digestConfig.intelligence.provider ? {
          provider: digestConfig.intelligence.provider,
          model: digestConfig.intelligence.model ?? deps.config.intelligence.llm.model,
        } : null,
        embedding: {
          provider: deps.config.intelligence.embedding.provider,
          model: deps.config.intelligence.embedding.model,
        },
      },
    },
  };
}

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
