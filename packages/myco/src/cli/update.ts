import { resolveVaultDir, resolveProjectRoot } from '../vault/resolve.js';
import { VAULT_GITIGNORE, registerSymbionts } from './shared.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { loadConfig, getEnabledSymbiontNames } from '../config/loader.js';
import { getPluginVersion } from '../version.js';
import { UPDATE_STAMP_FILENAME } from '../constants/update.js';
import { DAEMON_CLIENT_TIMEOUT_MS } from '../constants.js';
import { readDaemonState, resolveDaemonServiceState } from '../daemon/service-state.js';
import { listGroves, listRegisteredProjects } from '../grove/registry.js';
import { loadProjectManifest } from '../config/project-manifest.js';
import { activateProjectMigration, completeLegacyArchive } from '../grove/activation.js';
import { projectUrlSlug } from '../grove/ids.js';
import fs from 'node:fs';
import path from 'node:path';

// `myco update` regenerates managed config — .gitignore, symbiont hooks,
// MCP entries, skills, settings. It does NOT trigger data migrations:
// runtime migrations (vector reindex, etc.) are owned by the daemon and
// gated by the `migration_tasks` ledger so they run exactly once per
// vault regardless of update invocations.

export async function run(args: string[]): Promise<void> {
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

  // --- One-time Grove migration (legacy → grove-bound) ---
  // A legacy 0.24.x project has a populated `.myco/myco.db` but no
  // `project.toml` Grove binding. Detect that state and run the
  // structural migration before regenerating managed config, so the
  // rest of `myco update` operates against the new layout.
  ensureGroveActivation(vaultDir, resolvedProjectRoot);

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

  const config = loadConfig(vaultDir);
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
  try {
    const { DaemonClient } = await import('../hooks/client.js');
    const daemonVaultDir = resolveVaultDir(resolvedProjectRoot);
    const client = new DaemonClient(daemonVaultDir);
    daemonHealthy = await client.ensureRunning();
    if (daemonHealthy && await httpMcpEndpointMissing(daemonVaultDir)) {
      daemonHealthy = await client.restart({ checkStale: false });
    }
  } catch {
    daemonHealthy = false;
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
  } else {
    console.log('Daemon could not be verified; run `myco restart` before using HTTP MCP.');
  }

  const dashboardUrl = resolveDashboardUrl(vaultDir);
  if (dashboardUrl) {
    console.log(`Dashboard: ${dashboardUrl}`);
  }
  console.log('Run `myco doctor` to verify setup health.');
}

/**
 * If `vaultDir` belongs to a legacy (pre-Grove) project — populated
 * database + `myco.yaml`, but no `project.toml` Grove binding — run the
 * one-time Grove activation as part of `myco update`. This is the
 * migration path the package upgrade documentation references: once a
 * contributor or user moves from 0.24.x to 0.25.x, their first
 * `myco update` per project transparently lifts that project into the
 * machine's default Grove and archives the legacy `.myco/myco.db`.
 *
 * Idempotent: re-runs against an already-migrated project return early
 * via `loadProjectManifest`'s binding check, so this stays cheap on the
 * post-migration steady state where every release ships another round
 * of `myco update --all-projects`.
 *
 * Tolerates fresh vaults: a `myco.yaml` without a `myco.db` is a
 * just-initialized project that has no data to migrate. Skip silently
 * rather than letting the activator throw "Legacy project database not
 * found" — that path is only reachable from genuine 0.24.x carryovers.
 */
function ensureGroveActivation(vaultDir: string, projectRoot: string): void {
  const manifest = loadProjectManifest(vaultDir);
  if (manifest?.grove?.binding_id) return;

  if (!fs.existsSync(path.join(vaultDir, 'myco.db'))) return;

  console.log('  → Legacy project detected; running one-time Grove migration…');
  const result = activateProjectMigration({ projectRoot });
  if (result.already_activated) {
    console.log(`  ✓ Project already activated in Grove ${result.grove.name} (${result.grove.slug})`);
  } else {
    const total = result.import_result
      ? Object.entries(result.import_result)
          .filter(([key]) => !key.startsWith('skipped_'))
          .reduce((sum, [, value]) => sum + Number(value), 0)
      : 0;
    console.log(`  ✓ Migrated to Grove ${result.grove.name} (${result.grove.slug}) — ${total} rows imported`);
    // Move the legacy `.myco/myco.db` and friends into `.archive-<ts>/`
    // so the project root looks clean post-migration. `activateProjectMigration`
    // already attempts this internally; calling it again is idempotent
    // and surfaces the archive path for the operator log.
    const archive = completeLegacyArchive(vaultDir);
    if (archive.archived_dir) {
      console.log(`  ✓ Archived legacy data to ${archive.archived_dir}`);
    }
  }
  console.log('');
}

/**
 * Build the dashboard URL pointing at this project's view in the
 * running daemon. Returns null if the daemon isn't reachable or the
 * grove/project bindings can't be resolved (e.g., the migration was
 * skipped because the project is already activated in a different
 * Grove). Used by `myco update` to tell the operator exactly where to
 * navigate after the upgrade — including the correct port for the
 * binary they ran (`service/` vs `service-dev/`).
 */
function resolveDashboardUrl(vaultDir: string): string | null {
  const manifest = loadProjectManifest(vaultDir);
  const groveSlug = manifest?.grove?.slug;
  const projectId = manifest?.project?.id;
  if (!groveSlug || !projectId) return null;

  const port = readDaemonPort(vaultDir);
  if (port === null) return null;

  // Look up the registered project to compute its url-stable slug via
  // the canonical helper. Falls back to the dashboard root when the
  // project hasn't been registered yet (the migration would have been
  // skipped and the project.toml won't reflect the binding).
  const groves = listGroves();
  const grove = groves.find((g) => g.slug === groveSlug);
  if (!grove) return `http://localhost:${port}/`;
  const projects = listRegisteredProjects(grove.id);
  const project = projects.find((p) => p.project_id === projectId);
  if (!project) return `http://localhost:${port}/`;
  const slug = projectUrlSlug(project.name, project.project_id);
  return `http://localhost:${port}/g/${groveSlug}/p/${slug}`;
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
  const groves = listGroves();
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

  console.log(`Updating ${targets.length} project${targets.length === 1 ? '' : 's'} across ${groves.length} Grove${groves.length === 1 ? '' : 's'}.\n`);

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
  const port = readDaemonPort(vaultDir);
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

function readDaemonPort(vaultDir: string): number | null {
  return readDaemonState(resolveDaemonServiceState(vaultDir, { env: process.env }).statePath)?.port ?? null;
}
