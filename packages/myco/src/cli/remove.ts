import { resolveVaultDir, resolveProjectRoot, assertSafeProjectRoot, UnsafeProjectRootError } from '../vault/resolve.js';
import { isProcessAlive } from './shared.js';
import { parseStrictFlags, type ParsedFlags } from './args.js';
import { confirmDestructive } from './confirm.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { SymbiontInstaller, removeProjectLaunchers } from '../symbionts/installer.js';
import { GLOBAL_HOOK_LAUNCHER_FILENAME, GLOBAL_MCP_LAUNCHER_FILENAME } from '../grove/launcher-cleanup.js';
import { resolveMycoHome } from '../grove/paths.js';
import { updateConfig, TierConfigUnreadableError } from '../config/loader.js';
import type { SymbiontManifest } from '../symbionts/manifest-schema.js';
import { terminateDaemonProcess } from '../service/daemon-termination.js';
import fs from 'node:fs';
import path from 'node:path';

/** Map uninstall result to human-readable component labels. */
function uninstallLabels(result: ReturnType<SymbiontInstaller['uninstall']>): string[] {
  return [
    result.hooks && 'hooks',
    result.mcp && 'MCP server',
    result.skills && 'skills',
    result.settings && 'settings',
    result.instructions && 'instructions',
  ].filter(Boolean) as string[];
}

const USAGE = `Usage: myco remove [options]

With no flags, removes Myco's global install: unregisters the OS service,
deletes the global launchers, strips Myco's blocks from each detected
agent's user-global config, and unlinks the Myco-shipped skill symlinks.
Captured data under ~/.myco/ is preserved unless --purge is passed.
Prompts for confirmation; pass --yes for non-interactive use.

Passing --project, --symbiont, or --remove-vault switches to project scope.

Options:
  --project [<path>]     Remove Myco's project-local install (defaults to cwd)
  --symbiont <name>      Remove just one symbiont's project-local install
  --purge                Global scope: also delete ~/.myco/ (Grove DB + captured data)
                         Project scope: alias for --remove-vault
  --remove-vault         Project scope: delete the project's .myco/ dir
  --yes                  Skip the confirmation prompt
  -h, --help             Show this help
`;

export async function run(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  const parsed = parseStrictFlags('myco remove', args, [
    { name: '--project', value: 'optional' },
    { name: '--symbiont', value: 'required' },
    { name: '--purge' },
    { name: '--remove-vault' },
    { name: '--yes' },
    { name: '--help', aliases: ['-h'] },
  ], USAGE);

  // --symbiont removes one agent's registration; the vault-deletion flags
  // don't apply to it. Reject the combination outright — silently
  // dropping a destructive flag is the bug class this command just shed.
  if (parsed.has('--symbiont') && (parsed.has('--remove-vault') || parsed.has('--purge'))) {
    process.stderr.write(`myco remove: --remove-vault/--purge cannot be combined with --symbiont\n\n${USAGE}`);
    process.exit(2);
  }

  // --remove-vault is a project-scope operation: without this routing it
  // would fall through to the machine-wide teardown below (and then be
  // ignored there) — the exact opposite of what the caller asked for.
  if (parsed.has('--symbiont') || parsed.has('--project') || parsed.has('--remove-vault')) {
    return await runProjectRemove(parsed);
  }

  return await runGlobalRemove({
    purge: parsed.has('--purge'),
    assumeYes: parsed.has('--yes'),
  });
}

