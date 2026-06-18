import { resolveVaultDir, resolveProjectRoot } from '../vault/resolve.js';
import { parseStrictFlags } from './args.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { resolveProjectDashboardUrl } from './dashboard-url.js';
import { loadManifests } from '../symbionts/detect.js';
import type { SymbiontManifest } from '../symbionts/manifest-schema.js';
import { loadConfig, updateConfig } from '../config/loader.js';
import { withInferredReleaseProvenanceDefaults } from '../release-provenance/defaults.js';
import { getPluginVersion } from '../version.js';
import { DAEMON_CLIENT_TIMEOUT_MS } from '../constants.js';
import { readDaemonPort } from '../daemon/service-state.js';
import { listGroves, listRegisteredProjects } from '../grove/registry.js';
import { resolveLastUpdateVersionPath } from '../grove/paths.js';
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
//
// Binary upgrades have moved to `myco upgrade [<version>]`.
// The old `--target-version` / `--cancel-update` flags are no longer
// accepted and will produce a redirect error.

const USAGE = `Usage: myco update [options]

Regenerate managed Myco project files and migrate legacy config to the
current Machine/Grove/Project config tiers.

Options:
  --project <path>   Update only this project (default: every registered project)
  --all-projects     Deprecated alias; update is global by default
  -h, --help         Show this help

Binary upgrades have moved to a dedicated command:
  myco upgrade               Upgrade to the latest stable release
  myco upgrade <version>     Upgrade to a specific version
`;

