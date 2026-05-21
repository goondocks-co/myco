import {
  resolveVaultDir, resolveProjectRoot, assertSafeProjectRoot, UnsafeProjectRootError,
} from '../vault/resolve.js';
import { runGlobalBootstrap } from './bootstrap.js';
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
import { updateConfig, saveConfig, updateGroveConfig } from '../config/loader.js';
import { withInferredReleaseProvenanceDefaults } from '../release-provenance/defaults.js';
import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from '../constants.js';
import { getPluginVersion } from '../version.js';
import fs from 'node:fs';
import path from 'node:path';

/** Directories that must exist inside a vault for correct operation. */
const VAULT_REQUIRED_DIRS = ['buffer', 'attachments', 'logs', 'migration', 'tasks'] as const;

const USAGE = `Usage: myco init [options]

With no flags, runs the global bootstrap: writes the per-user launchers
at ~/.myco/launcher.cjs and ~/.myco/mcp-launcher.cjs, then detects every
installed agent and wires Myco into each one's user-global config.
Idempotent; safe to re-run as a recovery or refresh.

Project-local install (the deliberate per-project opt-in) runs when
any project-install flag is present, or when --project is passed
explicitly.

Options:
  --project <path>                 Project root for a project-local install
  --grove <name|id>                Grove to bind this project to (implies --project)
  --non-interactive                Run without prompts (implies --project)
  --embedding-provider <provider>  Embedding provider for new vaults (implies --project)
  --embedding-model <model>        Embedding model for new vaults (implies --project)
  --embedding-url <url>            Embedding base URL for new vaults (implies --project)
  -h, --help                       Show this help
`;

function printBanner(): void {
  const version = getPluginVersion();
  console.log('');
  console.log('  🍄 Myco');
  console.log(`  v${version} — Collective Agent Intelligence`);
  console.log('  ─────────────────────────────────────────────');
  console.log('');
}

export async function run(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  if (args.includes('--worktree')) {
    console.error(
      '\nmyco init --worktree: retired. Under the global install Myco\'s\n' +
      'launchers live at ~/.myco/launcher.cjs and ~/.myco/mcp-launcher.cjs,\n' +
      'shared across every git worktree without per-worktree bootstrap. Run\n' +
      '`myco init` (no flag) to (re-)write them.\n',
    );
    process.exit(1);
  }

  // Mode selection: any project-install-specific flag routes to the
  // project-local install path. Bare `myco init` runs the global
  // bootstrap — the dominant invocation under the global model.
  const PROJECT_INSTALL_FLAGS = [
    '--project', '--grove', '--embedding-provider',
    '--embedding-model', '--embedding-url', '--non-interactive',
  ];
  const wantsProjectInstall = PROJECT_INSTALL_FLAGS.some((f) => args.includes(f));

  if (!wantsProjectInstall) {
    printBanner();
    const result = runGlobalBootstrap();
    if (result.launchers.written.length > 0) {
      console.log(`  ✓ Wrote ${result.launchers.written.length} global launcher(s)`);
    } else {
      console.log(`  – Global launchers already current`);
    }
    let installed = 0, alreadyConfigured = 0, notDetected = 0, errored = 0;
    for (const r of result.symbionts) {
      if (r.status === 'installed') { installed++; console.log(`  ✓ Installed ${r.symbiont}`); }
      else if (r.status === 'already-configured') { alreadyConfigured++; }
      else if (r.status === 'not-detected') { notDetected++; }
      else if (r.status === 'error') { errored++; console.error(`  ✗ ${r.symbiont}: ${r.error}`); }
    }
    console.log(
      `\nDetected agents: ${installed + alreadyConfigured}; ` +
      `newly installed: ${installed}; already configured: ${alreadyConfigured}; ` +
      `not detected: ${notDetected}${errored ? `; errors: ${errored}` : ''}.`,
    );
    if (result.migration.projectsCleaned > 0 || result.migration.projectsErrored > 0) {
      console.log(
        `Migration walker: ${result.migration.projectsCleaned} project(s) cleaned, ` +
        `${result.migration.projectsErrored} errored.`,
      );
    }
    return;
  }

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
    const config = loadMergedConfig(vaultDir, { groveId: grove.id });
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
    const config = withInferredReleaseProvenanceDefaults(MycoConfigSchema.parse({
      version: 3,
    }), projectRoot);

    saveConfig(vaultDir, config);
    fs.writeFileSync(path.join(vaultDir, '.gitignore'), VAULT_GITIGNORE, 'utf-8');
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

  // Write embedding flags to the Grove tier (new vault only). Embedding
  // config belongs in ~/.myco/groves/<id>/config.yaml, not the project
  // YAML — ProjectConfigSchema strips those fields on save.
  if (Object.keys(embeddingFromFlags).length > 0) {
    updateGroveConfig(grove.id, (c) => ({
      ...c,
      embedding: { ...c.embedding, ...embeddingFromFlags },
    }));
  }

  const allManifests = loadManifests();
  const detected = detectSymbionts(projectRoot);
  const detectedNames = new Set(detected.map((d) => d.manifest.name));

  // Load existing symbiont config for pre-checking (interactive UI) and
  // reconciliation (always — needed to detect newly-disabled symbionts).
  let existingSymbionts: Record<string, { enabled: boolean }> | undefined;
  if (alreadyInitialized) {
    try {
      const { loadMergedConfig } = await import('../config/loader.js');
      const existing = loadMergedConfig(vaultDir, { groveId: grove.id });
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
      if (selectedManifests.length === 0 && isInteractive) {
        console.log('  Skipped agent configuration.');
      }
    }

    // Always reconcile: uninstall newly-disabled symbionts before registering
    // newly-selected ones. Mirrors cli/remove.ts for unchecked items.
    const previouslyEnabled = new Set(
      existingSymbionts
        ? Object.entries(existingSymbionts).filter(([, v]) => v.enabled).map(([k]) => k)
        : [],
    );
    const newlySelected = new Set(selectedManifests.map((m) => m.name));
    const newlyDisabled = [...previouslyEnabled].filter((n) => !newlySelected.has(n));

    const pkgRoot = resolvePackageRoot();
    for (const name of newlyDisabled) {
      const manifest = allManifests.find((m) => m.name === name);
      if (!manifest) continue;
      const { SymbiontInstaller } = await import('../symbionts/installer.js');
      const installer = new SymbiontInstaller(manifest, projectRoot, pkgRoot);
      installer.uninstall();
      console.log(`  ✓ Removed ${manifest.displayName}: files no longer referenced in config`);
    }

    if (newlySelected.size === 0) {
      // User unchecked everything (or auto-selection found nothing). Drop the
      // symbionts block from myco.yaml — matches cli/remove.ts behavior.
      updateConfig(vaultDir, (config) => {
        const { symbionts: _, ...rest } = config;
        return rest;
      });
    } else {
      const symbiontsConfig: Record<string, { enabled: boolean }> = {};
      for (const m of selectedManifests) {
        symbiontsConfig[m.name] = { enabled: true };
      }
      updateConfig(vaultDir, (config) => ({
        ...config,
        symbionts: symbiontsConfig,
      }));
      registerSymbionts(selectedManifests, projectRoot, pkgRoot, 'Registered', undefined, grove.id);
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
