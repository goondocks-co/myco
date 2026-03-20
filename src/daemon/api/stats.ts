import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MycoIndex } from '../../index/sqlite.js';
import type { VectorIndex } from '../../index/vectors.js';
import type { MycoConfig } from '../../config/schema.js';
import { gatherStats } from '../../services/stats.js';
import type { RouteResponse } from '../router.js';
import type { Metabolism } from '../digest.js';

const CONFIG_FILENAME = 'myco.yaml';

export interface StatsHandlerDeps {
  vaultDir: string;
  index: MycoIndex;
  vectorIndex: VectorIndex | null;
  version: string;
  config: MycoConfig;
  metabolism?: Metabolism | null;
}

export async function handleGetStats(deps: StatsHandlerDeps): Promise<RouteResponse> {
  const baseStats = gatherStats(deps.vaultDir, deps.index, deps.vectorIndex ?? undefined);

  // Config hash for change detection
  let configHash = '';
  try {
    const configPath = path.join(deps.vaultDir, CONFIG_FILENAME);
    const raw = fs.readFileSync(configPath, 'utf-8');
    configHash = createHash('md5').update(raw).digest('hex');
  } catch { /* config may be missing during tests */ }

  // Digest state
  let digest: Record<string, unknown> | undefined;
  if (deps.metabolism) {
    digest = {
      metabolism_state: deps.metabolism.state,
      interval_ms: deps.metabolism.currentIntervalMs,
    };
  }

  return {
    body: {
      ...baseStats,
      uptime_seconds: process.uptime(),
      version: deps.version,
      config_hash: configHash,
      intelligence: {
        llm: {
          provider: deps.config.intelligence.llm.provider,
          model: deps.config.intelligence.llm.model,
        },
        embedding: {
          provider: deps.config.intelligence.embedding.provider,
          model: deps.config.intelligence.embedding.model,
        },
      },
      digest,
    },
  };
}
