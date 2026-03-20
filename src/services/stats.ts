import { MycoIndex } from '../index/sqlite.js';
import { VectorIndex } from '../index/vectors.js';
import { isProcessAlive } from '../cli/shared.js';
import fs from 'node:fs';
import path from 'node:path';

/** Fallback dimension for opening VectorIndex when the actual dimension is unknown. */
const VECTOR_FALLBACK_DIMENSION = 1024;

export interface VaultStats {
  vault: {
    path: string;
    name: string;
    spore_counts: Record<string, number>;
    session_count: number;
    plan_count: number;
  };
  index: {
    fts_entries: number;
    vector_count: number;
  };
  daemon: {
    pid: number;
    port: number;
    started: string;
    active_sessions: string[];
    alive: boolean;
  } | null;
}

export function gatherStats(vaultDir: string, index: MycoIndex, vectorIndex?: VectorIndex): VaultStats {
  const sessions = index.query({ type: 'session' });
  const spores = index.query({ type: 'spore' });
  const plans = index.query({ type: 'plan' });

  const spore_counts: Record<string, number> = {};
  for (const m of spores) {
    const t = (m.frontmatter as Record<string, unknown>)?.observation_type as string || 'unknown';
    spore_counts[t] = (spore_counts[t] || 0) + 1;
  }

  let vector_count = 0;
  if (vectorIndex) {
    vector_count = vectorIndex.count();
  } else {
    const vecDb = path.join(vaultDir, 'vectors.db');
    if (fs.existsSync(vecDb)) {
      try {
        const vec = new VectorIndex(vecDb, VECTOR_FALLBACK_DIMENSION);
        vector_count = vec.count();
        vec.close();
      } catch { /* ignore */ }
    }
  }

  let daemon: VaultStats['daemon'] = null;
  const daemonPath = path.join(vaultDir, 'daemon.json');
  if (fs.existsSync(daemonPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonPath, 'utf-8'));
      daemon = {
        pid: info.pid,
        port: info.port,
        started: info.started,
        active_sessions: info.sessions || [],
        alive: isProcessAlive(info.pid),
      };
    } catch { /* ignore */ }
  }

  return {
    vault: {
      path: vaultDir,
      name: path.basename(vaultDir),
      spore_counts,
      session_count: sessions.length,
      plan_count: plans.length,
    },
    index: {
      fts_entries: sessions.length + spores.length + plans.length,
      vector_count,
    },
    daemon,
  };
}
