import fs from 'node:fs';
import path from 'node:path';
import { getEnabledSymbiontNames, loadConfig } from '../config/loader.js';
import type { MycoConfig } from '../config/schema.js';
import { loadManifests, resolvePackageRoot } from './detect.js';
import { SymbiontInstaller } from './installer.js';

export function getConfiguredManifests(projectRoot: string, config: MycoConfig) {
  const allManifests = loadManifests();
  const enabledNames = getEnabledSymbiontNames(config);
  if (enabledNames) {
    return allManifests.filter((manifest) => enabledNames.has(manifest.name));
  }

  return allManifests.filter((manifest) => fs.existsSync(path.join(projectRoot, manifest.configDir)));
}

export function reconcileConfiguredSymbionts(projectRoot: string, vaultDir = path.join(projectRoot, '.myco')): number {
  const config = loadConfig(vaultDir);
  const manifests = getConfiguredManifests(projectRoot, config);
  const packageRoot = resolvePackageRoot();
  let updatedCount = 0;

  for (const manifest of manifests) {
    const installer = new SymbiontInstaller(manifest, projectRoot, packageRoot);
    installer.install();
    updatedCount++;
  }

  return updatedCount;
}
