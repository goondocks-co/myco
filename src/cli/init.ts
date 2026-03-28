import { initDatabase, vaultDbPath, closeDatabase } from '../db/client.js';
import { createSchema } from '../db/schema.js';
import { resolveVaultDir } from '../vault/resolve.js';
import {
  parseStringFlag,
  VAULT_GITIGNORE,
  collapseHomePath,
} from './shared.js';
import { detectSymbionts, resolvePackageRoot } from '../symbionts/detect.js';
import { SymbiontInstaller } from '../symbionts/installer.js';
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

  // --- Symbiont detection and registration ---

  const projectRoot = path.dirname(vaultDir);
  const detected = detectSymbionts(projectRoot);

  if (detected.length > 0) {
    console.log('Detected agents:');
    for (const d of detected) {
      const signals = [
        d.binaryFound ? 'binary found' : null,
        d.configDirFound ? `${d.manifest.configDir}/ exists` : null,
      ].filter(Boolean).join(', ');
      console.log(`  \u2713 ${d.manifest.displayName} (${signals})`);
    }

    // Interactive: let user choose which agents to register
    let selected = detected;
    if (isInteractive && detected.length > 0) {
      const { checkbox } = await import('@inquirer/prompts');
      const choices = detected.map((d) => ({
        value: d.manifest.name,
        name: d.manifest.displayName,
        checked: true,
      }));
      const selectedNames = await checkbox({
        message: 'Register plugins for',
        choices,
      });
      selected = detected.filter((d) => selectedNames.includes(d.manifest.name));
      if (selected.length === 0) {
        console.log('  Skipped plugin registration.');
      }
    }

    const portableVaultDir = collapseHomePath(vaultDir);
    const pkgRoot = resolvePackageRoot();

    for (const d of selected) {
      try {
        const installer = new SymbiontInstaller(d.manifest, projectRoot, pkgRoot);
        const result = installer.install(portableVaultDir);

        const installed = [
          result.hooks && 'hooks',
          result.mcp && 'MCP server',
          result.skills && 'skills',
          result.env && 'env',
        ].filter(Boolean);

        if (installed.length > 0) {
          console.log(`  \u2713 ${d.manifest.displayName}: ${installed.join(', ')}`);
        } else {
          console.log(`  \u2013 ${d.manifest.displayName}: no registration targets configured`);
        }
      } catch (err) {
        console.error(`  \u2717 Failed to register ${d.manifest.displayName}: ${(err as Error).message}`);
      }
    }
  }

  // --- Summary ---

  if (!alreadyInitialized) {
    console.log('');
    console.log('=== Myco Vault Initialized ===');
    console.log(`Path:               ${vaultDir}`);
    console.log('');
    console.log('Next: start a coding session — Myco will begin capturing automatically.');
  } else {
    console.log('');
    console.log('Run `myco doctor` to verify setup health.');
  }
}

