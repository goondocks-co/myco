import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { parse as parseTOML } from 'smol-toml';
import { isPlainTable } from '@myco/utils/is-plain-table.js';
import { resolveVaultDir } from './resolve.js';
import {
  resolveGrovesDir,
  resolveGroveRegistryPath,
  resolveGroveProjectsPath,
  resolveGroveMetadataPath,
  resolveMycoHome,
  PROJECT_MANIFEST_FILENAME,
  SERVICE_DIRNAME,
  SERVICE_DEV_DIRNAME,
} from '../grove/paths.js';

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

type ServiceDirName = typeof SERVICE_DIRNAME | typeof SERVICE_DEV_DIRNAME;

function expectedServiceDirForVariant(): ServiceDirName {
  const variant = process.env.MYCO_SERVICE_VARIANT?.trim();
  return variant === 'dev' ? SERVICE_DEV_DIRNAME : SERVICE_DIRNAME;
}

function readGroveServedBy(groveId: string, mycoHome: string): ServiceDirName | null {
  try {
    const tomlPath = resolveGroveMetadataPath(groveId, mycoHome);
    if (!fs.existsSync(tomlPath)) return null;
    const parsed = parseTOML(fs.readFileSync(tomlPath, 'utf-8'));
    const grove = isPlainTable(parsed) && isPlainTable(parsed.grove) ? parsed.grove : null;
    const value = grove && typeof grove.served_by === 'string' ? grove.served_by : null;
    if (value === SERVICE_DIRNAME || value === SERVICE_DEV_DIRNAME) return value as ServiceDirName;
    return null;
  } catch {
    return null;
  }
}

function listGroveIds(mycoHome: string): string[] {
  try {
    const groves = resolveGrovesDir(mycoHome);
    if (!fs.existsSync(groves)) return [];
    return fs.readdirSync(groves).filter((name) => name.startsWith('grove_'));
  } catch {
    return [];
  }
}

function firstProjectVaultFromGrove(groveId: string, mycoHome: string): string | null {
  try {
    const projectsPath = resolveGroveProjectsPath(groveId, mycoHome);
    if (!fs.existsSync(projectsPath)) return null;
    const parsed = parseTOML(fs.readFileSync(projectsPath, 'utf-8'));
    const projects = isPlainTable(parsed) && isPlainTable(parsed.projects) ? parsed.projects : null;
    if (!projects) return null;
    for (const entry of Object.values(projects)) {
      if (!isPlainTable(entry)) continue;
      const root = typeof entry.root === 'string' ? entry.root : null;
      if (!root || !fs.existsSync(root)) continue;
      const vault = path.join(root, '.myco');
      if (hasProjectManifest(vault)) return vault;
    }
    return null;
  } catch {
    return null;
  }
}

function defaultGroveId(mycoHome: string): string | null {
  try {
    const registryPath = resolveGroveRegistryPath(mycoHome);
    if (!fs.existsSync(registryPath)) return null;
    const parsed = YAML.parse(fs.readFileSync(registryPath, 'utf-8')) as { default_grove_id?: string } | null;
    return parsed?.default_grove_id ?? null;
  } catch {
    return null;
  }
}

function firstProjectVaultFromRegistry(): string | null {
  const mycoHome = resolveMycoHome();
  const expectedServiceDir = expectedServiceDirForVariant();

  // For dev variant, find any Grove whose grove.toml says served_by = "service-dev".
  if (expectedServiceDir === SERVICE_DEV_DIRNAME) {
    for (const groveId of listGroveIds(mycoHome)) {
      if (readGroveServedBy(groveId, mycoHome) !== SERVICE_DEV_DIRNAME) continue;
      const vault = firstProjectVaultFromGrove(groveId, mycoHome);
      if (vault) return vault;
    }
    return null;
  }

  // Prod variant (or unset): prefer the default Grove. If it has no projects,
  // fall through to scanning any service-served Grove.
  const defaultId = defaultGroveId(mycoHome);
  if (defaultId) {
    const fromDefault = firstProjectVaultFromGrove(defaultId, mycoHome);
    if (fromDefault) return fromDefault;
  }
  for (const groveId of listGroveIds(mycoHome)) {
    if (readGroveServedBy(groveId, mycoHome) !== SERVICE_DIRNAME) continue;
    const vault = firstProjectVaultFromGrove(groveId, mycoHome);
    if (vault) return vault;
  }
  return null;
}
