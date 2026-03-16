#!/usr/bin/env node
import { EMBEDDING_INPUT_LIMIT } from './constants.js';
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
import os from 'node:os';
import { queryLogs, matchesFilter, DEFAULT_LOG_TAIL, LEVEL_ORDER } from './logs/reader.js';
import type { LogEntry, LogLevel } from './logs/reader.js';
import { formatLogLine, parseIntFlag, parseStringFlag } from './logs/format.js';

// Load .env from cwd (not script location — that's the plugin install dir)
function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}
loadEnv();

import YAML from 'yaml';

const USAGE = `Usage: myco <command> [args]

Commands:
  init [options]         Initialize a new vault
  stats                  Vault health, index counts, vector count
  search <query>         Combined FTS + vector search with scores
  vectors <query>        Raw vector search with similarity scores
  session [id|latest]    Show a session note
  logs [options]         View daemon logs (--tail N, --follow, --level, --component)
  restart                Restart the daemon with current code
  rebuild                Reindex the entire vault

Init options:
  --vault <path>              Vault directory (default: .myco/ in project root)
  --llm-provider <name>       LLM provider: ollama, lm-studio, anthropic
  --llm-model <name>          LLM model name (e.g., gpt-oss)
  --llm-url <url>             LLM base URL (default per provider)
  --embedding-provider <name> Embedding provider: ollama, lm-studio
  --embedding-model <name>    Embedding model name (e.g., bge-m3)
  --embedding-url <url>       Embedding base URL (default per provider)
  --user <name>               Team username
  --team                      Enable team mode
`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  // Init doesn't require an existing vault
  if (cmd === 'init') return initVault(args);

  const vaultDir = resolveVaultDir();
  if (!fs.existsSync(path.join(vaultDir, 'myco.yaml'))) {
    console.error(`No myco.yaml found in ${vaultDir}. Run 'myco init' first.`);
    process.exit(1);
  }

  switch (cmd) {
    case 'stats': return stats(vaultDir);
    case 'search': return search(vaultDir, args.join(' '));
    case 'vectors': return vectors(vaultDir, args.join(' '));
    case 'session': return session(vaultDir, args[0]);
    case 'restart': return restart(vaultDir);
    case 'rebuild': return rebuild(vaultDir);
    case 'logs': return logs(vaultDir, args);
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

  // Kill existing daemon if running
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
    try { fs.unlinkSync(daemonPath); } catch { /* already gone */ }
  }

  // Spawn and wait for health using the shared client
  // (handles CLAUDE_PLUGIN_ROOT + CURSOR_PLUGIN_ROOT resolution)
  const { DaemonClient } = await import('./hooks/client.js');
  const client = new DaemonClient(vaultDir);

  console.log('Waiting for health check...');
  const healthy = await client.ensureRunning();
  if (healthy) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonPath, 'utf-8'));
      console.log(`Daemon healthy on port ${info.port}`);
    } catch {
      console.log('Daemon healthy');
    }
  } else {
    console.error('Daemon failed to become healthy');
  }
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
      const text = `${note.title}\n${note.content}`.slice(0, EMBEDDING_INPUT_LIMIT);
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

/** Polling interval for follow mode (milliseconds). */
const FOLLOW_POLL_INTERVAL_MS = 500;

