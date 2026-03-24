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

/** Directories that must exist inside a vault for correct operation. */
const VAULT_REQUIRED_DIRS = ['pgdata', 'buffer', 'attachments', 'logs'] as const;

export async function run(args: string[]): Promise<void> {
  const vaultPath = parseStringFlag(args, '--vault');

  // Resolve vault directory
  const vaultDir = vaultPath
    ? (vaultPath.startsWith('~/') ? path.join(os.homedir(), vaultPath.slice(2)) : path.resolve(vaultPath))
    : path.join(resolveVaultDir());

  const alreadyInitialized = fs.existsSync(path.join(vaultDir, 'myco.yaml'));

  if (!alreadyInitialized) {
    console.log(`Initializing Myco vault at ${vaultDir}`);

    // Create directory structure
    for (const dir of VAULT_REQUIRED_DIRS) {
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
  }

  // Detect and register symbionts — runs even on re-init so newly
  // installed symbionts get registered without recreating the vault
  const projectRoot = path.dirname(resolveVaultDir());
  const detected = detectSymbionts(projectRoot);

  if (detected.length > 0) {
    console.log(alreadyInitialized ? `Vault at ${vaultDir}` : '');
    console.log('Detected symbionts:');
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

        const configured = configureSymbiontVaultEnv(d, projectRoot, portableVaultDir);
        if (configured) {
          console.log(`  Set MYCO_VAULT_DIR for ${d.manifest.displayName}`);
        }
      } catch (err) {
        console.error(`  Failed to register with ${d.manifest.displayName}: ${(err as Error).message}`);
      }
    }
  } else if (alreadyInitialized) {
    console.log(`Vault already initialized at ${vaultDir}`);
  }

  if (!alreadyInitialized) {
    console.log('');
    console.log('=== Myco Vault Initialized ===');
    console.log(`Path:               ${vaultDir}`);
    console.log('');
    console.log('Next: start a coding session — Myco will begin capturing automatically.');
  }
}

import type { DetectedSymbiont } from '../symbionts/detect.js';

/** Write MYCO_VAULT_DIR into a symbiont's settings or MCP config file. */
function configureSymbiontVaultEnv(
  d: DetectedSymbiont,
  projectRoot: string,
  portableVaultDir: string,
): boolean {
  try {
    if (d.manifest.settingsPath) {
      const settingsFile = path.join(projectRoot, d.manifest.settingsPath);
      let settings: Record<string, unknown> = {};
      try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>; } catch { /* fresh */ }
      const env = (settings.env ?? {}) as Record<string, string>;
      env.MYCO_VAULT_DIR = portableVaultDir;
      settings.env = env;
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
      return true;
    }

    if (d.manifest.mcpConfigPath) {
      const mcpFile = path.join(projectRoot, d.manifest.mcpConfigPath);
      const config = JSON.parse(fs.readFileSync(mcpFile, 'utf-8')) as Record<string, unknown>;
      const servers = config.mcpServers as Record<string, { env?: Record<string, string> }> | undefined;
      if (servers?.myco) {
        servers.myco.env = { ...servers.myco.env, MYCO_VAULT_DIR: portableVaultDir };
        fs.writeFileSync(mcpFile, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        return true;
      }
    }
  } catch { /* settings dir doesn't exist or config malformed */ }
  return false;
}