async function runGlobalRemove(opts: { purge: boolean; assumeYes: boolean }): Promise<void> {
  const { purge, assumeYes } = opts;
  const mycoHome = resolveMycoHome();

  if (!assumeYes) {
    let projectCount = 0;
    try {
      const { listGroves, listRegisteredProjects } = await import('../grove/registry.js');
      for (const grove of listGroves(mycoHome)) {
        projectCount += listRegisteredProjects(grove.id, mycoHome).length;
      }
    } catch { /* registry unreadable — the summary still describes the rest */ }
    const summary = [
      'myco remove will tear down the machine-wide Myco install:',
      '  - unregister the Myco OS service',
      "  - strip Myco's blocks from every detected agent's global config",
      `  - clean project-local artifacts in ${projectCount} registered project${projectCount === 1 ? '' : 's'}`,
      purge
        ? `  - DELETE ${mycoHome} (Grove DB + all captured data)`
        : `  - preserve captured data at ${mycoHome} (pass --purge to delete it)`,
    ].join('\n');
    if (!await confirmDestructive(summary)) {
      console.error('Aborted — nothing was removed.');
      process.exitCode = 1;
      return;
    }
  }

  console.log(`Removing Myco global install (${mycoHome})\n`);

  // --- Unregister the OS service (do this first so launchd/systemd
  //     doesn't relaunch the daemon mid-uninstall). ---
  try {
    const { getServiceManager } = await import('../service/manager.js');
    const { serviceLabel } = await import('../service/labels.js');
    const mgr = getServiceManager();
    if (mgr.supported) {
      await mgr.uninstall(serviceLabel(mycoHome));
      // §13.11: `myco remove` on a boot-scoped install must not leave the
      // root LaunchDaemon behind. Guarded by OBSERVED state; the boot
      // backend refuses under a sandboxed unit dir, so test runs never sudo.
      const { resolveObservedScope, getScopedServiceManager } = await import('../service/scoped.js');
      const observed = await resolveObservedScope(serviceLabel(mycoHome));
      if (observed === 'boot' || observed === 'both') {
        const bootMgr = getScopedServiceManager({ scope: { startAt: 'boot', runAs: 'invoking-user' } });
        await bootMgr.uninstall(serviceLabel(mycoHome));
      }
      console.log('  ✓ Unregistered OS service');
    }
  } catch (err) {
    const { ExternalMcpHardKillBlockedError } = await import('../service/windows.js');
    if (err instanceof ExternalMcpHardKillBlockedError) throw err;
    console.log(`  ⚠ Service uninstall skipped: ${(err as Error).message}`);
  }

  // --- Stop the daemon before deleting its files. Unregistering the service
  //     kills the process on launchd/systemd but not on Windows (schtasks
  //     /delete leaves the spawned daemon running), where it keeps the home
  //     locked → EBUSY on purge. A cooperative shutdown releases those handles
  //     on every platform (no-op once the service stop already killed it). ---
  try {
    const { resolveGlobalDaemonPort } = await import('../daemon/service-state.js');
    const { requestCooperativeShutdown } = await import('../service/cooperative-shutdown.js');
    if (await requestCooperativeShutdown(resolveGlobalDaemonPort(mycoHome))) {
      console.log('  ✓ Stopped running daemon');
    }
  } catch { /* no daemon answering — nothing to stop */ }

  // --- Remove per-symbiont global config blocks. ---
  const allManifests = loadManifests();
  const pkgRoot = resolvePackageRoot();
  for (const manifest of allManifests) {
    try {
      const installer = new SymbiontInstaller(
        manifest, '/', pkgRoot, false, undefined, null, 'global',
      );
      if (!installer.isAvailableForScope()) continue;
      const removed = uninstallLabels(installer.uninstall());
      if (removed.length > 0) {
        console.log(`  ✓ Removed from ${manifest.displayName}: ${removed.join(', ')}`);
      }
    } catch (err) {
      console.error(`  ✗ Failed to clean ${manifest.displayName}: ${(err as Error).message}`);
    }
  }

  // --- Delete the global launchers. lstat + unlink so we never follow a
  //     symlink and accidentally clobber an unrelated target. ---
  for (const filename of [GLOBAL_HOOK_LAUNCHER_FILENAME, GLOBAL_MCP_LAUNCHER_FILENAME]) {
    const target = path.join(mycoHome, filename);
    try {
      fs.lstatSync(target);
      fs.unlinkSync(target);
      console.log(`  ✓ Removed ${target}`);
    } catch { /* not present */ }
  }

  // --- Clean up project-local artifacts in registered projects. ---
  try {
    const { listGroves, listRegisteredProjects } = await import('../grove/registry.js');
    for (const grove of listGroves(mycoHome)) {
      for (const project of listRegisteredProjects(grove.id, mycoHome)) {
        await cleanProjectLocalArtifacts(project.root, pkgRoot);
      }
    }
  } catch (err) {
    console.error(`  ⚠ Per-project cleanup skipped: ${(err as Error).message}`);
  }

  // --- Purge (--purge) ---
  if (purge) {
    let purgeOk = true;
    try {
      fs.rmSync(mycoHome, { recursive: true, force: true });
      console.log(`  ✓ Purged ${mycoHome}`);
    } catch (err) {
      console.error(`  ✗ Failed to purge ${mycoHome}: ${(err as Error).message}`);
      purgeOk = false;
    }
    if (!(await removeManagedInstallDir(mycoHome))) purgeOk = false;
    // A failed purge must not report success — automation reads the exit code.
    if (!purgeOk) process.exitCode = 1;
  } else {
    console.log(`  – Preserved Grove DB + captured data at ${mycoHome} (use --purge to delete)`);
  }

  console.log('\nMyco global install removed.');
}

