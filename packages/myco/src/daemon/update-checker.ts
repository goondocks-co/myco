/**
 * Update checker — fetches the npm registry for @goondocks/myco, compares
 * versions against the current installation, caches results, and supports
 * stable/beta release channels.
 *
 * - Stable channel: compare against dist-tags.latest only.
 * - Beta channel: compare against max(dist-tags.latest, dist-tags.beta).
 *   Beta users can always reach stable (no-downgrade rule).
 * - Dev mode exemption: the daemon records its own CLI entry at startup
 *   via `setDevBuildCliEntry()` when `detectDevBuild()` reports the
 *   running binary is outside the npm global prefix. When set, update
 *   checks are skipped entirely and any child-spawned shell script
 *   (update/restart) uses the recorded CLI entry as its restart
 *   target. This replaced the previous `MYCO_CMD` env-var dispatch,
 *   which was fragile because several symbionts do not propagate
 *   env vars to hook or MCP child processes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import semver from 'semver';
import { loadMachineConfig, updateTierConfigRaw } from '../config/loader.js';
import { setAtPath } from '../utils/dot-path.js';

import {
  NPM_PACKAGE_NAME,
  MYCO_GLOBAL_DIR,
  UPDATE_CHECK_CACHE_PATH,
  MS_PER_HOUR,
  DEV_BUILD_CACHE_PATH,
  DEFAULT_RELEASE_CHANNEL,
  RELEASE_CHANNELS,
  type ReleaseChannel,
  type UpdatePackageId,
} from '../constants/update.js';
import {
  resolveMachineRuntimeCommandPath,
  setDevServiceMode,
} from '../grove/paths.js';
import { getPluginVersion } from '../version.js';

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

// ---------------------------------------------------------------------------
// Dev-mode exemption
// ---------------------------------------------------------------------------

/**
 * Module-level state: the CLI entry path of the running daemon when it's
 * a dev build, or null when it's a proper global install.
 *
 * Set once at daemon startup from `main.ts` after `detectDevBuild()`
 * reports its finding. Read by `isUpdateExempt()` (to skip update checks)
 * and by `resolveMycoBinary()` (to choose the restart target for
 * update/restart shell scripts).
 *
 * Test code can reset this via `setDevBuildCliEntry(null)`.
 */
let devBuildCliEntry: string | null = null;

/**
 * Record the daemon's dev-build CLI entry. Pass `null` to clear.
 * Also pairs `setDevServiceMode` so the service-dir branch in `grove/paths`
 * never drifts from the update-checker's view of the running binary.
 */
export function setDevBuildCliEntry(cliEntry: string | null): void {
  devBuildCliEntry = cliEntry;
  setDevServiceMode(cliEntry !== null);
}

/**
 * Returns the recorded dev-build CLI entry, or null when the daemon is
 * running from a proper global install.
 */
export function getDevBuildCliEntry(): string | null {
  return devBuildCliEntry;
}

/**
 * Run dev-build detection at CLI startup and record the result via
 * `setDevBuildCliEntry` (which also drives `setDevServiceMode` for the
 * `service-dev/` branch).
 *
 * Cached on disk in `~/.myco/dev-build-cache.json` keyed by the realpath
 * of `process.execPath` plus the running package version. The first call
 * after a reinstall pays the `npm prefix -g` subprocess; subsequent calls
 * read a single small JSON file. This matters because the function fires
 * on every CLI invocation including hooks, where 200-600ms of `npm`
 * startup would be visible per agent action.
 *
 * Uses `process.execPath` (not `argv[1]`) for the same reason `main.ts`
 * does: under the bun-compiled binary, `argv[1]` is a virtual `/$bunfs/`
 * path that `realpath` rejects.
 */
