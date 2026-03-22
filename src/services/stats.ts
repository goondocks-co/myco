/**
 * Vault statistics — gathered from PGlite.
 */

import { getDatabase } from '@myco/db/client.js';
import { isProcessAlive } from '@myco/cli/shared.js';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VaultStats {
  vault: {
    path: string;
    name: string;
    spore_counts: Record<string, number>;
    session_count: number;
    plan_count: number;
    artifact_count: number;
  };
  index: {
    embedded_sessions: number;
    embedded_spores: number;
  };
  daemon: {
    pid: number;
    port: number;
    started: string;
    active_sessions: string[];
    alive: boolean;
  } | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function gatherStats(vaultDir: string): Promise<VaultStats> {
  const db = getDatabase();

  // Run all independent COUNT queries in parallel
  const [sessionResult, planResult, artifactResult, sporeResult, embSessionResult, embSporeResult] = await Promise.all([
    db.query('SELECT COUNT(*) AS cnt FROM sessions'),
    db.query('SELECT COUNT(*) AS cnt FROM plans'),
    db.query('SELECT COUNT(*) AS cnt FROM artifacts'),
    db.query('SELECT observation_type, COUNT(*) AS cnt FROM spores GROUP BY observation_type'),
    db.query('SELECT COUNT(*) AS cnt FROM sessions WHERE embedding IS NOT NULL'),
    db.query('SELECT COUNT(*) AS cnt FROM spores WHERE embedding IS NOT NULL'),
  ]);

  const session_count = (sessionResult.rows[0] as Record<string, unknown>).cnt as number;
  const plan_count = (planResult.rows[0] as Record<string, unknown>).cnt as number;
  const artifact_count = (artifactResult.rows[0] as Record<string, unknown>).cnt as number;

  const spore_counts: Record<string, number> = {};
  for (const row of sporeResult.rows as Record<string, unknown>[]) {
    spore_counts[row.observation_type as string] = row.cnt as number;
  }

  const embedded_sessions = (embSessionResult.rows[0] as Record<string, unknown>).cnt as number;
  const embedded_spores = (embSporeResult.rows[0] as Record<string, unknown>).cnt as number;

  // Daemon info
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
      session_count,
      plan_count,
      artifact_count,
    },
    index: {
      embedded_sessions,
      embedded_spores,
    },
    daemon,
  };
}