/**
 * Remove the managed binary's install dir when it lives OUTSIDE the purged home
 * (win32: `%LOCALAPPDATA%\Myco`; on POSIX the bin dir is `<home>/bin`, already
 * gone with the home — detected by path, not by platform name). A process can't
 * delete its own running executable, so when the dir holds the running binary
 * the deletion is finished by a detached temp-copy — the same mechanism the
 * updater uses to mutate a running binary. Returns false only on an unexpected
 * failure, not when the detached finisher was scheduled.
 */
async function removeManagedInstallDir(mycoHome: string): Promise<boolean> {
  const { managedBinDir } = await import('../install/managed-binary.js');
  const binDir = managedBinDir(mycoHome, process.platform, process.env.LOCALAPPDATA);
  const rel = path.relative(mycoHome, binDir);
  const underHome = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (underHome) return true; // removed with the home purge above

  const installRoot = path.dirname(binDir);
  if (!fs.existsSync(installRoot)) return true;
  try {
    fs.rmSync(installRoot, { recursive: true, force: true });
    console.log(`  ✓ Removed ${installRoot}`);
    return true;
  } catch {
    // The running binary locks its own image — finish after this process exits.
    try {
      const { resolveOrchestratorBinary } = await import('../upgrade/spawn.js');
      const { spawnDetached } = await import('../upgrade/orchestrator.js');
      spawnDetached(resolveOrchestratorBinary(), ['__finish-uninstall', installRoot]);
      console.log(`  ✓ Scheduled removal of ${installRoot} after exit`);
      return true;
    } catch (err) {
      console.error(`  ✗ Failed to remove ${installRoot}: ${(err as Error).message}`);
      return false;
    }
  }
}

async function cleanProjectLocalArtifacts(projectRoot: string, pkgRoot: string): Promise<void> {
  if (!fs.existsSync(projectRoot)) return;
  for (const manifest of loadManifests()) {
    try {
      const installer = new SymbiontInstaller(manifest, projectRoot, pkgRoot);
      const removed = uninstallLabels(installer.uninstall());
      if (removed.length > 0) {
        console.log(`    ✓ ${path.basename(projectRoot)}: cleared ${manifest.displayName}`);
      }
    } catch { /* per-symbiont failures non-fatal */ }
  }
  // `myco remove` is the full project-local teardown — strip every
  // launcher artifact including the dev pin.
  removeProjectLaunchers(projectRoot, { legacy: true, active: true, runtimeCommand: true });
}

