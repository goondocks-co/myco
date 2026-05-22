import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MACHINE_RUNTIME_COMMAND_FILENAME,
  MACHINE_RUNTIME_DIRNAME,
  MACHINE_RUNTIME_TMP_DIRNAME,
} from '../constants/update.js';
import { assertGroveEraId } from './ids.js';
import type { DaemonVariant } from './registry.js';

/**
 * True when two filesystem paths point at the same file or directory —
 * across symlink chains AND across case-insensitive filesystems
 * (macOS APFS, Windows NTFS) where `path.resolve` alone returns
 * different strings for the same on-disk file.
 *
 * Compares inode + device after `path.resolve`. Returns false when
 * either path doesn't exist (treat-as-different is what every caller
 * wants — a registered root that no longer exists is effectively a
 * different path).
 *
 * Use this anywhere two filesystem paths are compared for identity:
 * registry-root vs daemon-resolved-root, marker.project_root vs
 * expected.projectRoot, etc. Bare `path.resolve(a) === path.resolve(b)`
 * is a foot-gun on macOS.
 */
export function pathsEquivalent(a: string, b: string): boolean {
  const resolvedA = path.resolve(a);
  const resolvedB = path.resolve(b);
  if (resolvedA === resolvedB) return true;
  try {
    const statA = fs.statSync(resolvedA);
    const statB = fs.statSync(resolvedB);
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    return false;
  }
}

export const MYCO_HOME_ENV = 'MYCO_HOME';
export const GROVES_DIRNAME = 'groves';
export const SERVICE_DIRNAME = 'service';
export const SERVICE_DEV_DIRNAME = 'service-dev';
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
export const PROJECT_LOCAL_MANIFEST_FILENAME = 'project.local.toml';
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

/**
 * Resolve the root directory for project-scoped backups. Precedence:
 *   1. Explicit `override` argument.
 *   2. `MYCO_BACKUPS_DIR` environment variable.
 *   3. `~/myco_backups`.
 */
export function resolveBackupsRoot(override?: string): string {
  if (override && override.trim().length > 0) return path.resolve(override);
  const env = process.env.MYCO_BACKUPS_DIR?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), 'myco_backups');
}

export function resolveGlobalConfigPath(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, GLOBAL_CONFIG_FILENAME);
}

/**
 * Process-level switch routing the daemon to `service-dev/` instead of
 * `service/` so a contributor's dogfood daemon coexists with a production
 * daemon on the same machine (different paths → different derived ports).
 *
 * Slaved to `setDevBuildCliEntry` in `update-checker.ts` — tests reset by
 * calling that helper with `null`. The two flags MUST stay paired; setting
 * this directly is reserved for the pairing in `update-checker.ts`.
 */
let devServiceMode = false;

export function setDevServiceMode(value: boolean): void {
  devServiceMode = value;
}

export function isDevServiceMode(): boolean {
  return devServiceMode;
}

/**
 * The current daemon variant — `'service'` for a production install,
 * `'service-dev'` for a contributor's dogfood daemon. Source of truth
 * for "which Groves does this daemon own?" filters across walker, CLI
 * cleanup, reconciler, and API handlers. Every consumer that scopes
 * work to its own Groves MUST call this rather than re-deriving the
 * ternary in place — that's how a fresh walker last leaked across the
 * Grove-ownership boundary.
 */
export function currentDaemonVariant(): DaemonVariant {
  return devServiceMode ? SERVICE_DEV_DIRNAME : SERVICE_DIRNAME;
}

export function resolveServiceDirName(stateDir: string, mycoHome: string): DaemonVariant {
  const rel = path.relative(mycoHome, stateDir);
  if (rel === 'service') return 'service';
  if (rel === 'service-dev') return 'service-dev';
  throw new Error(`Unrecognized daemon service dir: ${stateDir} (mycoHome=${mycoHome})`);
}

export function resolveServiceDir(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, devServiceMode ? SERVICE_DEV_DIRNAME : SERVICE_DIRNAME);
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

/**
 * Structural Grove-id gate. Every path resolver below funnels through
 * this helper before joining `groveId` onto a `~/.myco/groves/...` path,
 * so a hostile (or buggy) caller cannot escape the Grove namespace via
 * `..` segments, absolute paths, or any value that fails the
 * `grove_<32 hex chars>` shape.
 *
 * The brand is enforced structurally (defense in depth): even if an
 * upstream caller drops its own validation, the resolver still refuses
 * malformed ids. Throws via `assertGroveEraId` on bad input.
 */
function assertGroveIdSafe(groveId: string): string {
  return assertGroveEraId(groveId, 'grove');
}

export function resolveGroveDir(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGrovesDir(mycoHome), assertGroveIdSafe(groveId));
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

/**
 * `~/.myco/groves/<groveId>/projects/<projectId>/` — the project-scoped
 * directory under its owning Grove. Hosts per-project artifacts that used to
 * live in `<projectRoot>/.myco/` (the capture buffer initially; archive
 * markers, per-project audit files later) so they ride with the Grove rather
 * than the project tree.
 *
 * Both `groveId` and `projectId` flow through their brand asserters before
 * being joined — Grove-id and project-id traversal attempts (`..`, absolute
 * paths) are rejected structurally, the same defense-in-depth as the other
 * Grove path resolvers.
 */
export function resolveGroveProjectDir(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): string {
  return path.join(
    resolveGroveDir(groveId, mycoHome),
    'projects',
    assertGroveEraId(projectId, 'project'),
  );
}

/**
 * `~/.myco/groves/<groveId>/projects/<projectId>/buffer/` — global home for
 * a project's capture buffer files. One buffer dir per project (the legacy
 * `<projectRoot>/.myco/buffer/` shape carried over to the global tree).
 *
 * Hooks and the daemon's event dispatcher both write here; the reconciler
 * walks each registered project's buffer dir at startup. The legacy
 * project-local path remains as a read-side fallback during the brownfield
 * migration window.
 */
export function resolveProjectBufferDir(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): string {
  return path.join(resolveGroveProjectDir(groveId, projectId, mycoHome), 'buffer');
}

export function resolveProjectVaultDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.myco');
}

export function resolveProjectManifestPath(projectVaultDir: string): string {
  return path.join(projectVaultDir, PROJECT_MANIFEST_FILENAME);
}

export function resolveProjectLocalManifestPath(projectVaultDir: string): string {
  return path.join(projectVaultDir, PROJECT_LOCAL_MANIFEST_FILENAME);
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

/**
 * Expand a leading `~` to the user's home dir. Pure path-string helper.
 *
 * Reads `$HOME` first so tests that override the home dir via
 * `process.env.HOME` actually take effect — Bun's `os.homedir()` resolves
 * via `getpwuid_r()` and IGNORES `$HOME` set after process launch, which
 * would otherwise let test pollution from the developer's real `~/...`
 * leak into a tmp-dir scoped test.
 *
 * Single source of truth for the entire codebase — every `globalXxxTarget`
 * resolver, every doctor check, every API handler that touches a
 * `~/...` literal funnels through this.
 */
export function expandHome(value: string, homeDir?: string): string {
  const home = homeDir ?? process.env.HOME ?? os.homedir();
  if (value === '~') return home;
  if (value.startsWith(`~${path.sep}`)) return path.join(home, value.slice(2));
  return value;
}
