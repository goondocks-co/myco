import { resolveVaultDir, resolveProjectRoot } from '../vault/resolve.js';
import { isProcessAlive, parseStringFlag } from './shared.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { SymbiontInstaller, removeProjectLaunchers } from '../symbionts/installer.js';
import { resolveMycoHome } from '../grove/paths.js';
import { updateConfig } from '../config/loader.js';
import type { SymbiontManifest } from '../symbionts/manifest-schema.js';
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

Options:
  --project [<path>]     Remove Myco's project-local install (legacy path)
  --symbiont <name>      Remove just one symbiont's project-local install
  --purge                Also delete ~/.myco/ (Grove DB + captured data)
  --remove-vault         Project-scope only: delete the project's .myco/ dir
  -h, --help             Show this help
`;

export async function run(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  if (args.includes('--symbiont') || args.includes('--project')) {
    return await runProjectRemove(args);
  }

  return await runGlobalRemove(args.includes('--purge'));
}

async function runGlobalRemove(purge: boolean): Promise<void> {
  const mycoHome = resolveMycoHome();
  console.log(`Removing Myco global install (${mycoHome})\n`);

  // --- Unregister the OS service (do this first so launchd/systemd
  //     doesn't relaunch the daemon mid-uninstall). ---
  try {
    const { getServiceManager } = await import('../service/manager.js');
    const { detectInstallVariant } = await import('./service.js');
    const { serviceLabel } = await import('../service/labels.js');
    const mgr = getServiceManager();
    if (mgr.supported) {
      await mgr.uninstall(serviceLabel(detectInstallVariant()));
      console.log('  ✓ Unregistered OS service');
    }
  } catch (err) {
    console.log(`  ⚠ Service uninstall skipped: ${(err as Error).message}`);
  }

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
  for (const filename of ['launcher.cjs', 'mcp-launcher.cjs']) {
    const target = path.join(mycoHome, filename);
    try {
      fs.lstatSync(target);
      fs.unlinkSync(target);
      console.log(`  ✓ Removed ${target}`);
    } catch { /* not present */ }
  }

  // --- Clean up project-local artifacts in registered projects whose
  //     Grove this binary owns. Scoping to the binary's daemon variant
  //     prevents `myco-dev remove` from touching prod-served projects;
  //     each binary cleans up its own side. ---
  try {
    const { currentDaemonVariant } = await import('../grove/paths.js');
    const { listGroves, listRegisteredProjects } = await import('../grove/registry.js');
    for (const grove of listGroves(mycoHome, { servedBy: currentDaemonVariant() })) {
      for (const project of listRegisteredProjects(grove.id, mycoHome)) {
        await cleanProjectLocalArtifacts(project.root, pkgRoot);
      }
    }
  } catch (err) {
    console.error(`  ⚠ Per-project cleanup skipped: ${(err as Error).message}`);
  }

  // --- Purge (--purge) ---
  if (purge) {
    try {
      fs.rmSync(mycoHome, { recursive: true, force: true });
      console.log(`  ✓ Purged ${mycoHome}`);
    } catch (err) {
      console.error(`  ✗ Failed to purge ${mycoHome}: ${(err as Error).message}`);
    }
  } else {
    console.log(`  – Preserved Grove DB + captured data at ${mycoHome} (use --purge to delete)`);
  }

  console.log('\nMyco global install removed.');
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

async function runProjectRemove(args: string[]): Promise<void> {
  const vaultDir = resolveVaultDir();
  if (!fs.existsSync(path.join(vaultDir, 'myco.yaml'))) {
    console.error(`No myco.yaml found in ${vaultDir}. Nothing to remove.`);
    process.exit(1);
  }

  const symbiontName = parseStringFlag(args, '--symbiont');

  if (symbiontName) {
    const allManifests = loadManifests();
    const manifest = allManifests.find((m) => m.name === symbiontName);
    if (!manifest) {
      console.error(`Unknown symbiont: ${symbiontName}. Available: ${allManifests.map((m) => m.name).join(', ')}`);
      process.exit(1);
    }

    const projectRoot = resolveProjectRoot(vaultDir);
    const pkgRoot = resolvePackageRoot();
    const installer = new SymbiontInstaller(manifest, projectRoot, pkgRoot);
    const removed = uninstallLabels(installer.uninstall());

    if (removed.length > 0) {
      console.log(`  ✓ Removed ${manifest.displayName}: ${removed.join(', ')}`);
    } else {
      console.log(`  – ${manifest.displayName}: nothing to remove`);
    }

    updateConfig(vaultDir, (c) => {
      if (!c.symbionts?.[symbiontName]) return c;
      const { [symbiontName]: _, ...rest } = c.symbionts;
      return { ...c, symbionts: Object.keys(rest).length > 0 ? rest : undefined };
    });
    console.log(`  ✓ Removed ${symbiontName} from myco.yaml`);
    return;
  }

  const projectRoot = resolveProjectRoot(vaultDir);
  const allManifests = loadManifests();
  const pkgRoot = resolvePackageRoot();
  const removeVault = args.includes('--remove-vault') || args.includes('--purge');

  console.log(`Removing Myco project-local install from ${projectRoot}\n`);

  const daemonPath = path.join(vaultDir, 'daemon.json');
  try {
    const daemon = JSON.parse(fs.readFileSync(daemonPath, 'utf-8'));
    if (isProcessAlive(daemon.pid)) {
      process.kill(daemon.pid, 'SIGTERM');
      console.log(`  ✓ Stopped daemon (pid ${daemon.pid})`);
    }
    fs.unlinkSync(daemonPath);
  } catch { /* no daemon running */ }

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
    console.log(`  – Vault preserved at ${vaultDir} (use --purge to delete)`);
  }

  console.log('\nMyco project-local install removed.');
}
