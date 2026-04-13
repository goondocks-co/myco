import { initDatabase, vaultDbPath, closeDatabase } from '../db/client.js';
import { createSchema } from '../db/schema.js';
import { resolveVaultDir } from '../vault/resolve.js';
import {
  parseStringFlag,
  VAULT_GITIGNORE,
  registerSymbionts,
} from './shared.js';
import { detectSymbionts, loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { MycoConfigSchema } from '../config/schema.js';
import { updateConfig, saveConfig } from '../config/loader.js';
import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from '../constants.js';
import { getPluginVersion } from '../version.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Directories that must exist inside a vault for correct operation. */
const VAULT_REQUIRED_DIRS = ['buffer', 'attachments', 'logs'] as const;

function printBanner(): void {
  const version = getPluginVersion();
  console.log('');
  console.log('  🍄 Myco');
  console.log(`  v${version} — Collective Agent Intelligence`);
  console.log('  ─────────────────────────────────────────────');
  console.log('');
}

export async function run(args: string[]): Promise<void> {
  const vaultPath = parseStringFlag(args, '--vault');
  const nonInteractive = args.includes('--non-interactive');
  const isInteractive = !nonInteractive && !!process.stdin.isTTY;

  // Show banner in interactive mode
  if (isInteractive) {
    printBanner();
  }

  // Resolve vault directory
  const vaultDir = vaultPath
    ? (vaultPath.startsWith('~/') ? path.join(os.homedir(), vaultPath.slice(2)) : path.resolve(vaultPath))
    : path.join(resolveVaultDir());

  const alreadyInitialized = fs.existsSync(path.join(vaultDir, 'myco.yaml'));

  // CLI flags for non-interactive/scripted installs
  const embeddingProvider = parseStringFlag(args, '--embedding-provider');
  const embeddingModel = parseStringFlag(args, '--embedding-model');
  const embeddingUrl = parseStringFlag(args, '--embedding-url');
  const hasEmbeddingFlags = !!(embeddingProvider || embeddingModel || embeddingUrl);

  // Flag-based embedding config for new vaults via non-interactive / scripted installs.
  // Existing vaults are configured through the dashboard, not CLI flags.
  // The agent provider is not flag-configurable -- it must be set via the dashboard.
  let embeddingFromFlags: Record<string, unknown> = {};
  if (hasEmbeddingFlags && !alreadyInitialized) {
    embeddingFromFlags = {
      provider: embeddingProvider ?? 'ollama',
      model: embeddingModel ?? DEFAULT_OLLAMA_EMBEDDING_MODEL,
      ...(embeddingUrl ? { base_url: embeddingUrl } : {}),
    };
  }

  // Show existing config summary on re-init
  if (alreadyInitialized && isInteractive) {
    const { loadConfig } = await import('../config/loader.js');
    const config = loadConfig(vaultDir);
    const agentProvider = config.agent.provider;
    const embConfig = config.embedding;

    console.log(`  Vault: ${vaultDir}`);
    console.log(`  Intelligence: ${agentProvider?.type ?? 'not configured'}${agentProvider?.model ? ` / ${agentProvider.model}` : ''}`);
    console.log(`  Embeddings: ${embConfig.provider} / ${embConfig.model}`);
    console.log('');
  }

  // --- Vault creation (new vaults only) ---

  if (!alreadyInitialized) {
    console.log(`Initializing Myco vault at ${vaultDir}`);

    for (const dir of VAULT_REQUIRED_DIRS) {
      fs.mkdirSync(path.join(vaultDir, dir), { recursive: true });
    }

    // Agent disabled by default -- user enables via dashboard after configuring a provider
    const config = MycoConfigSchema.parse({
      version: 3,
      ...(Object.keys(embeddingFromFlags).length > 0 ? { embedding: embeddingFromFlags } : {}),
      agent: {
        scheduled_tasks_enabled: false,
        event_tasks_enabled: false,
      },
    });

    saveConfig(vaultDir, config);
    fs.writeFileSync(path.join(vaultDir, '.gitignore'), VAULT_GITIGNORE, 'utf-8');

    const db = initDatabase(vaultDbPath(vaultDir));
    createSchema(db);
    closeDatabase();
  }

  // --- Symbiont selection and registration ---

  const projectRoot = path.dirname(vaultDir);
  const allManifests = loadManifests();
  const detected = detectSymbionts(projectRoot);
  const detectedNames = new Set(detected.map((d) => d.manifest.name));

  // Load existing symbiont config for pre-checking on re-init (interactive only)
  let existingSymbionts: Record<string, { enabled: boolean }> | undefined;
  if (alreadyInitialized && isInteractive) {
    try {
      const { loadConfig } = await import('../config/loader.js');
      const existing = loadConfig(vaultDir);
      existingSymbionts = existing.symbionts;
    } catch { /* config not loadable — skip pre-check */ }
  }

  if (allManifests.length > 0) {
    // Interactive: let user choose which agents to configure
    let selectedManifests = allManifests.filter((m) => detectedNames.has(m.name));

    if (isInteractive) {
      const { checkbox } = await import('@inquirer/prompts');
      const choices = allManifests.map((m) => {
        const det = detected.find((d) => d.manifest.name === m.name);
        const hint = det
          ? [det.binaryFound && 'detected', det.configDirFound && `${m.configDir}/ exists`].filter(Boolean).join(', ')
          : '';
        // Pre-check from config on re-init; nothing pre-checked on first init
        const checked = !!existingSymbionts?.[m.name]?.enabled;
        return {
          value: m.name,
          name: hint ? `${m.displayName} (${hint})` : m.displayName,
          checked,
        };
      });
      const selectedNames = await checkbox({
        message: 'Configure agents',
        choices,
      });
      selectedManifests = allManifests.filter((m) => selectedNames.includes(m.name));
      if (selectedManifests.length === 0) {
        console.log('  Skipped agent configuration.');
      }
    }

    if (selectedManifests.length > 0) {
      const symbiontsConfig: Record<string, { enabled: boolean }> = {};
      for (const m of selectedManifests) {
        symbiontsConfig[m.name] = { enabled: true };
      }
      updateConfig(vaultDir, (config) => ({
        ...config,
        symbionts: symbiontsConfig,
      }));

      const pkgRoot = resolvePackageRoot();
      registerSymbionts(selectedManifests, projectRoot, pkgRoot, 'Registered');
    }
  }

  // --- Start daemon and show summary ---

  const { DaemonClient } = await import('../hooks/client.js');
  const client = new DaemonClient(vaultDir);
  const daemonHealthy = await client.ensureRunning();

  let daemonUrl = '';
  if (daemonHealthy) {
    try {
      const daemonJson = JSON.parse(fs.readFileSync(path.join(vaultDir, 'daemon.json'), 'utf-8'));
      daemonUrl = `http://localhost:${daemonJson.port}/settings`;
    } catch { /* daemon.json not readable -- skip URL */ }
  }

  console.log('');
  if (!alreadyInitialized) {
    console.log('=== Myco Vault Initialized ===');
  } else {
    console.log('=== Myco Updated ===');
  }
  console.log(`Project:  ${path.basename(projectRoot)}`);
  console.log(`Vault:    ${vaultDir}`);
  if (daemonUrl) {
    console.log(`Dashboard: ${daemonUrl}`);

    if (isInteractive) {
      console.log('');
      console.log('  Data collection is active. Configure the Myco agent and');
      console.log('  embedding providers in the dashboard to unlock the full');
      console.log('  intelligence pipeline.');

      // Auto-open browser to settings -- fire-and-forget
      const { openBrowser } = await import('./open-browser.js');
      openBrowser(daemonUrl);
    }
  } else if (!daemonHealthy) {
    console.log('Dashboard: daemon failed to start -- run `myco doctor` to diagnose');
  }
  console.log('');
  console.log('Start a coding session -- Myco will begin capturing automatically.');
}

