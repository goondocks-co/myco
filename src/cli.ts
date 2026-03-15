#!/usr/bin/env node
import { resolveVaultDir } from './vault/resolve.js';
import { MycoIndex } from './index/sqlite.js';
import { VectorIndex } from './index/vectors.js';
import { searchFts } from './index/fts.js';
import { loadConfig } from './config/loader.js';
import { createEmbeddingProvider } from './intelligence/llm.js';
import { generateEmbedding } from './intelligence/embeddings.js';
import { rebuildIndex } from './index/rebuild.js';
import { initFts } from './index/fts.js';
import fs from 'node:fs';
import path from 'node:path';

// Load .env from project root (walk up from script location)
function loadEnv(): void {
  const candidates = [
    path.resolve(import.meta.dirname, '..', '..', '.env'),  // dist/src/ → project root
    path.resolve(process.cwd(), '.env'),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
    break;
  }
}
loadEnv();

const USAGE = `Usage: myco <command> [args]

Commands:
  stats                  Vault health, index counts, vector count
  search <query>         Combined FTS + vector search with scores
  vectors <query>        Raw vector search with similarity scores
  session [id|latest]    Show a session note
  restart                Restart the daemon with current code
  rebuild                Reindex the entire vault
`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  const vaultDir = resolveVaultDir();
  if (!fs.existsSync(path.join(vaultDir, 'myco.yaml'))) {
    console.error(`No myco.yaml found in ${vaultDir}`);
    process.exit(1);
  }

  switch (cmd) {
    case 'stats': return stats(vaultDir);
    case 'search': return search(vaultDir, args.join(' '));
    case 'vectors': return vectors(vaultDir, args.join(' '));
    case 'session': return session(vaultDir, args[0]);
    case 'restart': return restart(vaultDir);
    case 'rebuild': return rebuild(vaultDir);
    default:
      console.error(`Unknown command: ${cmd}`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

function stats(vaultDir: string): void {
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

async function search(vaultDir: string, query: string): Promise<void> {
  if (!query) { console.error('Usage: myco search <query>'); process.exit(1); }

  const index = new MycoIndex(path.join(vaultDir, 'index.db'));

  // Semantic search is primary
  const vecDb = path.join(vaultDir, 'vectors.db');
  let semanticHits = 0;
  if (fs.existsSync(vecDb)) {
    try {
      const config = loadConfig(vaultDir);
      const embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);
      const emb = await generateEmbedding(embeddingProvider, query);
      const vec = new VectorIndex(vecDb, emb.dimensions);

      console.log(`=== Semantic Search: "${query}" ===`);
      const results = vec.search(emb.embedding, { limit: 10 });
      if (results.length === 0) {
        console.log('  (no results)');
      } else {
        semanticHits = results.length;
        const noteMap = new Map(
          index.queryByIds(results.map((r) => r.id)).map((n) => [n.id, n]),
        );
        for (const r of results) {
          const title = noteMap.get(r.id)?.title || r.id;
          console.log(`  sim: ${r.similarity.toFixed(3)} | [${r.metadata.type}] ${title.slice(0, 60)}`);
        }
      }
      vec.close();
    } catch (e) {
      console.log(`Semantic search unavailable: ${(e as Error).message}`);
    }
  }

  // FTS as fallback / supplementary
  console.log(`\n=== FTS Search: "${query}" ===`);
  const ftsResults = searchFts(index, query, { limit: 10 });
  if (ftsResults.length === 0) {
    console.log('  (no results)');
  } else {
    for (const r of ftsResults) {
      console.log(`  [${r.type}] ${r.title?.slice(0, 70)}`);
      if (r.snippet) console.log(`    ${r.snippet.slice(0, 100)}`);
    }
  }

  index.close();
}

async function vectors(vaultDir: string, query: string): Promise<void> {
  if (!query) { console.error('Usage: myco vectors <query>'); process.exit(1); }

  const config = loadConfig(vaultDir);
  const embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);
  const emb = await generateEmbedding(embeddingProvider, query);

  const vecDb = path.join(vaultDir, 'vectors.db');
  if (!fs.existsSync(vecDb)) { console.error('No vector index found'); process.exit(1); }

  const vec = new VectorIndex(vecDb, emb.dimensions);
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));

  // Show all results with no threshold filtering for tuning
  const results = vec.search(emb.embedding, { limit: 20, relativeThreshold: 0 });

  console.log(`Query: "${query}"`);
  console.log(`Dimensions: ${emb.dimensions}`);
  console.log(`Total vectors: ${vec.count()}`);
  console.log();

  if (results.length === 0) {
    console.log('(no results)');
  } else {
    const noteMap = new Map(
      index.queryByIds(results.map((r) => r.id)).map((n) => [n.id, n]),
    );
    const topScore = results[0].similarity;
    console.log(`Top score: ${topScore.toFixed(4)}`);
    console.log(`Default threshold (0.5x): ${(topScore * 0.5).toFixed(4)}`);
    console.log();
    console.log('  Sim     Ratio  Type       ID / Title');
    console.log('  ------  -----  ---------  ' + '-'.repeat(50));
    for (const r of results) {
      const title = noteMap.get(r.id)?.title || r.id;
      const ratio = (r.similarity / topScore).toFixed(2);
      const pass = r.similarity >= topScore * 0.5 ? '✓' : ' ';
      console.log(`${pass} ${r.similarity.toFixed(4)}  ${ratio}   ${r.metadata.type.padEnd(9)}  ${title.slice(0, 50)}`);
    }
  }

  vec.close();
  index.close();
}

