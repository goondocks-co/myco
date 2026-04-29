import { resolveVaultDir, resolveProjectRoot } from '../vault/resolve.js';
import { VAULT_GITIGNORE, registerSymbionts } from './shared.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { loadConfig, getEnabledSymbiontNames } from '../config/loader.js';
import { getPluginVersion } from '../version.js';
import { UPDATE_STAMP_FILENAME } from '../constants/update.js';
import fs from 'node:fs';
import path from 'node:path';

// `myco update` regenerates managed config — .gitignore, symbiont hooks,
// MCP entries, skills, settings. It does NOT trigger data migrations:
// runtime migrations (vector reindex, etc.) are owned by the daemon and
// gated by the `migration_tasks` ledger so they run exactly once per
// vault regardless of update invocations.

export async function run(args: string[]): Promise<void> {
  let projectRoot: string | undefined;
  const projectIdx = args.indexOf('--project');
  if (projectIdx !== -1 && args[projectIdx + 1]) {
    projectRoot = args[projectIdx + 1];
  }

  const vaultDir = projectRoot
    ? path.join(projectRoot, '.myco')
    : resolveVaultDir();
  if (!fs.existsSync(path.join(vaultDir, 'myco.yaml'))) {
    console.error(`No myco.yaml found in ${vaultDir}. Run 'myco init' first.`);
    process.exit(1);
  }

  console.log(`Updating Myco vault at ${vaultDir}\n`);

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

  const resolvedProjectRoot = projectRoot ?? resolveProjectRoot(vaultDir);
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

  // --- Summary ---

  console.log('');
  if (updatedCount > 0) {
    console.log(`Updated ${updatedCount} item${updatedCount > 1 ? 's' : ''}.`);
  } else {
    console.log('Everything is up to date.');
  }
  console.log('Run `myco doctor` to verify setup health.');
}
