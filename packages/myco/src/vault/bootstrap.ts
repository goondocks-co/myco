import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { parse, type TomlTableWithoutBigInt } from 'smol-toml';
import { isPlainTable } from '@myco/utils/is-plain-table.js';
import { resolveVaultDir } from './resolve.js';
import {
  resolveGroveRegistryPath,
  resolveGroveProjectsPath,
  resolveMycoHome,
  PROJECT_MANIFEST_FILENAME,
} from '../grove/paths.js';

/**
 * Resolve the bootstrap vault directory for daemon startup.
 *
 * Priority:
 *  1. The cwd-walking `resolveVaultDir()` result, IF its parent contains a
 *     `project.toml`. This preserves existing behavior for daemons spawned
 *     from a project directory (lazy spawn via `ensureRunning`).
 *  2. The first registered project in the default Grove's projects.toml,
 *     read from `~/.myco/groves/<default_grove_id>/registry/projects.toml`.
 *     This is the path taken when the daemon is started by launchd/systemd
 *     from `cwd=~/.myco` with no enclosing project.
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

  throw new Error(
    `Daemon bootstrap failed: no enclosing project at ${cwdVault}, and no projects registered in the default Grove. `
    + `Run \`myco init\` from a project directory first.`,
  );
}

function hasProjectManifest(vaultDir: string): boolean {
  return fs.existsSync(path.join(vaultDir, PROJECT_MANIFEST_FILENAME));
}

function firstProjectVaultFromRegistry(): string | null {
  try {
    const mycoHome = resolveMycoHome();
    const registryPath = resolveGroveRegistryPath(mycoHome);
    if (!fs.existsSync(registryPath)) return null;

    const registry = YAML.parse(fs.readFileSync(registryPath, 'utf-8')) as { default_grove_id?: string } | null;
    const defaultGroveId = registry?.default_grove_id;
    if (!defaultGroveId || typeof defaultGroveId !== 'string') return null;

    const projectsPath = resolveGroveProjectsPath(defaultGroveId, mycoHome);
    if (!fs.existsSync(projectsPath)) return null;

    const doc = parse(fs.readFileSync(projectsPath, 'utf-8')) as TomlTableWithoutBigInt;
    const projects = isPlainTable(doc.projects) ? doc.projects as Record<string, unknown> : {};

    for (const value of Object.values(projects)) {
      if (!isPlainTable(value)) continue;
      const row = value as Record<string, unknown>;
      const root = row.root;
      if (!root || typeof root !== 'string') continue;
      if (!fs.existsSync(root)) continue;
      const vault = path.join(root, '.myco');
      if (hasProjectManifest(vault)) return vault;
    }
    return null;
  } catch {
    return null;
  }
}
