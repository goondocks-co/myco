import { resolveVaultDir, resolveProjectRoot } from '../vault/resolve.js';
import { VAULT_GITIGNORE, registerSymbionts } from './shared.js';
import { resolveProjectDashboardUrl } from './dashboard-url.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { loadConfig, updateConfig, getEnabledSymbiontNames } from '../config/loader.js';
import { withInferredReleaseProvenanceDefaults } from '../release-provenance/defaults.js';
import { getPluginVersion } from '../version.js';
import { UPDATE_STAMP_FILENAME } from '../constants/update.js';
import { DAEMON_CLIENT_TIMEOUT_MS } from '../constants.js';
import { readDaemonPort, readDaemonState, resolveDaemonServiceState } from '../daemon/service-state.js';
import { listGroves, listRegisteredProjects } from '../grove/registry.js';
import { resolveGroveDir } from '../grove/paths.js';
import { loadProjectManifest } from '../config/project-manifest.js';
import { writeUpdateIntent, clearIntentSection, readUpdateIntent } from '../daemon/intent.js';
import { DaemonClient } from '../hooks/client.js';
import {
  activateProjectMigration,
  activationMarkerPath,
  completeLegacyArchive,
  summarizeImportedRowCount,
} from '../grove/activation.js';
import {
  readMigrationPlan,
  validateMigrationPlan,
  executeMigration,
  type MachineState,
} from '../migrations/agent-config-grove-promotion.js';
import fs from 'node:fs';
import path from 'node:path';

// `myco update` regenerates managed config — .gitignore, symbiont hooks,
// MCP entries, skills, settings. It does NOT trigger data migrations:
// runtime migrations (vector reindex, etc.) are owned by the daemon and
// gated by the `migration_tasks` ledger so they run exactly once per
// vault regardless of update invocations.

const USAGE = `Usage: myco update [options]

Regenerate managed Myco project files and migrate legacy config to the
current Machine/Grove/Project config tiers.

Options:
  --project <path>           Project root to update
  --all-projects             Update every registered project served by this binary
  --target-version <ver>     Request the daemon install @goondocks/myco@<ver>
                             via the intent + reconciliation pipeline
  --cancel-update            Clear a pending [update] intent without installing
  -h, --help                 Show this help
`;