export function activateDevBuildModeIfDetected(): void {
  if (!looksLikeMycoBinary(process.execPath)) return;

  let execRealpath: string;
  try {
    execRealpath = fs.realpathSync(process.execPath);
  } catch {
    return;
  }
  const version = getPluginVersion();

  const cached = readDevBuildCache();
  if (cached && cached.exec_path_realpath === execRealpath && cached.package_version === version) {
    if (cached.dev_build_cli_entry) setDevBuildCliEntry(cached.dev_build_cli_entry);
    return;
  }

  let globalPrefix: string | null = null;
  try {
    globalPrefix = resolveGlobalPrefix();
  } catch {
    // npm not on PATH or otherwise unresolvable — treat as production
    // and don't write a cache entry; we'll re-try next invocation.
    return;
  }
  const devEntry = detectDevBuild(globalPrefix, process.execPath, fs.realpathSync);
  if (devEntry) setDevBuildCliEntry(devEntry);
  writeDevBuildCache({
    exec_path_realpath: execRealpath,
    package_version: version,
    dev_build_cli_entry: devEntry,
  });
}

interface DevBuildCacheEntry {
  exec_path_realpath: string;
  package_version: string;
  dev_build_cli_entry: string | null;
}

function readDevBuildCache(): DevBuildCacheEntry | null {
  try {
    const raw = fs.readFileSync(DEV_BUILD_CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DevBuildCacheEntry>;
    if (
      typeof parsed?.exec_path_realpath === 'string'
      && typeof parsed?.package_version === 'string'
      && (parsed.dev_build_cli_entry === null || typeof parsed.dev_build_cli_entry === 'string')
    ) {
      return parsed as DevBuildCacheEntry;
    }
    return null;
  } catch {
    return null;
  }
}

function writeDevBuildCache(entry: DevBuildCacheEntry): void {
  try {
    fs.mkdirSync(MYCO_GLOBAL_DIR, { recursive: true });
    fs.writeFileSync(DEV_BUILD_CACHE_PATH, JSON.stringify(entry, null, 2), 'utf-8');
  } catch {
    // Cache write failure is non-fatal; we just pay the subprocess again next run.
  }
}

function looksLikeMycoBinary(execPath: string): boolean {
  const base = path.basename(execPath).toLowerCase();
  return base === 'myco' || base === 'myco.exe';
}

/**
 * Resolve the myco binary that child-spawned restart/update scripts
 * should invoke to restart the daemon.
 *
 * - Dev mode (dev build CLI entry set): use the literal CLI entry path,
 *   so the restart respawns the same dev binary. After an npm update
 *   this intentionally keeps running the dev build — dev mode is opaque
 *   to global updates, which is the correct semantic.
 * - Prod mode (no dev build CLI entry): fall back to the bare `myco`
 *   command, which PATH-resolves to the freshly-updated global install.
 */
export function resolveMycoBinary(): string {
  return devBuildCliEntry ?? 'myco';
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
    // Best-effort warning — never fatal; a daemon with a poisoned pin falls
    // back to the PATH-resolved `myco` rather than silently executing it.
    try {
      process.stderr.write(`[myco] daemon: ignoring runtime.command pin (${trust.reason}): ${filePath}\n`);
    } catch {
      // stderr unavailable — swallow
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
 * Returns true when the daemon is running from a dev build — skip
 * update checks and suppress the Operations UI update banner.
 */
export function isUpdateExempt(): boolean {
  return devBuildCliEntry !== null;
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
 * Classify how the daemon was launched, for the sidebar runtime badge.
 *
 * - `'dev'`    — `detectDevBuild` flagged this binary as outside the npm
 *                global prefix (dogfood `make dev-link`, `npm link`, etc.),
 *                or a project-scope pin at `<vaultDir>/runtime.command`
 *                points the daemon at a hand-built dev binary.
 * - `'stable'` — otherwise; the managed `~/.myco/bin/myco` (stable or beta
 *                channel — both are the same in-place binary) answers.
 *
 * The legacy `'beta'` source (a separate `~/.myco/runtime/` npm install) was
 * retired with the native installer: a beta user runs the same managed binary,
 * just resolved from a prerelease release.
 */
export type RuntimeOrigin = 'stable' | 'dev';

export interface RuntimeOriginInfo {
  source: RuntimeOrigin;
  /** The pin value when present, else null. UI surfaces this in a tooltip. */
  command: string | null;
}

interface RuntimeVersionLabelCacheEntry {
  key: string;
  label: string;
  expiresAt: number;
}

const RUNTIME_VERSION_LABEL_CACHE_MS = 30_000;
let runtimeVersionLabelCache: RuntimeVersionLabelCacheEntry | null = null;

export function getRuntimeOrigin(vaultDir?: string): RuntimeOriginInfo {
  if (devBuildCliEntry !== null) {
    return { source: 'dev', command: devBuildCliEntry };
  }
  return { source: 'stable', command: resolveRuntimeCommand(vaultDir) };
}

/**
 * Human-facing daemon version label.
 *
 * `getPluginVersion()` remains the protocol/update version: compiled dev
 * binaries embed package.json and can legitimately lag release automation.
 * For dogfood/dev runtimes, the UI should instead show where that build sits
 * relative to the nearest release tag, e.g. `v0.18.1-244-g63fe75a5-dirty`.
 */
export function getRuntimeVersionLabel(vaultDir: string | undefined, currentVersion: string): string {
  const runtime = getRuntimeOrigin(vaultDir);
  if (runtime.source !== 'dev') return currentVersion;

  const cacheKey = `${runtime.source}:${runtime.command ?? ''}:${currentVersion}`;
  const now = Date.now();
  if (
    runtimeVersionLabelCache
    && runtimeVersionLabelCache.key === cacheKey
    && runtimeVersionLabelCache.expiresAt > now
  ) {
    return runtimeVersionLabelCache.label;
  }

  const repoRoot = findGitRepoForRuntime(runtime.command ?? process.execPath);
  const label = repoRoot
    ? describeGitVersion(repoRoot) ?? `${currentVersion}+dev`
    : `${currentVersion}+dev`;

  runtimeVersionLabelCache = {
    key: cacheKey,
    label,
    expiresAt: now + RUNTIME_VERSION_LABEL_CACHE_MS,
  };
  return label;
}

function findGitRepoForRuntime(runtimeCommand: string): string | null {
  const resolved = (() => {
    try {
      return fs.realpathSync(runtimeCommand);
    } catch {
      return runtimeCommand;
    }
  })();

  let dir = path.dirname(resolved);
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function describeGitVersion(repoRoot: string): string | null {
  try {
    const described = execFileSync(
      'git',
      ['-C', repoRoot, 'describe', '--tags', '--match', 'v[0-9]*', '--always', '--dirty'],
      { encoding: 'utf-8', timeout: 2_000 },
    ).trim();
    return described || null;
  } catch {
    return null;
  }
}

/**
 * Detects whether the running daemon is a dev build by comparing the CLI
 * entry point's realpath against the npm global prefix's realpath.
 *
 * Returns the CLI entry path when a dev build is detected (so the caller
 * can record it via `setDevBuildCliEntry()`), or null when no dev build
 * applies.
 *
 * A dev build is any binary whose realpath is NOT under the npm global
 * prefix — direct `myco-dev` invocations, `npm link` installs, local
 * `node dist/cli.js` runs, etc.
 *
 * Returns null when:
 * - globalPrefix is null (npm prefix resolution failed; can't verify)
 * - cliEntry is missing
 * - realpath resolution throws
 * - the binary IS under the global prefix (proper install — normal updates)
 *
 * All inputs are passed explicitly (no defaults) so tests can control the
 * environment without inheriting from the enclosing process.
 */
export function detectDevBuild(
  globalPrefix: string | null,
  cliEntry: string | undefined,
  realpath: (p: string) => string,
): string | null {
  if (!globalPrefix) return null;
  if (!cliEntry) return null;
  try {
    const resolvedEntry = realpath(cliEntry);
    const resolvedPrefix = realpath(globalPrefix);
    if (resolvedEntry.startsWith(resolvedPrefix + path.sep) || resolvedEntry === resolvedPrefix) {
      return null;
    }
    return cliEntry;
  } catch {
    return null;
  }
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

