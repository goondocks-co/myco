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
import { writeSecret } from '../config/secrets.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Directories that must exist inside a vault for correct operation. */
const VAULT_REQUIRED_DIRS = ['buffer', 'attachments', 'logs'] as const;

export async function run(args: string[]): Promise<void> {
  const vaultPath = parseStringFlag(args, '--vault');
  const nonInteractive = args.includes('--non-interactive');
  const isInteractive = !nonInteractive && !!process.stdin.isTTY;

  // Show banner in interactive mode
  if (isInteractive) {
    const { printBanner } = await import('./init-wizard.js');
    printBanner();
  }

  // Resolve vault directory
  const vaultDir = vaultPath
    ? (vaultPath.startsWith('~/') ? path.join(os.homedir(), vaultPath.slice(2)) : path.resolve(vaultPath))
    : path.join(resolveVaultDir());

  const alreadyInitialized = fs.existsSync(path.join(vaultDir, 'myco.yaml'));

  // --- Wizard: runs for both new and existing vaults ---

  const embeddingProvider = parseStringFlag(args, '--embedding-provider');
  const embeddingModel = parseStringFlag(args, '--embedding-model');
  const embeddingUrl = parseStringFlag(args, '--embedding-url');
  const hasEmbeddingFlags = !!(embeddingProvider || embeddingModel || embeddingUrl);

  let wizardOverrides: Record<string, unknown> = {};
  let agentOverrides: Record<string, unknown> | null = null;
  let wizardAnswers: Awaited<ReturnType<typeof import('./init-wizard.js').runWizard>> | null = null;

  // Determine if the wizard should run
  let shouldRunWizard = false;
  if (isInteractive && !hasEmbeddingFlags) {
    if (alreadyInitialized) {
      const { loadConfig } = await import('../config/loader.js');
      const config = loadConfig(vaultDir);
      const agentProvider = config.agent.provider;
      const embConfig = config.embedding;

      console.log(`  Vault: ${vaultDir}`);
      console.log(`  Intelligence: ${agentProvider?.type ?? 'not configured'}${agentProvider?.model ? ` / ${agentProvider.model}` : ''}`);
      console.log(`  Embeddings: ${embConfig.provider} / ${embConfig.model}`);
      console.log('');

      const { confirm } = await import('@inquirer/prompts');
      shouldRunWizard = await confirm({ message: 'Reconfigure providers?', default: false });
    } else {
      shouldRunWizard = true;
    }
  }

  if (shouldRunWizard) {
    const { runWizard, buildEmbeddingConfig, buildAgentConfig } = await import('./init-wizard.js');
    const answers = await runWizard();
    wizardAnswers = answers;
    if (answers.embeddingProvider !== 'skip') {
      wizardOverrides = { ...buildEmbeddingConfig(answers) };
    }
    agentOverrides = buildAgentConfig(answers);
  }

  // --- Vault creation (new vaults only) ---

  if (!alreadyInitialized) {
    console.log(`Initializing Myco vault at ${vaultDir}`);

    for (const dir of VAULT_REQUIRED_DIRS) {
      fs.mkdirSync(path.join(vaultDir, dir), { recursive: true });
    }

    // Build embedding config from flags (flags take precedence over wizard)
    const embeddingOverrides: Record<string, unknown> = { ...wizardOverrides };
    if (embeddingProvider) embeddingOverrides.provider = embeddingProvider;
    if (embeddingModel) embeddingOverrides.model = embeddingModel;
    if (embeddingUrl) embeddingOverrides.base_url = embeddingUrl;

    const config = MycoConfigSchema.parse({
      version: 3,
      ...(Object.keys(embeddingOverrides).length > 0 ? { embedding: embeddingOverrides } : {}),
      ...(agentOverrides ? { agent: agentOverrides } : {}),
    });

    saveConfig(vaultDir, config);
    fs.writeFileSync(path.join(vaultDir, '.gitignore'), VAULT_GITIGNORE, 'utf-8');

    const db = initDatabase(vaultDbPath(vaultDir));
    createSchema(db);
    closeDatabase();
  }

  // --- Update existing vault config if wizard ran ---

  if (alreadyInitialized && (Object.keys(wizardOverrides).length > 0 || agentOverrides)) {
    updateConfig(vaultDir, (config) => {
      let updated = config;
      if (Object.keys(wizardOverrides).length > 0) {
        // Full replacement — avoids stale fields (e.g., old base_url) leaking when switching providers
        updated = { ...updated, embedding: wizardOverrides as typeof updated.embedding };
      }
      if (agentOverrides) {
        updated = {
          ...updated,
          agent: { ...updated.agent, ...agentOverrides },
        };
      }
      return updated;
    });
    console.log('  Updated myco.yaml');
  }

  // --- Store embedding API key in secrets.env ---

  if (wizardAnswers?.embeddingApiKey) {
    const { OPENROUTER_API_KEY_ENV } = await import('./providers/openrouter.js');
    const { OPENAI_API_KEY_ENV } = await import('./providers/openai-embeddings.js');
    const envVarName = wizardAnswers.embeddingProvider === 'openrouter'
      ? OPENROUTER_API_KEY_ENV
      : OPENAI_API_KEY_ENV;
    writeSecret(vaultDir, envVarName, wizardAnswers.embeddingApiKey);
  }

  // --- Symbiont selection and registration ---

  const projectRoot = path.dirname(vaultDir);
  const allManifests = loadManifests();
  const detected = detectSymbionts(projectRoot);
  const detectedNames = new Set(detected.map((d) => d.manifest.name));

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
        return {
          value: m.name,
          name: hint ? `${m.displayName} (${hint})` : m.displayName,
          checked: detectedNames.has(m.name),
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
      daemonUrl = `http://localhost:${daemonJson.port}/`;
    } catch { /* daemon.json not readable — skip URL */ }
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
  } else if (!daemonHealthy) {
    console.log('Dashboard: daemon failed to start — run `myco doctor` to diagnose');
  }
  console.log('');
  console.log('Start a coding session — Myco will begin capturing automatically.');
}

