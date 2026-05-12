import fs from 'node:fs';
import path from 'node:path';
import { resolveVaultDir } from './resolve.js';
import {
  resolveMycoHome,
  PROJECT_MANIFEST_FILENAME,
  SERVICE_DIRNAME,
  SERVICE_DEV_DIRNAME,
} from '../grove/paths.js';
import { listGroves, getDefaultGroveId, listRegisteredProjects } from '../grove/registry.js';
import { serviceVariantToDirName } from '../service/labels.js';

/**
 * Resolve the bootstrap vault directory for daemon startup.
 *
 * Priority:
 *  1. The cwd-walking `resolveVaultDir()` result, IF its parent contains a
 *     `project.toml`. This preserves existing behavior for daemons spawned
 *     from a project directory (lazy spawn via `ensureRunning`).
 *  2. The first registered project in a Grove matching the current service
 *     variant (`MYCO_SERVICE_VARIANT` env var). Dev variant scans for a
 *     Grove with `served_by = "service-dev"`; prod variant (or unset) uses
 *     the default Grove from the registry.
 *
 * Throws if neither path yields a vault dir (no enclosing project AND no
 * Grove with at least one registered project). The error message instructs
 * the user to run `myco init` from a project directory.
 */
export function resolveBootstrapVaultDir(cwd: string = process.cwd()): string {
  const cwdVault = resolveVaultDir(cwd);
  if (hasProjectManifest(cwdVault)) return cwdVault;

  const fromRegistry = firstProjectVaultFromRegistry();
  if (fromRegistry) return fromRegistry;

  const variant = process.env.MYCO_SERVICE_VARIANT?.trim() || 'prod';
  throw new Error(
    `Daemon bootstrap failed: no enclosing project at ${cwdVault}, and no projects registered in a Grove served_by="${variant === 'dev' ? SERVICE_DEV_DIRNAME : SERVICE_DIRNAME}". `
    + `Run \`myco init\` from a project directory first.`,
  );
}

function hasProjectManifest(vaultDir: string): boolean {
  return fs.existsSync(path.join(vaultDir, PROJECT_MANIFEST_FILENAME));
}

function firstProjectVaultFromRegistry(): string | null {
  const mycoHome = resolveMycoHome();
  const variant = process.env.MYCO_SERVICE_VARIANT?.trim();
  const targetServedBy = serviceVariantToDirName(variant === 'dev' ? 'dev' : 'prod');

  if (targetServedBy === SERVICE_DEV_DIRNAME) {
    // Dev variant: find any Grove whose grove.toml says served_by = "service-dev".
    for (const grove of listGroves(mycoHome, { servedBy: 'service-dev' })) {
      const vault = firstVaultFromGrove(grove.id, mycoHome);
      if (vault) return vault;
    }
    return null;
  }

  // Prod variant (or unset): prefer the default Grove (even if it has no
  // grove.toml — the old behavior allowed this). Then fall through to any
  // Grove with served_by = "service".
  const defaultId = getDefaultGroveId(mycoHome);
  if (defaultId) {
    const vault = firstVaultFromGrove(defaultId, mycoHome);
    if (vault) return vault;
  }
  for (const grove of listGroves(mycoHome, { servedBy: 'service' })) {
    if (grove.id === defaultId) continue; // already tried above
    const vault = firstVaultFromGrove(grove.id, mycoHome);
    if (vault) return vault;
  }
  return null;
}

function firstVaultFromGrove(groveId: string, mycoHome: string): string | null {
  for (const project of listRegisteredProjects(groveId, mycoHome)) {
    if (!project.root || !fs.existsSync(project.root)) continue;
    const vault = path.join(project.root, '.myco');
    if (hasProjectManifest(vault)) return vault;
  }
  return null;
}
