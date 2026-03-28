/**
 * Vault statistics — gathered from SQLite.
 */

import { getDatabase } from '@myco/db/client.js';
import { getEmbeddingQueueDepth } from '@myco/db/queries/embeddings.js';
import { loadConfig } from '@myco/config/loader.js';
import { isProcessAlive } from '@myco/cli/shared.js';
import { DIGEST_TIERS } from '@myco/constants.js';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Process uptime is available directly from the daemon process via process.uptime(). */
const DAEMON_JSON_FILENAME = 'daemon.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface V2Stats {
  daemon: {
    pid: number;
    port: number;
    version: string;
    uptime_seconds: number;
    active_sessions: string[];
  };
  vault: {
    path: string;
    name: string;
    session_count: number;
    batch_count: number;
    spore_count: number;
    plan_count: number;
    artifact_count: number;
    entity_count: number;
    edge_count: number;
  };
  embedding: {
    provider: string;
    model: string;
    queue_depth: number;
    embedded_count: number;
    total_embeddable: number;
  };
  agent: {
    last_run_at: number | null;
    last_run_status: string | null;
    total_runs: number;
  };
  digest: {
    freshest_tier: number | null;
    generated_at: number | null;
    tiers_available: number[];
  };
  unprocessed_batches: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count rows in a table (sync). */
function countTable(db: ReturnType<typeof getDatabase>, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number };
  return Number(row.cnt);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function gatherStats(vaultDir: string, options?: { active_sessions?: string[] }): V2Stats {
  const db = getDatabase();

  // Load config for embedding provider info (sync — already on disk)
  const config = loadConfig(vaultDir);

  // All queries are synchronous — no Promise.all needed
  const session_count = countTable(db, 'sessions');
  const batch_count = countTable(db, 'prompt_batches');
  const spore_count = countTable(db, 'spores');
  const plan_count = countTable(db, 'plans');
  const artifact_count = countTable(db, 'artifacts');
  const entity_count = countTable(db, 'entities');
  const edge_count = countTable(db, 'graph_edges');

  // Shared embedding queue depth helper (consistent filter logic)
  const embeddingStats = getEmbeddingQueueDepth();
  const { queue_depth, embedded_count, total: total_embeddable } = embeddingStats;

  // Unprocessed batches
  const unprocessedRow = db.prepare(
    'SELECT COUNT(*) AS cnt FROM prompt_batches WHERE processed = 0',
  ).get() as { cnt: number };
  const unprocessed_batches = Number(unprocessedRow.cnt ?? 0);

  // Agent: most recent run
  const lastRun = db.prepare(
    'SELECT started_at, status FROM agent_runs ORDER BY started_at DESC LIMIT 1',
  ).get() as { started_at: number; status: string } | undefined;
  const last_run_at = lastRun ? lastRun.started_at : null;
  const last_run_status = lastRun ? lastRun.status : null;

  // Total agent runs
  const agentTotalRow = db.prepare(
    'SELECT COUNT(*) AS cnt FROM agent_runs',
  ).get() as { cnt: number };
  const total_runs = Number(agentTotalRow.cnt ?? 0);

  // Digest extracts: only report tiers that are currently configured
  const digestRows = db.prepare(
    'SELECT tier, generated_at FROM digest_extracts ORDER BY tier ASC',
  ).all() as Array<{ tier: number; generated_at: number }>;
  const configuredTiers = new Set<number>(DIGEST_TIERS);
  const activeDigestRows = digestRows.filter((r) => configuredTiers.has(r.tier));
  const tiers_available = activeDigestRows.map((r) => r.tier);
  const freshest_tier = tiers_available.length > 0 ? Math.max(...tiers_available) : null;
  const freshestRow = activeDigestRows.find((r) => r.tier === freshest_tier);
  const generated_at = freshestRow ? freshestRow.generated_at : null;

  // Daemon info from daemon.json
  let daemonPid = 0;
  let daemonPort = 0;
  let daemonVersion = '';
  let daemonUptimeSeconds = 0;
  const daemonPath = path.join(vaultDir, DAEMON_JSON_FILENAME);
  if (fs.existsSync(daemonPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonPath, 'utf-8')) as Record<string, unknown>;
      daemonPid = (info.pid as number) ?? 0;
      daemonPort = (info.port as number) ?? 0;
      daemonVersion = (info.version as string) ?? '';
      // uptime: if daemon is alive, compute from started timestamp
      if (typeof info.started === 'string' && isProcessAlive(daemonPid)) {
        const startedMs = new Date(info.started as string).getTime();
        daemonUptimeSeconds = Math.floor((Date.now() - startedMs) / 1000);
      }
    } catch { /* ignore corrupt daemon.json */ }
  }

  return {
    daemon: {
      pid: daemonPid,
      port: daemonPort,
      version: daemonVersion,
      uptime_seconds: daemonUptimeSeconds,
      active_sessions: options?.active_sessions ?? [],
    },
    vault: {
      path: vaultDir,
      name: path.basename(vaultDir),
      session_count,
      batch_count,
      spore_count,
      plan_count,
      artifact_count,
      entity_count,
      edge_count,
    },
    embedding: {
      provider: config.embedding.provider,
      model: config.embedding.model,
      queue_depth,
      embedded_count,
      total_embeddable,
    },
    agent: {
      last_run_at,
      last_run_status,
      total_runs,
    },
    digest: {
      freshest_tier,
      generated_at,
      tiers_available,
    },
    unprocessed_batches,
  };
}
