import { MycoIndex } from '../index/sqlite.js';
import { VectorIndex } from '../index/vectors.js';
import { isProcessAlive } from './shared.js';
import fs from 'node:fs';
import path from 'node:path';

export function run(_args: string[], vaultDir: string): void {
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));

  const sessions = index.query({ type: 'session' });
  const memories = index.query({ type: 'memory' });
  const plans = index.query({ type: 'plan' });

  console.log('=== Myco Vault ===');
  console.log(`Path: ${vaultDir}`);
  console.log();
  console.log('--- Index ---');
  console.log(`Sessions:  ${sessions.length}`);
  console.log(`Memories:  ${memories.length}`);
  console.log(`Plans:     ${plans.length}`);

  // Memory breakdown by type
  const types: Record<string, number> = {};
  for (const m of memories) {
    const t = (m.frontmatter as Record<string, unknown>)?.observation_type as string || 'unknown';
    types[t] = (types[t] || 0) + 1;
  }
  if (Object.keys(types).length > 0) {
    console.log('\n--- Memories by Type ---');
    for (const [t, c] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t}: ${c}`);
    }
  }

  // Vector index — need dimensions to open; read from daemon config or probe
  const vecDb = path.join(vaultDir, 'vectors.db');
  if (fs.existsSync(vecDb)) {
    try {
      // Use a common dimension; VectorIndex only needs it for CREATE IF NOT EXISTS
      const vec = new VectorIndex(vecDb, 1024);
      console.log(`\n--- Vectors ---`);
      console.log(`Embeddings: ${vec.count()}`);
      vec.close();
    } catch (e) {
      console.log(`\nVectors: error — ${(e as Error).message}`);
    }
  } else {
    console.log('\nVectors: not initialized');
  }

  // Daemon
  const daemonPath = path.join(vaultDir, 'daemon.json');
  if (fs.existsSync(daemonPath)) {
    try {
      const daemon = JSON.parse(fs.readFileSync(daemonPath, 'utf-8'));
      const alive = isProcessAlive(daemon.pid);
      console.log(`\n--- Daemon ---`);
      console.log(`PID:      ${daemon.pid} (${alive ? 'running' : 'dead'})`);
      console.log(`Port:     ${daemon.port}`);
      console.log(`Started:  ${daemon.started}`);
      console.log(`Sessions: ${(daemon.sessions || []).length}`);
    } catch { /* ignore */ }
  }

  index.close();
}
