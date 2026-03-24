/**
 * Vault statistics — gathered from PGlite (v2).
 */

import { getDatabase } from '@myco/db/client.js';
import { getEmbeddingQueueDepth } from '@myco/db/queries/embeddings.js';
import { loadConfig } from '@myco/config/loader.js';
import { isProcessAlive } from '@myco/cli/shared.js';
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
// Public API
// ---------------------------------------------------------------------------

export async function gatherStats(vaultDir: string, options?: { active_sessions?: string[] }): Promise<V2Stats> {
  const db = getDatabase();

  // Load config for embedding provider info (sync — already on disk)
  const config = loadConfig(vaultDir);

  // Run all independent COUNT queries in parallel
  const [
    sessionResult,
    batchResult,
    sporeResult,
    planResult,
    artifactResult,
    entityResult,
    edgeResult,
    embeddingStats,
    unprocessedBatchResult,
    agentRunResult,
    agentTotalResult,
    digestResult,
  ] = await Promise.all([
    db.query('SELECT COUNT(*) AS cnt FROM sessions'),
    db.query('SELECT COUNT(*) AS cnt FROM prompt_batches'),
    db.query('SELECT COUNT(*) AS cnt FROM spores'),
    db.query('SELECT COUNT(*) AS cnt FROM plans'),
    db.query('SELECT COUNT(*) AS cnt FROM artifacts'),
    db.query('SELECT COUNT(*) AS cnt FROM entities'),
    db.query('SELECT COUNT(*) AS cnt FROM edges'),
    // Shared embedding queue depth helper (consistent filter logic)
    getEmbeddingQueueDepth(),
    // Unprocessed batches
    db.query('SELECT COUNT(*) AS cnt FROM prompt_batches WHERE processed = 0'),
    // Most recent agent run
    db.query('SELECT started_at, status FROM agent_runs ORDER BY started_at DESC LIMIT 1'),
    // Total agent runs
    db.query('SELECT COUNT(*) AS cnt FROM agent_runs'),
    // Digest extracts: tiers and freshest
    db.query('SELECT tier, generated_at FROM digest_extracts ORDER BY tier ASC'),
  ]);

  const session_count = (sessionResult.rows[0] as Record<string, unknown>).cnt as number;
  const batch_count = (batchResult.rows[0] as Record<string, unknown>).cnt as number;
  const spore_count = (sporeResult.rows[0] as Record<string, unknown>).cnt as number;
  const plan_count = (planResult.rows[0] as Record<string, unknown>).cnt as number;
  const artifact_count = (artifactResult.rows[0] as Record<string, unknown>).cnt as number;
  const entity_count = (entityResult.rows[0] as Record<string, unknown>).cnt as number;
  const edge_count = (edgeResult.rows[0] as Record<string, unknown>).cnt as number;

  const { queue_depth, embedded_count, total: total_embeddable } = embeddingStats;

  const unprocessed_batches = Number((unprocessedBatchResult.rows[0] as Record<string, unknown>).cnt ?? 0);

  // Agent: last run
  const lastRun = agentRunResult.rows[0] as Record<string, unknown> | undefined;
  const last_run_at = lastRun ? (lastRun.started_at as number | null) : null;
  const last_run_status = lastRun ? (lastRun.status as string | null) : null;
  const total_runs = Number((agentTotalResult.rows[0] as Record<string, unknown>).cnt ?? 0);

  // Digest: available tiers and freshest
  const digestRows = digestResult.rows as Array<Record<string, unknown>>;
  const tiers_available = digestRows.map((r) => r.tier as number);
  const freshest_tier = tiers_available.length > 0 ? Math.max(...tiers_available) : null;
  const freshestRow = digestRows.find((r) => r.tier === freshest_tier);
  const generated_at = freshestRow ? (freshestRow.generated_at as number) : null;

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
