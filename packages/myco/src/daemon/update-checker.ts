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
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import semver from 'semver';
import { loadMachineConfig, updateTierConfigRaw } from '../config/loader.js';
import { setAtPath } from '../utils/dot-path.js';

import {
  NPM_PACKAGE_NAME,
  UPDATE_CHECK_CACHE_PATH,
  MS_PER_HOUR,
  DEFAULT_RELEASE_CHANNEL,
  RELEASE_CHANNELS,
  MACHINE_RUNTIME_HOME_FILENAME,
  type ReleaseChannel,
  type UpdatePackageId,
} from '../constants/update.js';
import {
  resolveMachineRuntimeCommandPath,
  resolveMycoHome,
  expandHome,
} from '../grove/paths.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Daemon update config (channel + check cadence), read from the canonical machine config `daemon.*`. */
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
 * binary. Otherwise fall back to the bare `myco` command, which PATH-resolves
 * to the global install.
 *
 * Accepts an optional `execPath` override so tests can exercise both branches
 * without depending on the test runner's own execPath.
 */
export function resolveMycoBinary(execPath: string = process.execPath): string {
  return looksLikeMycoBinary(execPath) ? execPath : 'myco';
}

/**
 * Read the layered `runtime.command` pin and return the trimmed binary
 * path the launcher should exec, or null when no pin applies (the global
 * PATH-resolved `myco` is the implicit default).
 *
 * When `vaultDir` is supplied, `<vaultDir>/runtime.command` is checked
 * first (project-scope pin written by `make dev-link`); the machine-scope
 * `~/.myco/runtime.command` is the fallback (written by the beta-channel
 * installer). The same layering is implemented in the CJS launcher shims
 * (`bin/myco.cjs`, `bin/myco-run`, `.agents/myco-run.cjs`) — they can't
 * import this module so the logic is mirrored.
 */
export function resolveRuntimeCommand(vaultDir?: string): string | null {
  if (vaultDir) {
    const projectPin = readPinFile(path.join(vaultDir, 'runtime.command'));
    if (projectPin) return projectPin;
  }
  return readPinFile(resolveMachineRuntimeCommandPath());
}

/**
 * Read the layered `runtime.home` pin — the sibling of `runtime.command` —
 * and return the absolute home it redirects MYCO_HOME to, or null when no pin
 * applies (the prod `~/.myco` is the implicit default).
 *
 * Mirrors `resolveRuntimeCommand`'s layering: when `vaultDir` is supplied,
 * `<vaultDir>/runtime.home` (the project-scope dogfood pin) is checked first,
 * then the machine-scope `~/.myco/runtime.home`. Both go through the same G7
 * trust check (`readPinFile`). `~` in the value is expanded.
 */
export function resolveRuntimeHome(vaultDir?: string): string | null {
  let raw: string | null = null;
  if (vaultDir) raw = readPinFile(path.join(vaultDir, MACHINE_RUNTIME_HOME_FILENAME));
  if (!raw) raw = readPinFile(path.join(resolveMycoHome(), MACHINE_RUNTIME_HOME_FILENAME));
  return raw ? expandHome(raw) : null;
}

/**
 * Resolve the runtime pin from a launch cwd, used by the standalone launch
 * preamble. The project-scope pin is found by a pure filesystem upward walk
 * for `<dir>/.myco/runtime.command` (first non-empty wins, stopping at the
 * filesystem root); the machine-scope `~/.myco/runtime.command` is the
 * fallback.
 *
 * The walk must stay a filesystem walk — not a git-vault resolution — because
 * a git worktree's vault resolves to the MAIN repo root, which would skip a
 * worktree-local pin written by `make dev-link-worktree` and route dogfood
 * hooks to the wrong binary.
 */
export function resolveRuntimePinForCwd(cwd: string): string | null {
  let dir = path.resolve(cwd);
  while (true) {
    const pin = readPinFile(path.join(dir, '.myco', 'runtime.command'));
    if (pin) return pin;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolveRuntimeCommand();
}

/**
 * POSIX trust check for a `runtime.command` pin file — mirrors
 * `checkRuntimeCommandTrust` in `bin/runtime-redirect.cjs` (the G7 guard).
 * The two implementations are intentionally kept in sync: both refuse any pin
 * whose mode permits group/other write (`mode & 0o022 !== 0`) or whose owner
 * uid differs from the current process. `0o644` (owner rw, group/other
 * readable) is explicitly trusted — only *writability* is the threat surface.
 * Skipped on win32 (no POSIX mode semantics), where the pin is always trusted.
 *
 * Returns `{ ok: true }` when the pin is trusted (or on win32), or
 * `{ ok: false, reason }` when it must be ignored.
 */
const RUNTIME_COMMAND_INSECURE_MODE_MASK = 0o022;

function checkPinTrust(filePath: string): { ok: true } | { ok: false; reason: string } {
  if (process.platform === 'win32') return { ok: true };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'pin file missing' };
    return { ok: false, reason: `stat failed: ${(err as Error).message ?? 'unknown'}` };
  }
  const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (myUid !== null && stat.uid !== myUid) {
    return { ok: false, reason: `pin file owned by uid ${stat.uid}, expected ${myUid}` };
  }
  const mode = stat.mode & 0o777;
  if (mode & RUNTIME_COMMAND_INSECURE_MODE_MASK) {
    return { ok: false, reason: `pin file mode 0${mode.toString(8)} is writable by group/other` };
  }
  return { ok: true };
}

