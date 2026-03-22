import { initDatabaseForVault, closeDatabase } from '../db/client.js';
import { resolveVaultDir } from '../vault/resolve.js';
import {
  parseStringFlag,
  VAULT_GITIGNORE,
  configureVaultEnv,
} from './shared.js';
import { MycoConfigSchema } from '../config/schema.js';
import { run as setupLlm } from './setup-llm.js';
import { run as setupDigest } from './setup-digest.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

export async function run(args: string[]): Promise<void> {
  const vaultPath = parseStringFlag(args, '--vault');
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
  const dirs = ['sessions', 'plans', 'spores', 'artifacts', 'team', 'buffer', 'logs'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(vaultDir, dir), { recursive: true });
  }

  // Write myco.yaml — only version is truly required, everything else has Zod defaults
  const config = MycoConfigSchema.parse({
    version: 2,
    team: { user, enabled: teamEnabled },
  });

  fs.writeFileSync(
    path.join(vaultDir, 'myco.yaml'),
    YAML.stringify(config),
    'utf-8',
  );

  // Write .gitignore
  fs.writeFileSync(path.join(vaultDir, '.gitignore'), VAULT_GITIGNORE, 'utf-8');

  // Initialize PGlite database
  await initDatabaseForVault(vaultDir);
  await closeDatabase();

  // Apply LLM provider settings from flags (if any were passed)
  const llmFlags: string[] = [];
  const llmProvider = parseStringFlag(args, '--llm-provider');
  const llmModel = parseStringFlag(args, '--llm-model');
  const llmUrl = parseStringFlag(args, '--llm-url');
  if (llmProvider) llmFlags.push('--llm-provider', llmProvider);
  if (llmModel) llmFlags.push('--llm-model', llmModel);
  if (llmUrl) llmFlags.push('--llm-url', llmUrl);
  const embeddingProvider = parseStringFlag(args, '--embedding-provider');
  const embeddingModel = parseStringFlag(args, '--embedding-model');
  const embeddingUrl = parseStringFlag(args, '--embedding-url');
  if (embeddingProvider) llmFlags.push('--embedding-provider', embeddingProvider);
  if (embeddingModel) llmFlags.push('--embedding-model', embeddingModel);
  if (embeddingUrl) llmFlags.push('--embedding-url', embeddingUrl);

  if (llmFlags.length > 0) {
    await setupLlm(llmFlags, vaultDir);
  }

  // Apply digest settings from flags (if any were passed)
  const digestFlags: string[] = [];
  const tiers = parseStringFlag(args, '--tiers');
  const injectTier = parseStringFlag(args, '--inject-tier');
  const contextWindow = parseStringFlag(args, '--context-window');
  if (tiers) digestFlags.push('--tiers', tiers);
  if (injectTier) digestFlags.push('--inject-tier', injectTier);
  if (contextWindow) digestFlags.push('--context-window', contextWindow);

  if (digestFlags.length > 0) {
    await setupDigest(digestFlags, vaultDir);
  }

  // Summary
  console.log('');
  console.log('=== Myco Vault Initialized ===');
  console.log(`Path:               ${vaultDir}`);
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
