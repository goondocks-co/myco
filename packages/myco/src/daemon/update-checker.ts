/**
 * Update checker — fetches the npm registry for @goondocks/myco, compares
 * versions against the current installation, caches results, and supports
 * stable/beta release channels.
 *
 * - Stable channel: compare against dist-tags.latest only.
 * - Beta channel: compare against max(dist-tags.latest, dist-tags.beta).
 *   Beta users can always reach stable (no-downgrade rule).
 */

import fs from 'node:fs';
import { CACHE_FILENAME } from '../upgrade/check-cache.js';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import semver from 'semver';
import { readExplicitMachineUpdateChannel } from '../config/loader.js';
import { readInstallMarker, writeInstallMarker } from '../install/managed-binary.js';
import { loadMachineConfig, updateTierConfigRaw } from '../config/loader.js';
import { setAtPath } from '../utils/dot-path.js';

import {
  NPM_PACKAGE_NAME,
  MS_PER_HOUR,
  DEFAULT_RELEASE_CHANNEL,
  RELEASE_CHANNELS,
  MACHINE_RUNTIME_HOME_FILENAME,
  type ReleaseChannel,
  type UpdatePackageId,
} from '../constants/update.js';
import {
  readHomePin,
  readMachineHomePin,
  resolveMachineRuntimeCommandPath,
  resolveMycoHome,
} from '../grove/paths.js';
import { resolveBinary } from '../runtime/binary-resolution.js';
import { resolveRuntimeCommand, resolveRuntimeHome } from '../runtime/runtime-pin.js';

export { resolveRuntimeCommand, resolveRuntimeHome, resolveRuntimePinForCwd } from '../runtime/runtime-pin.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Daemon update config: effective release channel and machine check cadence. */
export interface UpdateConfig {
  channel: ReleaseChannel;
  check_interval_hours: number;
}

/** Cached dist-tags for a single package. */
export interface CachedPackageCheck {
  package_name: string;
  latest_stable: string;
  latest_beta: string | null;
}