function readPinFile(filePath: string): string | null {
  const trust = checkPinTrust(filePath);
  if (!trust.ok) {
    // A missing pin is the normal "no pin → default" case (both runtime.command
    // and runtime.home are absent on a plain install) — silent. Only a real
    // trust REFUSAL (foreign owner / group-other-writable) warns: never fatal,
    // a daemon with a poisoned pin falls back to the default rather than
    // silently executing it.
    if (trust.reason !== 'pin file missing') {
      try {
        process.stderr.write(`[myco] daemon: ignoring runtime pin (${trust.reason}): ${filePath}\n`);
      } catch {
        // stderr unavailable — swallow
      }
    }
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * The effective release channel is MACHINE-scoped (decision-46130740): it
 * comes from machine config `daemon.update_channel`. There is NO project or
 * personal override — a legacy `update.channel` in a project local.yaml is
 * ignored. The `vaultDir` parameter is retained for call-site compatibility
 * (the API layer passes it) but is not consulted.
 */
export function readProjectReleaseChannel(_vaultDir?: string): ReleaseChannel {
  const channel = loadMachineConfig().daemon.update_channel;
  return RELEASE_CHANNELS.includes(channel as ReleaseChannel) ? (channel as ReleaseChannel) : DEFAULT_RELEASE_CHANNEL;
}

/**
 * Persist the release channel at MACHINE scope (decision-46130740). Writes
 * `daemon.update_channel` into `~/.myco/config.yaml` via the canonical
 * machine-config writer; it must never touch a project local.yaml. The
 * `vaultDir` parameter is retained for call-site compatibility only.
 */
export function writeProjectReleaseChannel(_vaultDir: string | undefined, channel: ReleaseChannel): void {
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

/**
 * Classify the release channel the daemon is running on, for the sidebar
 * runtime badge.
 *
 * - `'beta'`   — `daemon.update_channel` is `'beta'` in machine config.
 * - `'manual'` — `daemon.update_channel` is `'manual'` in machine config
 *                (operator-pinned; automatic upgrade paths no-op).
 * - `'stable'` — all other cases (default managed `~/.myco/bin/myco`).
 *
 * Source is derived from the RAW machine-config field, not from
 * `readProjectReleaseChannel()`, which clamps `manual`→`stable` via
 * `RELEASE_CHANNELS` (that clamp is load-bearing for release-pull paths and
 * must NOT be widened here).
 */
export type RuntimeOrigin = 'stable' | 'beta' | 'manual';

export interface RuntimeOriginInfo {
  source: RuntimeOrigin;
  /** The pin value when present, else null. UI surfaces this in a tooltip. */
  command: string | null;
}

export function getRuntimeOrigin(vaultDir?: string): RuntimeOriginInfo {
  const ch = loadMachineConfig().daemon.update_channel;
  const source = ch === 'beta' || ch === 'manual' ? ch : 'stable';
  return { source, command: resolveRuntimeCommand(vaultDir) };
}

/**
 * Human-facing daemon version label. Returns `currentVersion` directly —
 * the dev git-describe logic was tied to the old `'dev'` origin concept
 * which this task retires.
 */
export function getRuntimeVersionLabel(_vaultDir: string | undefined, currentVersion: string): string {
  return currentVersion;
}


// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Reads the daemon's update config from the CANONICAL machine config
 * (`~/.myco/config.yaml` `daemon.*`) — the SAME source the UI/CLI write via
 * `writeProjectReleaseChannel`. This is deliberately NOT a separate file: the
 * old `~/.myco/update.yaml` diverged from `daemon.update_channel` (nothing ever
 * wrote it), so the background auto-adopt silently ignored channel switches.
 * Reading the daemon config makes the channel + cadence a single source of truth.
 */
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
    const raw = fs.readFileSync(UPDATE_CHECK_CACHE_PATH, 'utf-8');
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
    fs.unlinkSync(UPDATE_CHECK_CACHE_PATH);
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

