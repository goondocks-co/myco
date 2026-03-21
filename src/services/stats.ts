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
  const typeCounts = index.countByType();
  const spore_counts = index.sporeCountsByObservationType();

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
      session_count: typeCounts['session'] ?? 0,
      plan_count: typeCounts['plan'] ?? 0,
    },
    index: {
      fts_entries: Object.values(typeCounts).reduce((sum, n) => sum + n, 0),
      vector_count,
    },
    daemon,
  };
}