function logs(vaultDir: string, args: string[]): void {
  const logDir = path.join(vaultDir, 'logs');
  const follow = args.includes('--follow') || args.includes('-f');
  const limit = parseIntFlag(args, '--tail', '-n') ?? DEFAULT_LOG_TAIL;
  const rawLevel = parseStringFlag(args, '--level', '-l');
  if (rawLevel && !(rawLevel in LEVEL_ORDER)) {
    console.error(`Invalid level: ${rawLevel}. Valid levels: ${Object.keys(LEVEL_ORDER).join(', ')}`);
    process.exit(1);
  }
  const level = rawLevel as LogLevel | undefined;
  const component = parseStringFlag(args, '--component', '-c');
  const since = parseStringFlag(args, '--since');
  const until = parseStringFlag(args, '--until');

  // Show initial tail
  const result = queryLogs(logDir, { limit, level, component, since, until });
  for (const e of result.entries) {
    process.stdout.write(formatLogLine(e) + '\n');
  }
  if (result.truncated) {
    process.stdout.write(`  ... ${result.total - result.entries.length} earlier entries omitted\n`);
  }

  if (!follow) return;

  // Follow mode: watch for new appends via stat-based polling.
  // --since is intentionally not applied to streamed lines (only the initial tail).
  const followFilter = { level, component, until };
  const logPath = path.join(logDir, 'daemon.log');
  let offset = 0;
  try {
    offset = fs.statSync(logPath).size;
  } catch {
    // File doesn't exist yet — start from 0
  }

  fs.watchFile(logPath, { interval: FOLLOW_POLL_INTERVAL_MS }, (curr, prev) => {
    if (curr.size < prev.size || curr.ino !== prev.ino) {
      // Rotation detected — reset to beginning of new file
      offset = 0;
    }
    if (curr.size <= offset) return;

    try {
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(curr.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);

      const text = buf.toString('utf-8');
      // Only advance offset past complete lines to avoid losing partial writes
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) return; // no complete lines yet
      offset += Buffer.byteLength(text.slice(0, lastNewline + 1));

      for (const line of text.slice(0, lastNewline).split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as LogEntry;
          if (!matchesFilter(e, followFilter)) continue;
          process.stdout.write(formatLogLine(e) + '\n');
        } catch {
          // Malformed line
        }
      }
    } catch {
      // File read error — skip this cycle
    }
  });

  // fs.watchFile with persistent: true (default) keeps the event loop alive.
  // SIGINT (Ctrl+C) cleans up the watcher.
  process.on('SIGINT', () => {
    fs.unwatchFile(logPath);
    process.exit(0);
  });
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// --- Provider defaults ---
const PROVIDER_DEFAULTS: Record<string, { base_url: string }> = {
  ollama: { base_url: 'http://localhost:11434' },
  'lm-studio': { base_url: 'http://localhost:1234' },
};

const DASHBOARD_CONTENT = `# Myco Vault

## Active Plans
\`\`\`dataview
TABLE status, tags FROM #type/plan
WHERE status = "active" OR status = "in_progress"
SORT created DESC
\`\`\`

## Recent Sessions
\`\`\`dataview
TABLE user, started, tools_used FROM #type/session
SORT started DESC LIMIT 10
\`\`\`

## Recent Memories
\`\`\`dataview
TABLE observation_type AS "Type", created FROM #type/memory
SORT created DESC LIMIT 15
\`\`\`

## Memories by Type
\`\`\`dataview
TABLE WITHOUT ID observation_type AS "Type", length(rows) AS "Count"
FROM #type/memory GROUP BY observation_type
SORT length(rows) DESC
\`\`\`

## Gotchas
\`\`\`dataview
LIST FROM #memory/gotcha SORT created DESC LIMIT 10
\`\`\`
`;

const VAULT_GITIGNORE = `# Runtime — rebuilt on daemon startup
index.db
index.db-wal
index.db-shm
vectors.db

# Daemon state — per-machine, ephemeral
daemon.json
buffer/
logs/

# Obsidian — per-user workspace config
.obsidian/
`;