export async function run(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  // These flags drove the old [update]-intent binary-upgrade path, which
  // has been superseded by `myco upgrade [<version>]`. Reject them with
  // a clear redirect so users who relied on the old flags know where to go.
  if (args.some((a) => a === '--target-version' || a === '--cancel-update')) {
    console.error(
      'Binary upgrades have moved to `myco upgrade`.\n'
      + '  myco upgrade               — upgrade to the latest stable release\n'
      + '  myco upgrade <version>     — upgrade to a specific version\n'
      + '\n'
      + '`myco update` now only refreshes project config, hooks, and MCP entries.',
    );
    process.exit(1);
  }

  const parsed = parseStrictFlags('myco update', args, [
    { name: '--project', value: 'required' },
    { name: '--all-projects' },
    { name: '--help', aliases: ['-h'] },
  ], USAGE);

  // Explicit single-project targeting — update only this project. The
  // strict parser guarantees a value: a bare `--project` is a usage
  // error, not a silent fan-out to every registered project.
  if (parsed.has('--project')) {
    let machineWideErrors: string[] = [];
    try {
      machineWideErrors = await runForProject(parsed.value('--project')!);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    if (machineWideErrors.length > 0) {
      reportMachineWideErrors(machineWideErrors);
      process.exit(1);
    }
    return;
  }

  // Global by default: one machine binary and one daemon serve every
  // Grove/project, so `myco update` updates them all. `--all-projects`
  // is a deprecated, tolerated alias for this default.
  await runAllProjects();
}

function reportMachineWideErrors(errors: string[]): void {
  console.error(`⚠ ${errors.length} machine-wide update step${errors.length === 1 ? '' : 's'} failed:`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
}

/**
 * Machine-wide side effects of `myco update`: re-render every global
 * symbiont config (~/.claude/, ~/.cursor/, etc.), scrub stale global
 * hook entries, run the per-project global-install migration pass
 * across every registered project, and stamp the version file.
 *
 * Called ONCE per `myco update` invocation regardless of single-project
 * vs --all-projects mode. Hoisted out of runForProject so a
 * `myco update --all-projects` with N registered projects doesn't
 * re-run these N times. /code-review finding C7.
 */
async function runMachineWideUpdate(
  allManifests: SymbiontManifest[],
  currentVersion: string,
  stampPath: string,
): Promise<{ updatedCount: number; errors: string[] }> {
  let updatedCount = 0;
  const errors: string[] = [];

  // --- Refresh GLOBAL symbiont configs ---
  //
  // Post-global-install (plan 38cff0752c919ffd §4), `myco update` writes
  // only at user-home (`~/.claude/`, `~/.codeium/windsurf/`, etc.) — not
  // into the project's `.<symbiont>/` directory. `runSymbiontDetection`
  // walks the manifest registry and installs at global scope for every
  // agent whose `detectionDir` exists, idempotently.
  const { runSymbiontDetection } = await import('./bootstrap.js');
  const detection = runSymbiontDetection();
  const installedCount = detection.filter((d) => d.status === 'installed').length;
  for (const d of detection) {
    if (d.status === 'installed' && d.install) {
      const installed = [
        d.install.hooks && 'hooks',
        d.install.mcp && 'MCP server',
        d.install.skills && 'skills',
        d.install.settings && 'settings',
        d.install.instructions && 'instructions',
      ].filter(Boolean);
      const manifest = allManifests.find((m) => m.name === d.symbiont);
      const label = manifest?.displayName ?? d.symbiont;
      console.log(`  ✓ Updated ${label}: ${installed.join(', ')}`);
    } else if (d.status === 'error') {
      console.log(`  ✗ Failed to update ${d.symbiont}: ${d.error ?? 'unknown error'}`);
      errors.push(`${d.symbiont}: ${d.error ?? 'unknown error'}`);
    }
  }
  updatedCount += installedCount;
  if (installedCount === 0 && detection.every((d) => d.status === 'not-detected' || d.status === 'already-configured')) {
    console.log('  – No detected agents on this machine');
  }

  // --- Heal known escaped global config artifacts ---
  // Historical smoke runs could write temp `/tmp/myco-*-smoke-*/home/launcher.cjs`
  // commands into real global agent config files when HOME wasn't sandboxed.
  // Installer ownership detection intentionally preserves non-canonical paths,
  // so update runs the one-shot global scrub explicitly after symbiont install.
  try {
    const { runGlobalConfigMigration } = await import('../grove/global-config-migration.js');
    const globalConfigMigration = runGlobalConfigMigration();
    const repaired = globalConfigMigration.outcomes.filter((outcome) => outcome.entriesRemoved > 0 && !outcome.error);
    const failed = globalConfigMigration.outcomes.filter((outcome) => outcome.entriesRemoved > 0 && outcome.error);
    for (const outcome of repaired) {
      console.log(`  ✓ Scrubbed ${outcome.entriesRemoved} stale global hook group${outcome.entriesRemoved === 1 ? '' : 's'}: ${outcome.filePath}`);
      updatedCount++;
    }
    for (const outcome of failed) {
      console.log(`  !! Failed to scrub stale global hook groups from ${outcome.filePath}: ${outcome.error}`);
    }
  } catch (err) {
    console.log(`  !! Global config scrub failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Delete retired launcher trampolines LAST ---
  // Only after detection rewrote every detected agent's hook/MCP config onto the
  // binary and the scrub healed escaped references. Deleting earlier would orphan
  // a config not yet rewritten in this pass (capture-loss window); by here no
  // config references `~/.myco/launcher.cjs`, so removal is safe.
  try {
    const { removeRetiredGlobalLaunchers } = await import('../grove/launcher-cleanup.js');
    const removed = removeRetiredGlobalLaunchers().removed;
    if (removed.length > 0) {
      console.log(`  ✓ Removed ${removed.length} retired launcher trampoline${removed.length === 1 ? '' : 's'}`);
      updatedCount += removed.length;
    }
  } catch (err) {
    console.log(`  !! Retired launcher cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Per-project one-shot global-install migration ---
  try {
    const { runGlobalInstallMigrationPass } = await import('../grove/global-install-migration.js');
    const { recordMigrationPass } = await import('../db/queries/migration-log.js');
    const { getDatabase } = await import('../db/client.js');
    const pass = runGlobalInstallMigrationPass();
    if (pass.projectsCleaned > 0) {
      console.log(`  ✓ Migrated ${pass.projectsCleaned} project${pass.projectsCleaned > 1 ? 's' : ''} to global install`);
      updatedCount += pass.projectsCleaned;
    }
    if (pass.projectsErrored > 0) {
      console.log(`  !! ${pass.projectsErrored} project${pass.projectsErrored > 1 ? 's' : ''} errored during migration — run \`myco doctor\` for details`);
    }
    try { recordMigrationPass(getDatabase(), pass); } catch { /* audit log is best-effort */ }
  } catch (err) {
    console.log(`  !! Migration pass failed: ${(err as Error).message}`);
  }

  // --- Registered-project managed files ---
  //
  // Global install still owns some local repository files: rules guidance and
  // repo-level ignore entries today, future project-managed surfaces later.
  // Reconcile them by registered Grove ownership, not by the caller's cwd, so
  // `myco-dev update` only touches service-dev Groves while the published
  // daemon updates service Groves.
  try {
    const { reconcileRegisteredManagedProjectFiles } = await import('../symbionts/reconcile.js');
    const outcomes = reconcileRegisteredManagedProjectFiles({ manifests: allManifests });
    const agentsUpdated = outcomes.filter((o) => o.result?.agentsMd).length;
    const gitignoreUpdated = outcomes.filter((o) => o.result?.gitignore).length;
    const errored = outcomes.filter((o) => o.error);
    if (agentsUpdated > 0 || gitignoreUpdated > 0) {
      const parts = [
        agentsUpdated > 0 && `AGENTS.md for ${agentsUpdated} project${agentsUpdated === 1 ? '' : 's'}`,
        gitignoreUpdated > 0 && `.gitignore for ${gitignoreUpdated} project${gitignoreUpdated === 1 ? '' : 's'}`,
      ].filter(Boolean);
      console.log(`  ✓ Updated managed project files: ${parts.join(', ')}`);
      updatedCount += agentsUpdated + gitignoreUpdated;
    }
    if (errored.length > 0) {
      console.log(`  !! Managed project-file reconciliation failed for ${errored.length} project${errored.length === 1 ? '' : 's'}`);
    }
  } catch (err) {
    console.log(`  !! Managed project-file reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Write version stamp ---
  try {
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, currentVersion, 'utf-8');
  } catch {
    // Non-fatal — stamp write failure shouldn't break the update
  }

  return { updatedCount, errors };
}

interface RunForProjectOptions {
  /**
   * Skip the machine-wide side effects (global symbiont install, config
   * scrub, migration pass, version stamp). Set when the caller has
   * already invoked `runMachineWideUpdate` exactly once for the whole
   * batch — `runAllProjects` is the canonical use site.
   */
  skipMachineWide?: boolean;
}

/**
 * Sync one project's managed files. Returns the machine-wide step errors
 * (per-symbiont global-install failures) so the CLI entry point can fold
 * them into its exit-code rollup; empty when `skipMachineWide` is set.
 */
async function runForProject(projectRoot: string | undefined, options: RunForProjectOptions = {}): Promise<string[]> {
  const vaultDir = projectRoot
    ? path.join(projectRoot, '.myco')
    : resolveVaultDir();
  if (!fs.existsSync(path.join(vaultDir, 'myco.yaml'))) {
    // Surface as an error rather than process.exit so --all-projects can
    // continue past a broken project and aggregate failures at the end.
    throw new Error(
      `No myco.yaml found in ${vaultDir}. Open the project in a supported agent so Myco auto-registers it, or commit Myco config to the repo via the dashboard's Symbionts page first.`,
    );
  }

  console.log(`Updating Myco vault at ${vaultDir}\n`);

  const resolvedProjectRoot = projectRoot ?? resolveProjectRoot(vaultDir);

  // One-time Grove migration: a legacy (pre-0.25) project has a populated
  // .myco/myco.db but no project.toml Grove binding. Lift it into the
  // machine's default Grove before the rest of update operates on it.
  ensureGroveActivation(vaultDir, resolvedProjectRoot);
  const groveId = loadProjectManifest(vaultDir)?.grove?.id ?? null;

  const stampPath = resolveLastUpdateVersionPath();
  const currentVersion = getPluginVersion();

  let updatedCount = 0;

  // --- Update .gitignore to match current template ---
  // Routes through ProjectVault so the helper's contract (atomic write,
  // schema, idempotency) stays the single source of truth. A direct
  // `fs.writeFileSync` against `<vaultDir>/.gitignore` is the historical
  // bug class we're closing \u2014 every shared vault path has one writer.

  if (new ProjectVault(path.dirname(vaultDir)).ensureGitignore()) {
    console.log('  \u2713 Updated .gitignore');
    updatedCount++;
  } else {
    console.log('  \u2013 .gitignore is current');
  }

  // --- Update symbiont registration ---

  const allManifests = loadManifests();

  const config = loadConfig(vaultDir, { groveId, migrateTiers: true });
  const withReleaseDefaults = withInferredReleaseProvenanceDefaults(config, resolvedProjectRoot);
  if (withReleaseDefaults !== config) {
    updateConfig(vaultDir, () => withReleaseDefaults);
    console.log('  ✓ Updated release provenance defaults');
    updatedCount++;
  }
  // Machine-wide refresh (global symbiont install, config scrub,
  // per-project migration pass, version stamp). Skipped by --all-projects
  // which hoists this work out of its per-project loop. /code-review C7.
  let machineWideErrors: string[] = [];
  if (!options.skipMachineWide) {
    const machineWide = await runMachineWideUpdate(allManifests, currentVersion, stampPath);
    updatedCount += machineWide.updatedCount;
    machineWideErrors = machineWide.errors;
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

  return machineWideErrors;
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

  // Hoist machine-wide work (global symbiont install, scrub, migration
  // pass, version stamp) ABOVE the per-project loop. Each block was
  // running N times — the migration pass itself iterates every project,
  // so an N-project --all-projects pass was N×N for the worst block.
  // /code-review finding C7.
  console.log('=== Machine-wide refresh ===');
  const allManifests = loadManifests();
  const currentVersion = getPluginVersion();
  const stampPath = resolveLastUpdateVersionPath();
  const machineWideErrors: string[] = [];
  try {
    machineWideErrors.push(...(await runMachineWideUpdate(allManifests, currentVersion, stampPath)).errors);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ Machine-wide refresh failed: ${message}`);
    machineWideErrors.push(`machine-wide refresh: ${message}`);
  }

  const failures: { target: typeof targets[number]; error: unknown }[] = [];
  for (const target of targets) {
    console.log(`\n=== ${target.groveSlug}/${target.projectName} (${target.root}) ===`);
    try {
      await runForProject(target.root, { skipMachineWide: true });
    } catch (error) {
      failures.push({ target, error });
      console.error(`  ✗ Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log('');
  if (failures.length === 0 && machineWideErrors.length === 0) {
    console.log(`✓ Updated all ${targets.length} project${targets.length === 1 ? '' : 's'}.`);
    return;
  }

  if (machineWideErrors.length > 0) {
    reportMachineWideErrors(machineWideErrors);
  }
  if (failures.length > 0) {
    console.error(`⚠ ${failures.length} of ${targets.length} project${targets.length === 1 ? '' : 's'} failed:`);
    for (const { target, error } of failures) {
      console.error(`  - ${target.groveSlug}/${target.projectName}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
