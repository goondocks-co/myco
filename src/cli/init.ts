import { initDatabaseForVault, closeDatabase } from '../db/client.js';
import { resolveVaultDir } from '../vault/resolve.js';
import {
  parseStringFlag,
  VAULT_GITIGNORE,
  collapseHomePath,
} from './shared.js';
import { detectSymbionts, resolvePackageRoot } from '../symbionts/detect.js';
import { MycoConfigSchema } from '../config/schema.js';
import { execFileSync } from 'node:child_process';
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
  const dirs = ['pgdata', 'buffer', 'attachments', 'logs'];
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

  // Detect and register symbionts
  const projectRoot = path.dirname(resolveVaultDir());
  const detected = detectSymbionts(projectRoot);

  if (detected.length > 0) {
    console.log('\nDetected symbionts:');
    for (const d of detected) {
      const signals = [
        d.binaryFound ? 'binary found' : null,
        d.configDirFound ? `${d.manifest.configDir}/ exists` : null,
      ].filter(Boolean).join(', ');
      console.log(`  \u2713 ${d.manifest.displayName} (${signals})`);
    }

    const packageRoot = resolvePackageRoot();
    const portableVaultDir = collapseHomePath(vaultDir);

    for (const d of detected) {
      try {
        if (d.manifest.pluginInstallCommand) {
          const cmd = d.manifest.pluginInstallCommand.replace('{packageRoot}', packageRoot);
          const [bin, ...cmdArgs] = cmd.split(' ');
          execFileSync(bin, cmdArgs, { stdio: 'inherit' });
          console.log(`  Registered plugin with ${d.manifest.displayName}`);
        }

        // Configure MYCO_VAULT_DIR in the symbiont's settings
        if (d.manifest.settingsPath) {
          const settingsFile = path.join(projectRoot, d.manifest.settingsPath);
          const settingsDir = path.dirname(settingsFile);
          if (fs.existsSync(settingsDir)) {
            let settings: Record<string, unknown> = {};
            try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')); } catch { /* fresh */ }
            const env = (settings.env ?? {}) as Record<string, string>;
            env.MYCO_VAULT_DIR = portableVaultDir;
            settings.env = env;
            fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
            console.log(`  Set MYCO_VAULT_DIR for ${d.manifest.displayName}`);
          }
        }

        if (d.manifest.mcpConfigPath) {
          const mcpFile = path.join(projectRoot, d.manifest.mcpConfigPath);
          if (fs.existsSync(mcpFile)) {
            try {
              const config = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
              if (config.mcpServers?.myco) {
                config.mcpServers.myco.env = { ...config.mcpServers.myco.env, MYCO_VAULT_DIR: portableVaultDir };
                fs.writeFileSync(mcpFile, JSON.stringify(config, null, 2) + '\n', 'utf-8');
                console.log(`  Set MYCO_VAULT_DIR for ${d.manifest.displayName}`);
              }
            } catch { /* malformed config */ }
          }
        }
      } catch (err) {
        console.error(`  Failed to register with ${d.manifest.displayName}: ${(err as Error).message}`);
      }
    }
  }

  // Summary
  console.log('');
  console.log('=== Myco Vault Initialized ===');
  console.log(`Path:               ${vaultDir}`);
  console.log('');

  console.log('Next: start a coding session — Myco will begin capturing automatically.');
}