function session(vaultDir: string, idOrLatest?: string): void {
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));
  const sessions = index.query({ type: 'session' });

  if (sessions.length === 0) {
    console.log('No sessions found');
    index.close();
    return;
  }

  let target;
  if (!idOrLatest || idOrLatest === 'latest') {
    target = sessions[sessions.length - 1];
  } else {
    target = sessions.find((s) => s.id.includes(idOrLatest));
  }

  if (!target) {
    console.error(`Session not found: ${idOrLatest}`);
    console.log('Available:', sessions.map((s) => s.id).join(', '));
    index.close();
    return;
  }

  // Read the raw markdown file
  const fullPath = path.join(vaultDir, target.path);
  if (fs.existsSync(fullPath)) {
    console.log(fs.readFileSync(fullPath, 'utf-8'));
  } else {
    console.log(`Title: ${target.title}`);
    console.log(`Content:\n${target.content?.slice(0, 2000)}`);
  }

  index.close();
}

async function restart(vaultDir: string): Promise<void> {
  const daemonPath = path.join(vaultDir, 'daemon.json');

  if (fs.existsSync(daemonPath)) {
    try {
      const daemon = JSON.parse(fs.readFileSync(daemonPath, 'utf-8'));
      if (isProcessAlive(daemon.pid)) {
        process.kill(daemon.pid, 'SIGTERM');
        console.log(`Stopped daemon (pid ${daemon.pid})`);
      } else {
        console.log(`Daemon pid ${daemon.pid} was already dead`);
      }
    } catch { /* ignore */ }
    fs.unlinkSync(daemonPath);
  }

  // Spawn new daemon
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(import.meta.dirname, '..', '..');
  const daemonScript = path.join(pluginRoot, 'dist', 'src', 'daemon', 'main.js');

  if (!fs.existsSync(daemonScript)) {
    console.error(`Daemon script not found: ${daemonScript}`);
    console.log('Run npm run build first');
    process.exit(1);
  }

  const { spawn } = await import('node:child_process');
  const child = spawn('node', [daemonScript, '--vault', vaultDir], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  console.log(`Spawned new daemon (pid ${child.pid})`);
  console.log('Waiting for health check...');

  const { DaemonClient } = await import('./hooks/client.js');
  const client = new DaemonClient(vaultDir);
  for (const delay of [200, 400, 800, 1500]) {
    await new Promise((r) => setTimeout(r, delay));
    if (await client.isHealthy()) {
      const info = JSON.parse(fs.readFileSync(daemonPath, 'utf-8'));
      console.log(`Daemon healthy on port ${info.port}`);
      return;
    }
  }
  console.error('Daemon failed to become healthy');
}

async function rebuild(vaultDir: string): Promise<void> {
  console.log(`Rebuilding index for ${vaultDir}...`);
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));
  initFts(index);
  const count = rebuildIndex(index, vaultDir);
  console.log(`Indexed ${count} notes (FTS)`);

  // Rebuild vector embeddings for all notes
  const vecDb = path.join(vaultDir, 'vectors.db');
  try {
    const config = loadConfig(vaultDir);
    const embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);
    const testEmbed = await embeddingProvider.embed('test');
    const vec = new VectorIndex(vecDb, testEmbed.dimensions);

    const allNotes = index.query({});
    let embedded = 0;
    for (const note of allNotes) {
      const text = `${note.title}\n${note.content}`.slice(0, 8000);
      try {
        const emb = await generateEmbedding(embeddingProvider, text);
        vec.upsert(note.id, emb.embedding, {
          type: note.type,
          session_id: (note.frontmatter as Record<string, unknown>)?.session as string ?? '',
        });
        embedded++;
        process.stdout.write(`\rEmbedded ${embedded}/${allNotes.length}`);
      } catch (e) {
        console.error(`\nFailed to embed ${note.id}: ${(e as Error).message}`);
      }
    }
    console.log(`\nEmbedded ${embedded} notes (vectors)`);
    vec.close();
  } catch (e) {
    console.log(`Vector rebuild skipped: ${(e as Error).message}`);
  }

  index.close();
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

main().catch((err) => {
  console.error(`myco: ${(err as Error).message}`);
  process.exit(1);
});
