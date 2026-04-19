import { resolveVaultDir } from '../vault/resolve.js';
import { VAULT_GITIGNORE, registerSymbionts } from './shared.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { loadConfig, getEnabledSymbiontNames } from '../config/loader.js';
import { getPluginVersion } from '../version.js';
import { UPDATE_STAMP_FILENAME } from '../constants/update.js';
import { connectToDaemon } from './shared.js';
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';

const VECTOR_METADATA_REBUILD_VERSION = '0.21.1';

function shouldTriggerEmbeddingRebuild(previousVersion: string | null, currentVersion: string): boolean {
  if (!semver.valid(currentVersion) || semver.lt(currentVersion, VECTOR_METADATA_REBUILD_VERSION)) {
    return false;
  }
  if (!previousVersion || !semver.valid(previousVersion)) {
    return true;
  }
  return semver.lt(previousVersion, VECTOR_METADATA_REBUILD_VERSION);
}

// `myco update` is also the migration path for refreshing managed AGENTS.md content.

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
  const previousVersion = fs.existsSync(stampPath)
    ? fs.readFileSync(stampPath, 'utf-8').trim() || null
    : null;
  const currentVersion = getPluginVersion();
  const needsEmbeddingRebuild = shouldTriggerEmbeddingRebuild(previousVersion, currentVersion);

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

  const resolvedProjectRoot = projectRoot ?? path.dirname(vaultDir);
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

  let rebuildTriggeredSuccessfully = !needsEmbeddingRebuild;
  if (needsEmbeddingRebuild) {
    try {
      const client = await connectToDaemon(vaultDir);
      const response = await client.post('/embedding/rebuild', {});
      if (response.ok) {
        const data = response.data as { embedded?: number; remaining_queue_depth?: number } | undefined;
        console.log(`  ✓ Triggered embedding rebuild for vector metadata refresh${data ? ` (${data.embedded ?? 0} embedded now, ${data.remaining_queue_depth ?? 0} remaining)` : ''}`);
        updatedCount++;
        rebuildTriggeredSuccessfully = true;
      } else {
        console.log('  !! Failed to trigger embedding rebuild after update');
      }
    } catch (error) {
      console.log(`  !! Failed to trigger embedding rebuild after update: ${(error as Error).message}`);
    }
  }

  // --- Write version stamp ---
  if (rebuildTriggeredSuccessfully) {
    try {
      fs.writeFileSync(stampPath, currentVersion, 'utf-8');
    } catch {
      // Non-fatal — stamp write failure shouldn't break the update
    }
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