export async function run(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  // `--target-version <v>` writes a binary-update intent for the daemon's
  // reconciler to pick up. Distinct from the project-config-sync path
  // (the rest of this command). Doesn't touch project files.
  const targetVersionIdx = args.indexOf('--target-version');
  if (targetVersionIdx !== -1) {
    const target = args[targetVersionIdx + 1];
    if (!target) {
      console.error('--target-version requires a version argument');
      process.exit(1);
    }
    await runUpdateIntent(target);
    return;
  }

  if (args.includes('--cancel-update')) {
    await runCancelUpdate();
    return;
  }

  if (args.includes('--all-projects')) {
    await runAllProjects();
    return;
  }

  let projectRoot: string | undefined;
  const projectIdx = args.indexOf('--project');
  if (projectIdx !== -1 && args[projectIdx + 1]) {
    projectRoot = args[projectIdx + 1];
  }

  try {
    await runForProject(projectRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function runForProject(projectRoot: string | undefined): Promise<void> {
  const vaultDir = projectRoot
    ? path.join(projectRoot, '.myco')
    : resolveVaultDir();
  if (!fs.existsSync(path.join(vaultDir, 'myco.yaml'))) {
    // Surface as an error rather than process.exit so --all-projects can
    // continue past a broken project and aggregate failures at the end.
    throw new Error(`No myco.yaml found in ${vaultDir}. Run 'myco init' first.`);
  }

  console.log(`Updating Myco vault at ${vaultDir}\n`);

  const resolvedProjectRoot = projectRoot ?? resolveProjectRoot(vaultDir);

  // One-time Grove migration: a legacy (pre-0.25) project has a populated
  // .myco/myco.db but no project.toml Grove binding. Lift it into the
  // machine's default Grove before the rest of update operates on it.
  ensureGroveActivation(vaultDir, resolvedProjectRoot);
  const groveId = loadProjectManifest(vaultDir)?.grove?.id ?? null;

  const stampPath = path.join(vaultDir, UPDATE_STAMP_FILENAME);
  const currentVersion = getPluginVersion();

  let updatedCount = 0;

  // --- Update .gitignore to match current template ---

  const gitignorePath = path.join(vaultDir, '.gitignore');
  const currentGitignore = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf-8')
    : '';

  if (currentGitignore !== VAULT_GITIGNORE) {
    fs.writeFileSync(gitignorePath, VAULT_GITIGNORE, 'utf-8');
    console.log('  \u2713 Updated .gitignore');
    updatedCount++;
  } else {
    console.log('  \u2013 .gitignore is current');
  }

  // --- Update symbiont registration ---

  const allManifests = loadManifests();
  const pkgRoot = resolvePackageRoot();

  const config = loadConfig(vaultDir, { groveId, migrateTiers: true });
  const withReleaseDefaults = withInferredReleaseProvenanceDefaults(config, resolvedProjectRoot);
  if (withReleaseDefaults !== config) {
    updateConfig(vaultDir, () => withReleaseDefaults);
    console.log('  ✓ Updated release provenance defaults');
    updatedCount++;
  }
  let configured: typeof allManifests;

  const enabledNames = getEnabledSymbiontNames(config);

  if (enabledNames) {
    // Explicit mode: only update enabled symbionts
    configured = allManifests.filter((m) => enabledNames.has(m.name));

    // Warn about registered-but-not-enabled symbionts
    for (const m of allManifests) {
      if (!enabledNames.has(m.name) && fs.existsSync(path.join(resolvedProjectRoot, m.configDir))) {
        console.log(`  !! ${m.displayName} is registered but not enabled. Run 'myco remove --symbiont ${m.name}' to clean up.`);
      }
    }
  } else {
    // Fallback: configDir-exists heuristic (pre-existing installs without symbionts config)
    configured = allManifests.filter((m) =>
      fs.existsSync(path.join(resolvedProjectRoot, m.configDir)),
    );
  }

  if (configured.length > 0) {
    const registered = registerSymbionts(configured, resolvedProjectRoot, pkgRoot, 'Updated');
    updatedCount += registered;
  } else {
    console.log('  \u2013 No configured agents found');
  }

  // --- Write version stamp ---
  // Informational marker of the last-updated version; not a migration gate.
  try {
    fs.writeFileSync(stampPath, currentVersion, 'utf-8');
  } catch {
    // Non-fatal — stamp write failure shouldn't break the update
  }

  // HTTP MCP entries depend on the local daemon being reachable at the
  // configured project port. `myco update` is the real reconciliation path for
  // generated agent config, so bring the daemon up after the config rewrite.
  // In git worktrees, daemon startup intentionally resolves through git-common
  // to the shared project vault; using the literal --project/.myco path here
  // makes the child daemon start against the shared vault while this health
  // check waits on the worktree vault and falsely reports failure.
  let daemonHealthy = false;
  let daemonError: string | null = null;
  try {
    const { DaemonClient } = await import('../hooks/client.js');
    const daemonVaultDir = resolveVaultDir(resolvedProjectRoot);
    const client = new DaemonClient(daemonVaultDir);
    daemonHealthy = await client.ensureRunning();
    if (daemonHealthy && await httpMcpEndpointMissing(daemonVaultDir)) {
      daemonHealthy = await client.restart({ checkStale: false });
    }
  } catch (err) {
    daemonHealthy = false;
    daemonError = err instanceof Error ? err.message : String(err);
  }

  // --- Summary ---

  console.log('');
  if (updatedCount > 0) {
    console.log(`Updated ${updatedCount} item${updatedCount > 1 ? 's' : ''}.`);
  } else {
    console.log('Everything is up to date.');
  }
  if (daemonHealthy) {
    console.log('Daemon is running for HTTP MCP.');
  } else if (daemonError) {
    console.log(`Daemon could not be verified (${daemonError}); run \`myco restart\` before using HTTP MCP.`);
  } else {
    console.log('Daemon could not be verified; run `myco restart` before using HTTP MCP.');
  }

  const dashboardUrl = dashboardUrlForVault(vaultDir);
  if (dashboardUrl) {
    console.log(`Dashboard: ${dashboardUrl}`);
  }
  console.log('Run `myco doctor` to verify setup health.');
}

/**
 * Lift a legacy (pre-0.25) project into the machine's default Grove on
 * its first `myco update`, AND repair partial-state vaults whose
 * `project.toml` or registry row went missing post-activation.
 *
 * Three states it handles:
 *   1. Pre-Grove (no manifest, no marker): run full activation.
 *   2. Already-activated and consistent (manifest binding present):
 *      no-op return; steady-state mtime-cached read.
 *   3. Marker present but manifest missing or mismatched: run
 *      `activateProjectMigration` which detects the marker and rewrites
 *      the missing leg from authoritative state.
 *
 * Tolerates fresh vaults: a `myco.yaml` without a `myco.db` AND no
 * marker is a just-initialized project with nothing to migrate.
 */
function ensureGroveActivation(vaultDir: string, projectRoot: string): void {
  const manifest = loadProjectManifest(vaultDir);
  const markerExists = fs.existsSync(activationMarkerPath(vaultDir));

  // Steady state: manifest binding present. activateProjectMigration would
  // also detect this via marker, but skipping the function call keeps the
  // hot path (every `myco update`) free of registry I/O.
  if (manifest?.grove?.binding_id && markerExists) return;

  // Fresh vault with nothing to migrate or repair.
  if (!markerExists && !fs.existsSync(path.join(vaultDir, 'myco.db'))) return;

  if (markerExists && !manifest?.grove?.binding_id) {
    console.log('  → Activation marker present but project.toml binding missing; repairing…');
  } else {
    console.log('  → Legacy project detected; running one-time Grove migration…');
  }
  const result = activateProjectMigration({ projectRoot });
  if (result.already_activated) {
    console.log(`  ✓ Project already activated in Grove ${result.grove.name} (${result.grove.slug})`);
    // Sweep up legacy data from an older activation that ran before
    // archiving was inline — bounded existsSync sweep, no-op on a
    // freshly-archived vault.
    const archive = completeLegacyArchive(vaultDir);
    if (archive.archived_dir) {
      console.log(`  ✓ Archived legacy data to ${archive.archived_dir}`);
    }
  } else {
    const total = summarizeImportedRowCount(result.import_result);
    console.log(`  ✓ Migrated to Grove ${result.grove.name} (${result.grove.slug}) — ${total} rows imported`);
    // activateProjectMigration archives legacy data inline; no second call.
  }
  console.log('');
}

/**
 * Dashboard URL for this project, or null when the daemon isn't reachable
 * or the project isn't fully bound. We deliberately do NOT fall back to
 * the global dashboard root — landing there post-migration would mislead
 * about where the project moved to.
 */
function dashboardUrlForVault(vaultDir: string): string | null {
  const manifest = loadProjectManifest(vaultDir);
  const groveSlug = manifest?.grove?.slug;
  const projectId = manifest?.project?.id;
  if (!groveSlug || !projectId) return null;

  const grove = listGroves().find((g) => g.slug === groveSlug);
  if (!grove) return null;
  const project = listRegisteredProjects(grove.id).find((p) => p.project_id === projectId);
  if (!project) return null;

  return resolveProjectDashboardUrl({
    vaultDir,
    groveSlug,
    groveId: grove.id,
    projectId,
    projectName: project.name,
  });
}

/**
 * Run the agent-config Grove promotion migration as the final step of
 * `runAllProjects`. Read → validate → execute; any failure throws so
 * the `runAllProjects` caller can surface it alongside per-project
 * failures and exit non-zero.
 */
async function runAgentConfigGrovePromotion(machine: MachineState): Promise<void> {
  const read = await readMigrationPlan(machine);
  if (read.errors.length > 0) {
    console.error('agent-config Grove promotion: pre-flight read failed');
    for (const e of read.errors) console.error(`  ${JSON.stringify(e)}`);
    throw new Error('migration aborted (read failure)');
  }

  const validated = validateMigrationPlan(read.plan);
  if (!validated.ok) {
    console.error('agent-config Grove promotion: pre-flight validation failed');
    for (const e of validated.errors) console.error(`  ${JSON.stringify(e)}`);
    throw new Error('migration aborted (validation failure)');
  }

  const result = await executeMigration(read.plan);
  if (!result.ok) {
    console.error('agent-config Grove promotion: write phase failed');
    for (const e of result.errors) console.error(`  ${JSON.stringify(e)}`);
    throw new Error('migration failed mid-write — manual intervention required');
  }

  console.log('  ✓ agent-config Grove promotion complete');
}

/**
 * Iterate every (Grove, project) pair in the registry and run the
 * per-project sync for each. Used by the post-binary-install update
 * script (machine-level binary install kicks one of these per Grove
 * project) and by `make dev-link` to refresh symbiont configs across
 * the whole machine.
 *
 * Per-project failures don't abort the loop — log and continue, then
 * exit non-zero if any project failed so callers can see the rollup.
 */
async function runAllProjects(): Promise<void> {
  const { detectInstallVariant, serviceVariantToDirName } = await import('../service/labels.js');
  const variant = detectInstallVariant();
  const groves = listGroves(undefined, { servedBy: serviceVariantToDirName(variant) });
  const targets: { groveSlug: string; projectName: string; root: string }[] = [];
  const machineGroves: MachineState['groves'] = [];
  for (const grove of groves) {
    let grovePath: string;
    try {
      grovePath = resolveGroveDir(grove.id);
    } catch {
      continue;
    }
    const groveProjects: MachineState['groves'][number]['projects'] = [];
    for (const project of listRegisteredProjects(grove.id)) {
      targets.push({ groveSlug: grove.slug, projectName: project.name, root: project.root });
      groveProjects.push({ id: project.project_id, vaultDir: path.join(project.root, '.myco') });
    }
    machineGroves.push({ id: grove.id, grovePath, projects: groveProjects });
  }

  if (targets.length === 0) {
    console.log('No registered projects across any Grove. Nothing to update.');
    return;
  }

  console.log(`Updating ${targets.length} project${targets.length === 1 ? '' : 's'} across ${groves.length} Grove${groves.length === 1 ? '' : 's'} served_by ${serviceVariantToDirName(variant)}.\n`);

  const failures: { target: typeof targets[number]; error: unknown }[] = [];
  for (const target of targets) {
    console.log(`\n=== ${target.groveSlug}/${target.projectName} (${target.root}) ===`);
    try {
      await runForProject(target.root);
    } catch (error) {
      failures.push({ target, error });
      console.error(`  ✗ Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log('');
  try {
    await runAgentConfigGrovePromotion({ groves: machineGroves });
  } catch (error) {
    failures.push({
      target: { groveSlug: '(machine)', projectName: 'agent-config Grove promotion', root: '' },
      error,
    });
    console.error(`  ✗ Failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log('');
  if (failures.length === 0) {
    console.log(`✓ Updated all ${targets.length} project${targets.length === 1 ? '' : 's'}.`);
    return;
  }

  console.error(`⚠ ${failures.length} of ${targets.length} project${targets.length === 1 ? '' : 's'} failed:`);
  for (const { target, error } of failures) {
    console.error(`  - ${target.groveSlug}/${target.projectName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}

/**
 * Write a `[update]` intent under `<stateDir>/intent.toml` and exit.
 *
 * Parallel to `myco restart`: the CLI does not call the installer
 * directly. Instead it writes intent and lets the daemon's
 * `reconcileSelf` PowerManager tick observe it and invoke
 * `spawnUpdateScript`. On install failure, the intent is retained so
 * the next reconcile tick retries — see `self-reconcile.ts`.
 *
 * The current daemon's running version is read via `DaemonClient`. When
 * the daemon is already at the requested version, no intent is written.
 */
async function runUpdateIntent(targetVersion: string): Promise<void> {
  // Strict semver gate at the CLI write boundary. The HTTP intent API
  // (Bucket F) applies the same regex, but the CLI writes intent.toml
  // directly via `writeUpdateIntent` without going through the HTTP
  // surface — an attacker who controls argv could otherwise bypass the
  // daemon-side validation and land an npm-spec like `file:/tmp/evil` or
  // `git+ssh://...` that the reconciler interpolates into
  // `npm install -g @goondocks/myco@<value>`. Keep this regex
  // byte-identical to `SEMVER_RE` in `daemon/api/intent.ts`.
  const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!SEMVER_RE.test(targetVersion)) {
    console.error(
      `--target-version must be a strict semver (e.g. 0.27.11); got '${targetVersion}'`,
    );
    process.exit(1);
  }

  const vaultDir = resolveVaultDir();
  const daemonService = resolveDaemonServiceState(vaultDir);
  const client = new DaemonClient(vaultDir);
  const reachable = await client.getInfoAsync();

  if (!reachable) {
    console.error('No daemon found. Start the daemon before running `myco update --target-version`.');
    process.exit(1);
  }

  // `getInfoAsync` returns the daemon's pid/port but not version (the
  // `/health` fallback intentionally omits it). For the same-version
  // short-circuit we consult daemon.json — written by the live daemon's
  // self-reconcile tick, includes the version field.
  const state = readDaemonState(daemonService.statePath);
  if (state?.version === targetVersion) {
    console.log(`Daemon already at version ${targetVersion}. Nothing to do.`);
    return;
  }

  writeUpdateIntent(daemonService, {
    target_version: targetVersion,
    requested_at: new Date().toISOString(),
  });
  console.log(
    `Update to ${targetVersion} requested. The daemon will apply it on the next reconcile tick.`,
  );
  console.log(`Tail ~/.myco/update-error.json if the update fails.`);
  console.log(`Run \`myco update --cancel-update\` to withdraw before it lands.`);
}

/**
 * Clear a pending `[update]` intent. Idempotent — succeeds even when
 * no intent is present.
 */
async function runCancelUpdate(): Promise<void> {
  const vaultDir = resolveVaultDir();
  const daemonService = resolveDaemonServiceState(vaultDir);
  const updateIntent = readUpdateIntent(daemonService);
  if (!updateIntent) {
    console.log('No pending update intent.');
    return;
  }
  clearIntentSection(daemonService, 'update');
  console.log(`Cleared pending update intent (target was ${updateIntent.target_version}).`);
}

async function httpMcpEndpointMissing(vaultDir: string): Promise<boolean> {
  const port = readDaemonPort(vaultDir, { env: process.env });
  if (port === null) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      signal: AbortSignal.timeout(DAEMON_CLIENT_TIMEOUT_MS),
    });
    if (response.status === 404) return true;
    if (response.ok) return false;
    // 5xx/4xx-not-404 — daemon is responding but /mcp is degraded
    // (router half-registered, auth busted, internal error). Treat as
    // missing so the caller triggers a restart to re-bind the route
    // table from a clean boot.
    return true;
  } catch {
    // Network failure (ECONNREFUSED / ETIMEDOUT / abort): the caller
    // already confirmed the daemon is "running" via ensureRunning's
    // pid check, so an unreachable TCP socket is the wedged-shutdown
    // shape this whole `myco update` finalizer exists to recover from.
    // The previous `return false` here silently kept the wedge alive
    // and the user had to `kill -9` manually. Restart it.
    return true;
  }
}
