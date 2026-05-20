import {
  resolveVaultDir, resolveProjectRoot, assertSafeProjectRoot, UnsafeProjectRootError,
  isInsideWorktree, resolveMainRepoRoot, resolveWorktreeRoot,
} from '../vault/resolve.js';
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

Initialize or reconcile Myco for the current project.

Options:
  --project <path>                 Project root to initialize
  --grove <name|id>                Grove to bind this project to
  --worktree                       Bootstrap hook files in a git worktree
  --non-interactive                Run without prompts
  --embedding-provider <provider>  Embedding provider for new vaults
  --embedding-model <model>        Embedding model for new vaults
  --embedding-url <url>            Embedding base URL for new vaults
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
    await runWorktreeBootstrap();
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

/**
 * Bootstrap hook files inside a git worktree.
 *
 * Worktrees inherit nothing untracked from `git worktree add`: the capture
 * stack's `.claude/settings.json`, `.agents/myco-run.cjs`, and (if used)
 * `.myco/runtime.command` are all gitignored, so a fresh worktree captures
 * nothing until those files exist at its own root. The main repo's vault
 * stays shared (via `resolveVaultDir`'s worktree-aware walk); only the
 * hook bootstrap needs per-worktree writes.
 *
 * This path:
 *   1. Asserts we're in a worktree (not the main checkout).
 *   2. Asserts the main repo has an initialized vault.
 *   3. Reads the symbiont enablement from the main repo's config.
 *   4. Runs `SymbiontInstaller` with `projectRoot = worktreeRoot` and
 *      `vaultDir = mainRepoRoot/.myco` so hook files land in the worktree
 *      while config reads still resolve through the shared vault.
 *   5. Mirrors `<main>/.myco/runtime.command` into the worktree if the
 *      main repo pins a project-scoped runtime. Machine-scoped pins
 *      (`~/.myco/runtime.command`) work for worktrees without mirroring.
 */
async function runWorktreeBootstrap(): Promise<void> {
  const cwd = process.cwd();
  if (!isInsideWorktree(cwd)) {
    console.error(
      '\nmyco init --worktree: cwd is not inside a git worktree.\n' +
      'Run `myco init --worktree` from the worktree path you want to bootstrap.\n',
    );
    process.exit(1);
  }
  const worktreeRoot = resolveWorktreeRoot(cwd);
  const mainRepoRoot = resolveMainRepoRoot(cwd);
  if (!worktreeRoot) {
    console.error('\nmyco init --worktree: failed to resolve the worktree root via git.\n');
    process.exit(1);
  }

  const mainVaultDir = path.join(mainRepoRoot, '.myco');
  if (!fs.existsSync(path.join(mainVaultDir, 'myco.yaml'))) {
    console.error(
      `\nmyco init --worktree: main repo at ${mainRepoRoot} has no Myco vault.\n` +
      'Run `myco init` in the main repo first, then `myco init --worktree` in this worktree.\n',
    );
    process.exit(1);
  }

  // Pull symbiont enablement from the main repo's merged config so we
  // bootstrap exactly the symbionts the user already configured.
  const { loadMergedConfig } = await import('../config/loader.js');
  const config = loadMergedConfig(mainVaultDir);
  const enabledNames = new Set(
    Object.entries(config.symbionts ?? {})
      .filter(([, value]) => (value as { enabled?: boolean }).enabled)
      .map(([name]) => name),
  );

  const allManifests = loadManifests();
  const selectedManifests = allManifests.filter((m) => enabledNames.has(m.name));
  if (selectedManifests.length === 0) {
    console.log('  No symbionts enabled in the main repo — nothing to bootstrap.');
    return;
  }

  // Ensure `<worktree>/.myco/` exists so a mirrored runtime.command has
  // somewhere to land; the installer also creates `.agents/` for the hook
  // guard and CLI launcher.
  fs.mkdirSync(path.join(worktreeRoot, '.myco'), { recursive: true });

  const pkgRoot = resolvePackageRoot();
  console.log(`Bootstrapping ${selectedManifests.length} symbiont(s) in worktree ${worktreeRoot}`);
  registerSymbionts(selectedManifests, worktreeRoot, pkgRoot, 'Registered', mainVaultDir);

  // Mirror the project-scoped runtime pin into the worktree if one exists.
  // myco-run.cjs walks up from cwd looking for `<dir>/.myco/runtime.command`,
  // and worktrees typically don't sit beneath the main repo, so the walk
  // would otherwise miss a project pin entirely.
  const mainPin = path.join(mainVaultDir, 'runtime.command');
  if (fs.existsSync(mainPin)) {
    // lstat (not stat) so we observe the link itself rather than its
    // target. A symlinked runtime.command — planted by a malicious clone
    // or a shared-repo collaborator — would otherwise be followed by
    // copyFileSync to whatever the link points at, and then executed by
    // myco-run.cjs as if it were a trusted binary path.
    const pinStat = fs.lstatSync(mainPin);
    if (pinStat.isSymbolicLink()) {
      console.warn(
        `  ⚠ Skipped mirroring runtime.command — main repo's pin is a symlink (refusing to follow). `
        + `Resolve manually if intentional.`,
      );
    } else {
      // runtime.command is exec'd by myco-run.cjs — `cat` it, trust the
      // contents, exec the binary it names. Two structural sanity checks
      // before we mirror it into the worktree:
      //   - 4 KiB cap: a real pin is one absolute path (~50–200 bytes);
      //     anything larger smells like a planted payload trying to
      //     overflow downstream parsers.
      //   - single non-empty line: the consumer reads `${contents.trim()}`
      //     as a single command, so a multi-line file is malformed
      //     regardless of intent. Refuse rather than silently mirror.
      const MAX_PIN_BYTES = 4 * 1024;
      if (pinStat.size > MAX_PIN_BYTES) {
        console.warn(
          `  ⚠ Skipped mirroring runtime.command — main repo's pin is ${pinStat.size} bytes (>${MAX_PIN_BYTES}); refusing to mirror an oversized exec spec.`,
        );
      } else {
        const contents = fs.readFileSync(mainPin, 'utf-8');
        const lines = contents.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        if (lines.length !== 1) {
          console.warn(
            `  ⚠ Skipped mirroring runtime.command — main repo's pin is not a single non-empty line; refusing to mirror.`,
          );
        } else {
          // Read + atomic-rewrite rather than copyFileSync so we never expose
          // a partial write at the destination and so the source's mode bits
          // don't carry over (we don't trust upstream permissions for an
          // execution-relevant path).
          const worktreePin = path.join(worktreeRoot, '.myco', 'runtime.command');
          fs.writeFileSync(worktreePin, contents, { encoding: 'utf-8', mode: 0o644 });
          console.log(`  ✓ Mirrored runtime.command from main repo`);
        }
      }
    }
  }

  console.log('');
  console.log('=== Worktree Bootstrap Complete ===');
  console.log(`Worktree: ${worktreeRoot}`);
  console.log(`Vault:    ${mainVaultDir} (shared with main repo)`);
  console.log('');
  console.log('Start a coding session in this worktree -- capture is now live.');
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
