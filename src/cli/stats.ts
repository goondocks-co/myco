/**
 * CLI: myco stats — display vault statistics from PGlite.
 */

import { initDatabaseForVault } from '@myco/db/client.js';
import { gatherStats } from '@myco/services/stats.js';

export async function run(_args: string[], vaultDir: string): Promise<void> {
  await initDatabaseForVault(vaultDir);

  const stats = await gatherStats(vaultDir);

  console.log('=== Myco Vault ===');
  console.log(`Path: ${stats.vault.path}`);
  console.log();
  console.log('--- Data ---');
  console.log(`Sessions:  ${stats.vault.session_count}`);
  console.log(`Spores:    ${Object.values(stats.vault.spore_counts).reduce((a, b) => a + b, 0)}`);
  console.log(`Plans:     ${stats.vault.plan_count}`);

  if (Object.keys(stats.vault.spore_counts).length > 0) {
    console.log('\n--- Spores by Type ---');
    for (const [t, c] of Object.entries(stats.vault.spore_counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t}: ${c}`);
    }
  }

  console.log(`\n--- Embeddings ---`);
  console.log(`Sessions:  ${stats.index.embedded_sessions}`);
  console.log(`Spores:    ${stats.index.embedded_spores}`);

  if (stats.daemon) {
    const d = stats.daemon;
    console.log(`\n--- Daemon ---`);
    console.log(`PID:      ${d.pid} (${d.alive ? 'running' : 'dead'})`);
    console.log(`Port:     ${d.port}`);
    console.log(`Dashboard: http://localhost:${d.port}/`);
    console.log(`Started:  ${d.started}`);
    console.log(`Sessions: ${d.active_sessions.length}`);
  }
}
