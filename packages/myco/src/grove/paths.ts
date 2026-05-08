import os from 'node:os';
import path from 'node:path';

import {
  MACHINE_RUNTIME_COMMAND_FILENAME,
  MACHINE_RUNTIME_DIRNAME,
  MACHINE_RUNTIME_TMP_DIRNAME,
} from '../constants/update.js';

export const MYCO_HOME_ENV = 'MYCO_HOME';
export const GROVES_DIRNAME = 'groves';
export const SERVICE_DIRNAME = 'service';
export const GROVE_METADATA_FILENAME = 'grove.toml';
export const GROVE_CONFIG_FILENAME = 'grove.yaml';
export const GROVE_DB_FILENAME = 'myco.db';
export const GROVE_VECTORS_FILENAME = 'vectors.db';
export const GROVE_REGISTRY_DIRNAME = 'registry';
export const GROVE_PROJECTS_FILENAME = 'projects.toml';
export const GROVE_ROOTS_FILENAME = 'roots.toml';
export const GLOBAL_CONFIG_FILENAME = 'config.yaml';
export const GROVE_REGISTRY_FILENAME = 'registry.yaml';
export const PROJECT_MANIFEST_FILENAME = 'project.toml';
export const DAEMON_STATE_FILENAME = 'daemon.json';

export interface MycoHomeOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function resolveMycoHome(options: MycoHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = env[MYCO_HOME_ENV]?.trim();
  if (configured) return path.resolve(expandHome(configured, options.homeDir));
  return path.join(options.homeDir ?? os.homedir(), '.myco');
}

export function resolveGlobalConfigPath(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, GLOBAL_CONFIG_FILENAME);
}

export function resolveServiceDir(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, SERVICE_DIRNAME);
}

export function resolveServiceDaemonStatePath(mycoHome = resolveMycoHome()): string {
  return path.join(resolveServiceDir(mycoHome), DAEMON_STATE_FILENAME);
}

export function resolveGrovesDir(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, GROVES_DIRNAME);
}

/**
 * `~/.myco/groves/registry.yaml` — owns the cross-Grove pointer
 * (`default_grove_id`). Lives next to `groves/<id>/` so the registry
 * stays close to its data; the machine-tier `config.yaml` no longer
 * carries a `grove:` block.
 */
export function resolveGroveRegistryPath(mycoHome = resolveMycoHome()): string {
  return path.join(resolveGrovesDir(mycoHome), GROVE_REGISTRY_FILENAME);
}

export function resolveGroveDir(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGrovesDir(mycoHome), groveId);
}

export function resolveGroveMetadataPath(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveDir(groveId, mycoHome), GROVE_METADATA_FILENAME);
}

export function resolveGroveConfigPath(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveDir(groveId, mycoHome), GROVE_CONFIG_FILENAME);
}

export function resolveGroveDbPath(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveDir(groveId, mycoHome), GROVE_DB_FILENAME);
}

export function resolveGroveVectorsPath(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveDir(groveId, mycoHome), GROVE_VECTORS_FILENAME);
}

export function resolveGroveRegistryDir(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveDir(groveId, mycoHome), GROVE_REGISTRY_DIRNAME);
}

export function resolveGroveProjectsPath(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveRegistryDir(groveId, mycoHome), GROVE_PROJECTS_FILENAME);
}

export function resolveGroveRootsPath(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveRegistryDir(groveId, mycoHome), GROVE_ROOTS_FILENAME);
}

export function resolveProjectVaultDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.myco');
}

export function resolveProjectManifestPath(projectVaultDir: string): string {
  return path.join(projectVaultDir, PROJECT_MANIFEST_FILENAME);
}

/**
 * `~/.myco/runtime.command` — single source of truth for which `myco`
 * binary the launcher (`myco-run.cjs`, `myco-cli.cjs`, `bin/myco.cjs`)
 * should exec. Absent file means "use whatever PATH resolves `myco` to."
 *
 * Machine-scoped because the daemon itself is now machine-scoped: there
 * is exactly one daemon per machine, and the runtime that backs it is a
 * machine-level choice, not a per-project one.
 */
export function resolveMachineRuntimeCommandPath(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, MACHINE_RUNTIME_COMMAND_FILENAME);
}

/** `~/.myco/runtime/` — managed beta runtime install directory. */
export function resolveMachineRuntimeDir(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, MACHINE_RUNTIME_DIRNAME);
}

/** `~/.myco/runtime.tmp/` — staging dir for atomic runtime swap on update. */
export function resolveMachineRuntimeTmpDir(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, MACHINE_RUNTIME_TMP_DIRNAME);
}

function expandHome(value: string, homeDir = os.homedir()): string {
  if (value === '~') return homeDir;
  if (value.startsWith(`~${path.sep}`)) return path.join(homeDir, value.slice(2));
  return value;
}
