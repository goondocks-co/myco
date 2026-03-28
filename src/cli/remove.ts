import { resolveVaultDir } from '../vault/resolve.js';
import { isProcessAlive } from './shared.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { SymbiontInstaller } from '../symbionts/installer.js';
import fs from 'node:fs';
import path from 'node:path';

export async function run(args: string[]): Promise<void> {
  const vaultDir = resolveVaultDir();
  if (!fs.existsSync(path.join(vaultDir, 'myco.yaml'))) {
    console.error(`No myco.yaml found in ${vaultDir}. Nothing to remove.`);
    process.exit(1);
  }

  const projectRoot = path.dirname(vaultDir);
  const allManifests = loadManifests();
  const pkgRoot = resolvePackageRoot();
  const removeVault = args.includes('--remove-vault');

  console.log(`Removing Myco from ${projectRoot}\n`);

  // --- Stop daemon ---

  const daemonPath = path.join(vaultDir, 'daemon.json');
  try {
    const daemon = JSON.parse(fs.readFileSync(daemonPath, 'utf-8'));
    if (isProcessAlive(daemon.pid)) {
      process.kill(daemon.pid, 'SIGTERM');
      console.log(`  \u2713 Stopped daemon (pid ${daemon.pid})`);
    }
    fs.unlinkSync(daemonPath);
  } catch { /* no daemon running */ }

  // --- Unregister from all configured agents ---

  const configured = allManifests.filter((m) =>
    fs.existsSync(path.join(projectRoot, m.configDir)),
  );

  for (const manifest of configured) {
    try {
      const installer = new SymbiontInstaller(manifest, projectRoot, pkgRoot);
      const result = installer.uninstall();

      const removed = [
        result.hooks && 'hooks',
        result.mcp && 'MCP server',
        result.skills && 'skills',
        result.settings && 'settings',
        result.instructions && 'instructions',
      ].filter(Boolean);

      if (removed.length > 0) {
        console.log(`  \u2713 Removed from ${manifest.displayName}: ${removed.join(', ')}`);
      }
    } catch (err) {
      console.error(`  \u2717 Failed to clean ${manifest.displayName}: ${(err as Error).message}`);
    }
  }

  // --- Remove .mcp.json if it's now empty ---

  const mcpJsonPath = path.join(projectRoot, '.mcp.json');
  try {
    const config = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
      fs.unlinkSync(mcpJsonPath);
      console.log('  \u2713 Removed empty .mcp.json');
    }
  } catch { /* doesn't exist or already clean */ }

  // --- Remove vault (unless --keep-vault) ---

  if (removeVault) {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    console.log(`  \u2713 Removed vault at ${vaultDir}`);
  } else {
    console.log(`  \u2013 Vault preserved at ${vaultDir} (use --remove-vault to delete)`);
  }

  console.log('\nMyco has been removed from this project.');
}
