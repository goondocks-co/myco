import { MycoIndex } from '../index/sqlite.js';
import { gatherStats } from '../services/stats.js';
import fs from 'node:fs';
import path from 'node:path';

export function run(_args: string[], vaultDir: string): void {
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));

  const stats = gatherStats(vaultDir, index);

  console.log('=== Myco Vault ===');
  console.log(`Path: ${stats.vault.path}`);
  console.log();
  console.log('--- Index ---');
  console.log(`Sessions:  ${stats.vault.session_count}`);
  console.log(`Spores:    ${Object.values(stats.vault.spore_counts).reduce((a, b) => a + b, 0)}`);
  console.log(`Plans:     ${stats.vault.plan_count}`);

  if (Object.keys(stats.vault.spore_counts).length > 0) {
    console.log('\n--- Spores by Type ---');
    for (const [t, c] of Object.entries(stats.vault.spore_counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t}: ${c}`);
    }
  }

  const vecDb = path.join(vaultDir, 'vectors.db');
  if (fs.existsSync(vecDb)) {
    console.log(`\n--- Vectors ---`);
    console.log(`Embeddings: ${stats.index.vector_count}`);
  } else {
    console.log('\nVectors: not initialized');
  }

  if (stats.daemon) {
    const d = stats.daemon;
    console.log(`\n--- Daemon ---`);
    console.log(`PID:      ${d.pid} (${d.alive ? 'running' : 'dead'})`);
    console.log(`Port:     ${d.port}`);
    console.log(`Started:  ${d.started}`);
    console.log(`Sessions: ${d.active_sessions.length}`);
  }

  index.close();
}