/** Cached result of a registry check stored in ~/.myco/last-update-check.json */
export interface CachedCheck {
  checked_at: string;
  channel: ReleaseChannel;
  packages: Partial<Record<UpdatePackageId, CachedPackageCheck>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export function looksLikeMycoBinary(execPath: string): boolean {
  const base = path.basename(execPath).toLowerCase();
  return base === 'myco' || base === 'myco.exe';
}

/**
 * Resolve the myco binary for daemon respawn and update scripts.
 *
 * When `process.execPath` is the myco binary itself (production install or
 * compiled binary), return it directly so the daemon restarts via the same
 * binary. Otherwise resolve pin → managed binary → the bare command name.
 *
 * Accepts an optional `execPath` override so tests can exercise both branches
 * without depending on the test runner's own execPath.
 */
export function resolveMycoBinary(execPath: string = process.execPath): string {
  if (looksLikeMycoBinary(execPath)) return execPath;
  // Not running as the binary (dev tsx/bun): pin → managed → bare name.
  return resolveBinary('instruction', { kind: 'machine' }).path;
}

/**
 * True when the project's layered `runtime.home` pin routes its Myco runtime
 * to a DIFFERENT home than this process serves. A foreign-routed project
 * (e.g. a dogfood repo pinned to `~/.myco-dev` while the prod daemon iterates
 * its `~/.myco` registration) must not receive this daemon's intelligence
 * work: a scan here builds canopy rows the owning runtime never describes,
 * and the resulting permanent backlog both misleads the operations view and
 * pins this daemon out of deep sleep. No pin — the common case — is never
 * foreign.
 */
export function projectRuntimeIsForeign(
  projectVaultDir: string,
  mycoHome: string = resolveMycoHome(),
): boolean {
  const pinned = resolveRuntimeHome(projectVaultDir);
  if (!pinned) return false;
  return path.resolve(pinned) !== path.resolve(mycoHome);
}



/** The install marker owns installed channels; unmarked machines use machine config. */
export function readProjectReleaseChannel(_vaultDir?: string): ReleaseChannel {
  const explicit = readExplicitMachineUpdateChannel();
  const channel = readInstallMarker(resolveMycoHome(), true)?.channel ?? explicit;
  return RELEASE_CHANNELS.includes(channel as ReleaseChannel) ? (channel as ReleaseChannel) : DEFAULT_RELEASE_CHANNEL;
}

/** Persist a machine's channel through the authority used by its reader. */
export function writeProjectReleaseChannel(_vaultDir: string | undefined, channel: ReleaseChannel): void {
  const home = resolveMycoHome();
  const marker = readInstallMarker(home, true);
  if (marker) {
    writeInstallMarker(home, { ...marker, channel });
    return;
  }
  updateTierConfigRaw({ kind: 'machine' }, (rawDoc) => {
    setAtPath(rawDoc, ['daemon', 'update_channel'], channel);
    return rawDoc;
  });
}

/**
 * Returns true when `daemon.update_channel` is `'manual'`. On a manual-channel
 * machine all automatic upgrade paths no-op; operator-initiated paths
 * (POST /api/upgrade/check, POST /api/upgrade/apply, `myco upgrade`) are
 * unaffected.
 */
export function releaseChannelIsManual(): boolean {
  return loadMachineConfig().daemon.update_channel === 'manual';
}

/** Runtime badge source: explicit manual opt-out, otherwise the effective installed channel. */
export type RuntimeOrigin = ReleaseChannel | 'manual';

export interface RuntimeOriginInfo {
  source: RuntimeOrigin;
  /** The pin value when present, else null. UI surfaces this in a tooltip. */
  command: string | null;
}

export function getRuntimeOrigin(vaultDir?: string): RuntimeOriginInfo {
  const ch = loadMachineConfig().daemon.update_channel;
  const source = ch === 'manual' ? ch : readProjectReleaseChannel();
  return { source, command: resolveRuntimeCommand(vaultDir) };
}

/**
 * Human-facing daemon version label. Returns `currentVersion` directly.
 */
export function getRuntimeVersionLabel(currentVersion: string): string {
  return currentVersion;
}


// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Read the effective channel and machine-configured check cadence. */
export function readUpdateConfig(): UpdateConfig {
  return {
    channel: readProjectReleaseChannel(),
    check_interval_hours: loadMachineConfig().daemon.check_interval_hours,
  };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Reads ~/.myco/last-update-check.json. Returns null when the file is missing
 * or unparseable.
 */
export function readCachedCheck(): CachedCheck | null {
  try {
    const raw = fs.readFileSync(path.join(resolveMycoHome(), CACHE_FILENAME), 'utf-8');
    const parsed = JSON.parse(raw) as CachedCheck | Record<string, unknown>;

    if (parsed && typeof parsed === 'object' && 'packages' in parsed && parsed.packages) {
      return parsed as CachedCheck;
    }

    const legacy = parsed as {
      checked_at?: string;
      channel?: ReleaseChannel;
      latest_stable?: string;
      latest_beta?: string | null;
    };

    if (
      typeof legacy.checked_at === 'string' &&
      typeof legacy.latest_stable === 'string'
    ) {
      return {
        checked_at: legacy.checked_at,
        channel: RELEASE_CHANNELS.includes(legacy.channel as ReleaseChannel)
          ? (legacy.channel as ReleaseChannel)
          : DEFAULT_RELEASE_CHANNEL,
        packages: {
          myco: {
            package_name: NPM_PACKAGE_NAME,
            latest_stable: legacy.latest_stable,
            latest_beta: legacy.latest_beta ?? null,
          },
        },
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Deletes the cache file. Used when switching channels so the stale cached
 * result is not returned.
 */
export function clearCachedCheck(): void {
  try {
    fs.unlinkSync(path.join(resolveMycoHome(), CACHE_FILENAME));
  } catch {
    // File not present — that's fine.
  }
}

/**
 * Returns true when the cache is null (never checked) or older than
 * intervalHours.
 */
export function isCacheStale(cache: CachedCheck | null, intervalHours: number): boolean {
  if (cache === null) return true;

  const checkedAt = new Date(cache.checked_at).getTime();
  if (isNaN(checkedAt)) return true;

  const ageMs = Date.now() - checkedAt;
  return ageMs > intervalHours * MS_PER_HOUR;
}

// ---------------------------------------------------------------------------
// Installed version detection
// ---------------------------------------------------------------------------

/**
 * Resolves the npm global prefix by running `npm prefix -g`.
 * Returns the trimmed path string. Throws on failure.
 *
 * Uses execFileSync (not execSync) to avoid shell injection — consistent
 * with codebase conventions per src/utils/execFileNoThrow.ts patterns.
 */
export function resolveGlobalPrefix(): string {
  return execFileSync('npm', ['prefix', '-g'], { encoding: 'utf-8', timeout: 5_000 }).trim();
}

/**
 * Reads the version of the globally installed @goondocks/myco package
 * from disk. Returns null if the package isn't installed or unreadable.
 *
 * Uses a direct fs.readFileSync of the package.json at the expected
 * npm global path — no module resolution, no cache involvement.
 */
export function getInstalledVersion(
  globalPrefix: string,
  packageName = NPM_PACKAGE_NAME,
): string | null {
  try {
    const pkgPath = path.join(
      globalPrefix, 'lib', 'node_modules', packageName, 'package.json',
    );
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