async function initVault(args: string[]): Promise<void> {
  const vaultPath = parseStringFlag(args, '--vault');
  const llmProvider = parseStringFlag(args, '--llm-provider') ?? 'ollama';
  const llmModel = parseStringFlag(args, '--llm-model') ?? 'gpt-oss';
  const llmUrl = parseStringFlag(args, '--llm-url') ?? PROVIDER_DEFAULTS[llmProvider]?.base_url;
  const embeddingProvider = parseStringFlag(args, '--embedding-provider') ?? 'ollama';
  const embeddingModel = parseStringFlag(args, '--embedding-model') ?? 'bge-m3';
  const embeddingUrl = parseStringFlag(args, '--embedding-url') ?? PROVIDER_DEFAULTS[embeddingProvider]?.base_url;
  const user = parseStringFlag(args, '--user') ?? '';
  const teamEnabled = args.includes('--team');

  // Resolve vault directory
  const vaultDir = vaultPath
    ? (vaultPath.startsWith('~/') ? path.join(os.homedir(), vaultPath.slice(2)) : path.resolve(vaultPath))
    : path.join(resolveVaultDir());

  // Check if already initialized
  if (fs.existsSync(path.join(vaultDir, 'myco.yaml'))) {
    console.log(`Vault already initialized at ${vaultDir}`);
    return;
  }

  console.log(`Initializing Myco vault at ${vaultDir}`);

  // Create directory structure
  const dirs = ['sessions', 'plans', 'memories', 'artifacts', 'team', 'buffer', 'logs'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(vaultDir, dir), { recursive: true });
  }

  // Write myco.yaml — all values explicit, no hidden defaults
  const config: Record<string, unknown> = {
    version: 2,
    intelligence: {
      llm: {
        provider: llmProvider,
        model: llmModel,
        ...(llmUrl ? { base_url: llmUrl } : {}),
        context_window: 8192,
        max_tokens: 1024,
      },
      embedding: {
        provider: embeddingProvider,
        model: embeddingModel,
        ...(embeddingUrl ? { base_url: embeddingUrl } : {}),
      },
    },
    daemon: {
      log_level: 'info',
      grace_period: 30,
      max_log_size: 5242880,
    },
    capture: {
      transcript_paths: [],
      artifact_watch: ['.claude/plans/', '.cursor/plans/'],
      artifact_extensions: ['.md'],
      buffer_max_events: 500,
    },
    context: {
      max_tokens: 1200,
      layers: { plans: 200, sessions: 500, memories: 300, team: 200 },
    },
    team: {
      enabled: teamEnabled,
      user,
      sync: 'git',
    },
  };

  fs.writeFileSync(
    path.join(vaultDir, 'myco.yaml'),
    YAML.stringify(config),
    'utf-8',
  );

  // Write .gitignore
  fs.writeFileSync(path.join(vaultDir, '.gitignore'), VAULT_GITIGNORE, 'utf-8');

  // Write Obsidian dashboard
  fs.writeFileSync(path.join(vaultDir, '_dashboard.md'), DASHBOARD_CONTENT, 'utf-8');

  // Initialize FTS index
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));
  initFts(index);
  index.close();

  // Summary
  console.log('');
  console.log('=== Myco Vault Initialized ===');
  console.log(`Path:               ${vaultDir}`);
  console.log(`LLM provider:       ${llmProvider} / ${llmModel}`);
  console.log(`Embedding provider: ${embeddingProvider} / ${embeddingModel}`);
  console.log(`Team mode:          ${teamEnabled ? 'enabled' : 'disabled'}`);
  if (user) console.log(`User:               ${user}`);
  console.log('');

  // Check if vault is outside the project (needs env var)
  const projectRoot = path.resolve('.');
  const isProjectLocal = vaultDir.startsWith(projectRoot);
  if (!isProjectLocal) {
    console.log('Vault is outside the project directory.');
    console.log('Set MYCO_VAULT_DIR so hooks and the MCP server can find it:');
    console.log('');
    console.log(`  export MYCO_VAULT_DIR="${vaultDir}"`);
    console.log('');
    console.log('For Claude Code, add to .claude/settings.json:');
    console.log(`  { "env": { "MYCO_VAULT_DIR": "${vaultDir}" } }`);
    console.log('');
  }

  console.log('Next: start a coding session — Myco will begin capturing automatically.');
}

main().catch((err) => {
  console.error(`myco: ${(err as Error).message}`);
  process.exit(1);
});
