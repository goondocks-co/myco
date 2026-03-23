import { initDatabaseForVault, closeDatabase } from '../db/client.js';
import { resolveVaultDir } from '../vault/resolve.js';
import {
  parseStringFlag,
  VAULT_GITIGNORE,
} from './shared.js';
import { MycoConfigSchema } from '../config/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

export async function run(args: string[]): Promise<void> {
  const vaultPath = parseStringFlag(args, '--vault');

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

  // Build embedding config from flags
  const embeddingProvider = parseStringFlag(args, '--embedding-provider');
  const embeddingModel = parseStringFlag(args, '--embedding-model');
  const embeddingUrl = parseStringFlag(args, '--embedding-url');

  const embeddingOverrides: Record<string, unknown> = {};
  if (embeddingProvider) embeddingOverrides.provider = embeddingProvider;
  if (embeddingModel) embeddingOverrides.model = embeddingModel;
  if (embeddingUrl) embeddingOverrides.base_url = embeddingUrl;

  // Write myco.yaml — only version is truly required, everything else has Zod defaults
  const config = MycoConfigSchema.parse({
    version: 3,
    ...(Object.keys(embeddingOverrides).length > 0 ? { embedding: embeddingOverrides } : {}),
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

  // Summary
  console.log('');
  console.log('=== Myco Vault Initialized ===');
  console.log(`Path:               ${vaultDir}`);
  console.log('');

  console.log('Next: start a coding session — Myco will begin capturing automatically.');
}
