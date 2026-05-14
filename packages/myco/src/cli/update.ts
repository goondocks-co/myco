import { resolveVaultDir, resolveProjectRoot } from '../vault/resolve.js';
import { VAULT_GITIGNORE, registerSymbionts } from './shared.js';
import { resolveProjectDashboardUrl } from './dashboard-url.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { loadConfig, updateConfig, getEnabledSymbiontNames } from '../config/loader.js';
import { withInferredReleaseProvenanceDefaults } from '../release-provenance/defaults.js';
import { getPluginVersion } from '../version.js';
import { UPDATE_STAMP_FILENAME } from '../constants/update.js';
import { DAEMON_CLIENT_TIMEOUT_MS } from '../constants.js';
import { readDaemonPort } from '../daemon/service-state.js';
import { listGroves, listRegisteredProjects } from '../grove/registry.js';
import { loadProjectManifest } from '../config/project-manifest.js';
import {
  activateProjectMigration,
  activationMarkerPath,
  completeLegacyArchive,
  summarizeImportedRowCount,
} from '../grove/activation.js';
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
  --project <path>  Project root to update
  --all-projects    Update every registered project served by this binary
  -h, --help        Show this help
`;

export async function run(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
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
  for (const grove of groves) {
    for (const project of listRegisteredProjects(grove.id)) {
      targets.push({ groveSlug: grove.slug, projectName: project.name, root: project.root });
    }
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
    return response.status === 404;
  } catch {
    return false;
  }
}