async function runProjectRemove(parsed: ParsedFlags): Promise<void> {
  const projectArg = parsed.value('--project');
  const explicitRoot = projectArg ? path.resolve(projectArg) : null;
  const vaultDir = explicitRoot ? path.join(explicitRoot, '.myco') : resolveVaultDir();
  const projectRoot = explicitRoot ?? resolveProjectRoot(vaultDir);
  const hasConfig = fs.existsSync(path.join(vaultDir, 'myco.yaml'));
  const symbiontName = parsed.value('--symbiont');
  const assumeYes = parsed.has('--yes');
  const removeVault = parsed.has('--remove-vault') || parsed.has('--purge');

  // Safety gate BEFORE any cleanup. Project-scope uninstall resolves
  // config dirs relative to the root, so `--project ~` would strip the
  // user's GLOBAL agent configs (~/.claude, ~/.cursor, …) and
  // `--remove-vault` would rmSync ~/.myco itself. Same guard class as
  // the hook hot path: reject /, $HOME, and home-shaped directories.
  try {
    assertSafeProjectRoot(projectRoot);
  } catch (err) {
    if (err instanceof UnsafeProjectRootError) {
      console.error(`Refusing project-scope removal at ${err.projectRoot}: ${err.reason}.`);
      console.error('Pass the project repository root via --project <path>.');
      process.exit(1);
    }
    throw err;
  }

  if (symbiontName) {
    if (!hasConfig) {
      console.error(`No myco.yaml found in ${vaultDir}. Nothing to remove.`);
      process.exit(1);
    }
    const allManifests = loadManifests();
    const manifest = allManifests.find((m) => m.name === symbiontName);
    if (!manifest) {
      console.error(`Unknown symbiont: ${symbiontName}. Available: ${allManifests.map((m) => m.name).join(', ')}`);
      process.exit(1);
    }

    const pkgRoot = resolvePackageRoot();
    const installer = new SymbiontInstaller(manifest, projectRoot, pkgRoot);
    const removed = uninstallLabels(installer.uninstall());

    if (removed.length > 0) {
      console.log(`  ✓ Removed ${manifest.displayName}: ${removed.join(', ')}`);
    } else {
      console.log(`  – ${manifest.displayName}: nothing to remove`);
    }

    try {
      updateConfig(vaultDir, (c) => {
        if (!c.symbionts?.[symbiontName]) return c;
        const { [symbiontName]: _, ...rest } = c.symbionts;
        return { ...c, symbionts: Object.keys(rest).length > 0 ? rest : undefined };
      });
      console.log(`  ✓ Removed ${symbiontName} from myco.yaml`);
    } catch (err) {
      if (!(err instanceof TierConfigUnreadableError)) throw err;
      // Teardown proceeds: an unparseable myco.yaml has no reachable
      // symbionts block to clean, and remove must not clobber a file the
      // user may still want to repair.
      console.log(`  !! Skipped myco.yaml cleanup — file is unparseable (${err.filePath})`);
    }
    return;
  }

  const allManifests = loadManifests();
  const pkgRoot = resolvePackageRoot();

  // Confirm the vault deletion UP FRONT — before any teardown — so a
  // decline leaves the project fully intact instead of half-removed
  // (hooks stripped, daemon stopped, vault still present).
  if (removeVault && !assumeYes && fs.existsSync(vaultDir)) {
    const confirmed = await confirmDestructive(
      `This removes Myco's project-local install from ${projectRoot} and permanently deletes the vault at ${vaultDir} (captured sessions, spores, and project config).`,
    );
    if (!confirmed) {
      console.error('Aborted — nothing was removed. Re-run with --yes to skip confirmation.');
      process.exitCode = 1;
      return;
    }
  }

  // Orphan remedy: launcher artifacts without a myco.yaml — the state
  // `myco doctor` reports as "orphan project-local launcher stubs" and
  // routes here. There is no config or daemon to act on, but the
  // launcher/per-symbiont artifact cleanup still applies.
  if (!hasConfig) {
    console.log(`No myco.yaml in ${vaultDir} — cleaning orphan launcher artifacts in ${projectRoot}\n`);
    await cleanProjectLocalArtifacts(projectRoot, pkgRoot);
    if (removeVault && fs.existsSync(vaultDir)) {
      fs.rmSync(vaultDir, { recursive: true, force: true });
      console.log(`  ✓ Removed vault at ${vaultDir}`);
    }
    console.log('\nOrphan project-local artifacts cleaned.');
    return;
  }

  console.log(`Removing Myco project-local install from ${projectRoot}\n`);

  const daemonPath = path.join(vaultDir, 'daemon.json');
  let daemon: { pid?: unknown } | null = null;
  try {
    daemon = JSON.parse(fs.readFileSync(daemonPath, 'utf-8')) as { pid?: unknown };
  } catch { /* no readable daemon state */ }
  if (typeof daemon?.pid === 'number' && isProcessAlive(daemon.pid)) {
    await terminateDaemonProcess(daemon.pid, 'SIGTERM');
    console.log(`  ✓ Stopped daemon (pid ${daemon.pid})`);
  }
  try {
    fs.unlinkSync(daemonPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const configured = allManifests.filter((m) =>
    fs.existsSync(path.join(projectRoot, m.configDir)),
  );

  for (const manifest of configured) {
    try {
      const installer = new SymbiontInstaller(manifest, projectRoot, pkgRoot);
      const removed = uninstallLabels(installer.uninstall());

      if (removed.length > 0) {
        console.log(`  ✓ Removed from ${manifest.displayName}: ${removed.join(', ')}`);
      }
    } catch (err) {
      console.error(`  ✗ Failed to clean ${manifest.displayName}: ${(err as Error).message}`);
    }
  }

  const mcpJsonPath = path.join(projectRoot, '.mcp.json');
  try {
    const config = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
      fs.unlinkSync(mcpJsonPath);
      console.log('  ✓ Removed empty .mcp.json');
    }
  } catch { /* doesn't exist or already clean */ }

  if (removeVault) {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    console.log(`  ✓ Removed vault at ${vaultDir}`);
  } else {
    console.log(`  – Vault preserved at ${vaultDir} (use --remove-vault to delete)`);
  }

  console.log('\nMyco project-local install removed.');
}
