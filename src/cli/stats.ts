/**
 * CLI: myco stats — display vault statistics.
 *
 * Opens the SQLite database directly (WAL mode allows concurrent reads).
 * Does NOT require the daemon to be running.
 */

import type { V2Stats } from '../services/stats.js';
import { gatherStats } from '../services/stats.js';
import { initVaultDb } from './shared.js';

export async function run(_args: string[], vaultDir: string): Promise<void> {
  const cleanup = initVaultDb(vaultDir);
  let stats: V2Stats;
  try {
    stats = gatherStats(vaultDir);
  } catch (err) {
    cleanup();
    console.error('Failed to read vault database:', (err as Error).message);
    process.exit(1);
  }
  cleanup();

  console.log('=== Myco Vault ===');
  console.log(`Path:  ${stats.vault.path}`);
  console.log(`Name:  ${stats.vault.name}`);

  console.log('\n--- Data ---');
  console.log(`Sessions:   ${stats.vault.session_count}`);
  console.log(`Batches:    ${stats.vault.batch_count}`);
  console.log(`Spores:     ${stats.vault.spore_count}`);
  console.log(`Plans:      ${stats.vault.plan_count}`);
  console.log(`Artifacts:  ${stats.vault.artifact_count}`);
  console.log(`Entities:   ${stats.vault.entity_count}`);
  console.log(`Edges:      ${stats.vault.edge_count}`);

  console.log('\n--- Embeddings ---');
  console.log(`Provider:   ${stats.embedding.provider} (${stats.embedding.model})`);
  console.log(`Embedded:   ${stats.embedding.embedded_count} / ${stats.embedding.total_embeddable}`);
  if (stats.embedding.queue_depth > 0) {
    console.log(`Queue:      ${stats.embedding.queue_depth} pending`);
  }

  console.log('\n--- Agent ---');
  if (stats.agent.total_runs === 0) {
    console.log('No runs yet');
  } else {
    const lastAt = stats.agent.last_run_at
      ? new Date(stats.agent.last_run_at * 1000).toISOString()
      : 'never';
    console.log(`Last run:   ${lastAt} (${stats.agent.last_run_status ?? 'unknown'})`);
    console.log(`Total runs: ${stats.agent.total_runs}`);
  }
  if (stats.unprocessed_batches > 0) {
    console.log(`Pending:    ${stats.unprocessed_batches} unprocessed batch(es)`);
  }

  console.log('\n--- Digest ---');
  if (stats.digest.tiers_available.length === 0) {
    console.log('No digest extracts yet');
  } else {
    const generatedAt = stats.digest.generated_at
      ? new Date(stats.digest.generated_at * 1000).toISOString()
      : 'unknown';
    console.log(`Tiers:      ${stats.digest.tiers_available.join(', ')}`);
    console.log(`Freshest:   tier ${stats.digest.freshest_tier} (generated ${generatedAt})`);
  }

  // Daemon section — from the live daemon stats
  const { pid, port, version, uptime_seconds, active_sessions } = stats.daemon;
  if (pid > 0) {
    console.log('\n--- Daemon ---');
    console.log(`PID:       ${pid} (running)`);
    console.log(`Port:      ${port}`);
    if (version) console.log(`Version:   ${version}`);
    if (uptime_seconds > 0) {
      console.log(`Uptime:    ${formatUptime(uptime_seconds)}`);
    }
    console.log(`Dashboard: http://localhost:${port}/`);
    console.log(`Sessions:  ${active_sessions.length}`);
  }
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
