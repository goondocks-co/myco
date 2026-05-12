import { initDatabase, vaultDbPath, closeDatabase } from '../db/client.js';
import { createSchema } from '../db/schema.js';
import { resolveVaultDir, resolveProjectRoot, assertSafeProjectRoot, UnsafeProjectRootError } from '../vault/resolve.js';
import { ensureProjectManifest, loadProjectManifest, type ProjectManifest } from '../config/project-manifest.js';
import { resolveProjectVaultDir } from '../grove/paths.js';
import { ensureGroveDatabase } from '../grove/database.js';
import { findRegisteredProjectByBinding, registerProjectInGrove, resolveGrove, type GroveRecord } from '../grove/registry.js';
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

/** Directories that must exist inside a vault for correct operation. */
const VAULT_REQUIRED_DIRS = ['buffer', 'attachments', 'logs', 'migration', 'tasks'] as const;

function printBanner(): void {
  const version = getPluginVersion();
  console.log('');
  console.log('  🍄 Myco');
  console.log(`  v${version} — Collective Agent Intelligence`);
  console.log('  ─────────────────────────────────────────────');
  console.log('');
}

export async function run(args: string[]): Promise<void> {
  const nonInteractive = args.includes('--non-interactive');
  const isInteractive = !nonInteractive && !!process.stdin.isTTY;

  // Show banner in interactive mode
  if (isInteractive) {
    printBanner();
  }

  // Vaults are always project-local at `<projectRoot>/.myco/`. There is no
  // escape hatch — resolveVaultDir walks up from cwd (worktree-aware) to
  // find the right project root.
  const projectArg = parseStringFlag(args, '--project');
  const explicitProjectRoot = projectArg ? path.resolve(projectArg) : undefined;
  const vaultDir = explicitProjectRoot ? resolveProjectVaultDir(explicitProjectRoot) : resolveVaultDir();
  const projectRoot = explicitProjectRoot ?? resolveProjectRoot(vaultDir);

  // Refuse to register obviously-too-broad project roots ($HOME, /,
  // /Users/<user>, etc.) before we touch the registry. A bad root here
  // cascades into canopy-scan event-loop wedges and a poisoned project
  // entry that's hard to clean up after the fact.
  try {
    assertSafeProjectRoot(projectRoot);
  } catch (err) {
    if (err instanceof UnsafeProjectRootError) {
      console.error(`\nmyco init: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const alreadyInitialized = fs.existsSync(path.join(vaultDir, 'myco.yaml'));

  // CLI flags for non-interactive/scripted installs
  const embeddingProvider = parseStringFlag(args, '--embedding-provider');
  const embeddingModel = parseStringFlag(args, '--embedding-model');
  const embeddingUrl = parseStringFlag(args, '--embedding-url');
  const groveRef = parseStringFlag(args, '--grove');
  const hasEmbeddingFlags = !!(embeddingProvider || embeddingModel || embeddingUrl);
  const existingProjectManifest = loadProjectManifest(vaultDir);
  const grove = resolveGrove(groveRef ?? existingProjectManifest?.grove?.slug);
  assertManifestGroveBindingCompatible(existingProjectManifest, grove, {
    explicitGroveRef: groveRef,
    projectRoot,
  });

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
    const { loadMergedConfig } = await import('../config/loader.js');
    const config = loadMergedConfig(vaultDir);
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

    // Let schema defaults fill the agent section. Scheduled/event toggles
    // default to true, but the agent only runs once the user configures a
    // provider in Settings, so a no-op "enabled" state is safe.
    const config = MycoConfigSchema.parse({
      version: 3,
      ...(Object.keys(embeddingFromFlags).length > 0 ? { embedding: embeddingFromFlags } : {}),
    });

    saveConfig(vaultDir, config);
    fs.writeFileSync(path.join(vaultDir, '.gitignore'), VAULT_GITIGNORE, 'utf-8');

    const db = initDatabase(vaultDbPath(vaultDir));
    createSchema(db);
    closeDatabase();
  }

  // --- Symbiont selection and registration ---

  const projectManifest = ensureProjectManifest(vaultDir, {
    projectName: path.basename(projectRoot),
    groveId: grove.id,
    groveSlug: grove.slug,
    groveName: grove.name,
    groveBindingId: existingProjectManifest?.grove?.binding_id,
  });
  registerProjectInGrove(grove.id, {
    projectId: projectManifest.project.id,
    projectName: projectManifest.project.name ?? path.basename(projectRoot),
    projectRoot,
    bindingId: projectManifest.grove?.binding_id,
  });
  ensureGroveDatabase(grove.id);

  const allManifests = loadManifests();
  const detected = detectSymbionts(projectRoot);
  const detectedNames = new Set(detected.map((d) => d.manifest.name));

  // Load existing symbiont config for pre-checking on re-init (interactive only)
  let existingSymbionts: Record<string, { enabled: boolean }> | undefined;
  if (alreadyInitialized && isInteractive) {
    try {
      const { loadMergedConfig } = await import('../config/loader.js');
      const existing = loadMergedConfig(vaultDir);
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
    const daemonInfo = client.getInfo();
    if (daemonInfo) daemonUrl = `http://localhost:${daemonInfo.port}/settings`;

    // --- Auto-install OS service for boot-time start ---
    try {
      const { getServiceManager } = await import('../service/manager.js');
      const { buildServiceSpec } = await import('../service/spec-builder.js');
      const { serviceLabel } = await import('../service/labels.js');
      const { detectInstallVariant, resolveServiceExecutable } = await import('./service.js');
      const mgr = getServiceManager();
      if (mgr.supported) {
        const variant = detectInstallVariant();
        const status = await mgr.status(serviceLabel(variant));
        if (!status.installed) {
          const spec = buildServiceSpec({ variant, executable: resolveServiceExecutable() });
          await mgr.install(spec);
          console.log(`Service installed: ${spec.label} (${mgr.platformName})`);
        }
      }
    } catch (err) {
      console.log(`Service install skipped: ${(err as Error).message}`);
    }
  }

  console.log('');
  if (!alreadyInitialized) {
    console.log('=== Myco Vault Initialized ===');
  } else {
    console.log('=== Myco Updated ===');
  }
  console.log(`Project:  ${path.basename(projectRoot)}`);
  console.log(`Grove:    ${grove.name} (${grove.slug})`);
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

function assertManifestGroveBindingCompatible(
  manifest: ProjectManifest | null,
  grove: GroveRecord,
  options: { explicitGroveRef?: string; projectRoot: string },
): void {
  const manifestGrove = manifest?.grove;
  const bindingId = manifestGrove?.binding_id;
  if (!manifest || !bindingId) return;

  const registered = findRegisteredProjectByBinding(bindingId);
  if (registered) {
    if (registered.grove.id !== grove.id) {
      throw new Error(
        `Existing project.toml Grove binding ${bindingId} belongs to Grove ${registered.grove.name} (${registered.grove.slug}); refusing to register it into Grove ${grove.name} (${grove.slug}).`,
      );
    }
    if (registered.project.project_id !== manifest.project.id) {
      throw new Error(
        `Existing project.toml Grove binding ${bindingId} is registered to project ${registered.project.project_id}, not ${manifest.project.id}.`,
      );
    }
    if (path.resolve(registered.project.root) !== path.resolve(options.projectRoot)) {
      throw new Error(
        `Existing project.toml Grove binding ${bindingId} is already registered at ${registered.project.root}; refusing to rebind it to ${options.projectRoot}.`,
      );
    }
    return;
  }

  if (options.explicitGroveRef && manifestGrove?.slug && manifestGrove.slug !== grove.slug) {
    throw new Error(
      `Existing project.toml Grove binding ${bindingId} targets Grove ${manifestGrove.slug}; refusing explicit --grove ${options.explicitGroveRef}.`,
    );
  }
}
