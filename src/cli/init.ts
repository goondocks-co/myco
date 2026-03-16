import { MycoIndex } from '../index/sqlite.js';
import { initFts } from '../index/fts.js';
import { resolveVaultDir } from '../vault/resolve.js';
import {
  parseStringFlag,
  PROVIDER_DEFAULTS,
  DASHBOARD_CONTENT,
  VAULT_GITIGNORE,
  configureVaultEnv,
} from './shared.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

export async function run(args: string[]): Promise<void> {
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

  // If vault is outside the project, configure MYCO_VAULT_DIR for the current agent
  const projectRoot = path.resolve('.');
  const isProjectLocal = vaultDir.startsWith(projectRoot);
  if (!isProjectLocal) {
    configureVaultEnv(projectRoot, vaultDir);
  }

  console.log('Next: start a coding session — Myco will begin capturing automatically.');
}
