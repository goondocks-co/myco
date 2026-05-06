/**
 * Vault statistics — gathered from SQLite.
 */

import { getDatabase, openDatabase, type Database } from '@myco/db/client.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import { getActiveSessionIds } from '@myco/db/queries/sessions.js';
import { getEmbeddingQueueDepth } from '@myco/db/queries/embeddings.js';
import { projectScopeClause } from '@myco/db/queries/project-scope.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { isProcessAlive } from '@myco/cli/shared.js';
import { DIGEST_TIERS } from '@myco/constants.js';
import { readDaemonState, resolveDaemonServiceState } from '@myco/daemon/service-state.js';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_SCOPED_COUNT_TABLES = new Set([
  'sessions',
  'prompt_batches',
  'spores',
  'plans',
  'artifacts',
  'entities',
  'graph_edges',
]);

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

export interface GatherStatsOptions {
  active_sessions?: string[];
  databasePath?: string;
  project_id?: string | null;
}

/**
 * Batch counts for the project-scoped tables in a single round-trip.
 * Same scope predicate applies to every table, so SQLite parameters are
 * appended once per UNION arm.
 */
function countProjectScopedTables(
  db: Database,
  projectId: string | null | undefined,
): Record<string, number> {
  const tables = Array.from(PROJECT_SCOPED_COUNT_TABLES);
  const scope = projectScopeClause(projectId);
  // The leading `WHERE 1 = 1` lets `scope.sql` (which always starts with ` AND`)
  // splice in cleanly whether or not a scope is active.
  const sql = tables
    .map((t) => `SELECT '${t}' AS t, COUNT(*) AS c FROM ${t} WHERE 1 = 1${scope.sql}`)
    .join(' UNION ALL ');
  const params: unknown[] = [];
  for (let i = 0; i < tables.length; i++) params.push(...scope.params);
  const rows = db.prepare(sql).all(...params) as Array<{ t: string; c: number }>;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.t] = Number(r.c);
  return counts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function gatherStats(vaultDir: string, options: GatherStatsOptions = {}): V2Stats {
  const ownsConnection = Boolean(options.databasePath);
  const db = options.databasePath ? openDatabase(options.databasePath) : getDatabase();
  const projectId = options.project_id;

  try {
    // Active sessions come from two sources: the live daemon registry, and
    // persisted DB rows still marked active (survives restarts). When scoped to
    // a project, the live registry might include sessions from other projects,
    // so intersect against the persisted (already-scoped) set.
    const persistedActiveSessionIds = getActiveSessionIds(projectId, db);
    const active_session_ids = projectId === undefined
      ? Array.from(new Set([...persistedActiveSessionIds, ...(options.active_sessions ?? [])]))
      : Array.from(persistedActiveSessionIds);

    const config = loadMergedConfig(vaultDir);

    const counts = countProjectScopedTables(db, projectId);

    const embeddingStats = getEmbeddingQueueDepth(projectId, db);
    const { queue_depth, embedded_count, total: total_embeddable } = embeddingStats;

    const scope = projectScopeClause(projectId);

    const unprocessedRow = db.prepare(
      `SELECT COUNT(*) AS cnt FROM prompt_batches WHERE processed = 0${scope.sql}`,
    ).get(...scope.params) as { cnt: number };
    const unprocessed_batches = Number(unprocessedRow.cnt ?? 0);

    const lastRun = db.prepare(
      `SELECT started_at, status FROM agent_runs WHERE 1 = 1${scope.sql} ORDER BY started_at DESC LIMIT 1`,
    ).get(...scope.params) as { started_at: number; status: string } | undefined;
    const last_run_at = lastRun ? lastRun.started_at : null;
    const last_run_status = lastRun ? lastRun.status : null;

    const agentTotalRow = db.prepare(
      `SELECT COUNT(*) AS cnt FROM agent_runs WHERE 1 = 1${scope.sql}`,
    ).get(...scope.params) as { cnt: number };
    const total_runs = Number(agentTotalRow.cnt ?? 0);

    const digestRows = db.prepare(
      `SELECT tier, generated_at FROM digest_extracts WHERE 1 = 1${scope.sql} ORDER BY tier ASC`,
    ).all(...scope.params) as Array<{ tier: number; generated_at: number }>;
    const configuredTiers = new Set<number>(DIGEST_TIERS);
    const activeDigestRows = digestRows.filter((r) => configuredTiers.has(r.tier));
    const tiers_available = activeDigestRows.map((r) => r.tier);
    const freshest_tier = tiers_available.length > 0 ? Math.max(...tiers_available) : null;
    const freshestRow = activeDigestRows.find((r) => r.tier === freshest_tier);
    const generated_at = freshestRow ? freshestRow.generated_at : null;

    let daemonPid = 0;
    let daemonPort = 0;
    let daemonVersion = '';
    let daemonUptimeSeconds = 0;
    const daemonPath = resolveDaemonServiceState(vaultDir, { env: process.env }).statePath;
    if (fs.existsSync(daemonPath)) {
      try {
        const info = readDaemonState(daemonPath);
        daemonPid = info?.pid ?? 0;
        daemonPort = info?.port ?? 0;
        daemonVersion = info?.version ?? '';
        // uptime: if daemon is alive, compute from started timestamp
        if (typeof info?.started === 'string' && isProcessAlive(daemonPid)) {
          const startedMs = new Date(info.started).getTime();
          daemonUptimeSeconds = Math.floor((Date.now() - startedMs) / 1000);
        }
      } catch { /* ignore corrupt daemon state */ }
    }

    return {
      daemon: {
        pid: daemonPid,
        port: daemonPort,
        version: daemonVersion,
        uptime_seconds: daemonUptimeSeconds,
        active_sessions: active_session_ids,
      },
      vault: {
        path: vaultDir,
        name: path.basename(resolveProjectRoot(vaultDir)),
        session_count: counts.sessions ?? 0,
        batch_count: counts.prompt_batches ?? 0,
        spore_count: counts.spores ?? 0,
        plan_count: counts.plans ?? 0,
        artifact_count: counts.artifacts ?? 0,
        entity_count: counts.entities ?? 0,
        edge_count: counts.graph_edges ?? 0,
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
  } finally {
    if (ownsConnection) db.close();
  }
}
