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
import YAML from 'yaml';
import semver from 'semver';
import { loadLocalConfig, updateLocalConfig } from '../config/loader.js';

import {
  NPM_REGISTRY_BASE_URL,
  NPM_PACKAGE_NAME,
  UPDATE_PACKAGES,
  MYCO_GLOBAL_DIR,
  PROJECT_RUNTIME_DIRNAME,
  PROJECT_RUNTIME_COMMAND_FILENAME,
  UPDATE_CHECK_CACHE_PATH,
  UPDATE_CONFIG_PATH,
  UPDATE_ERROR_PATH,
  UPDATE_CHECK_INTERVAL_HOURS,
  MS_PER_HOUR,
  DEFAULT_RELEASE_CHANNEL,
  RELEASE_CHANNELS,
  type ReleaseChannel,
  type UpdatePackageId,
} from '../constants/update.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Persisted update configuration stored in ~/.myco/update.yaml */
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

/** Installed/update status for one globally installed Myco package. */
export interface PackageCheckResult {
  id: UpdatePackageId;
  display_name: string;
  package_name: string;
  installed: boolean;
  installed_version: string | null;
  latest_version: string | null;
  latest_stable: string | null;
  latest_beta: string | null;
  /** True when the target version is strictly greater than what's installed. */
  update_available: boolean;
  /**
   * True when the project is pinned to a managed beta runtime and the stable
   * target is lower than the running version — set only on the `myco` package
   * during a revert-to-stable flow. Mutually exclusive with `update_available`.
   */
  revert_available: boolean;
}

/** Result returned to callers of checkForUpdate / statusFromCache */
export interface CheckResult {
  update_available: boolean;
  /** True when any package has `revert_available` set. */
  revert_available: boolean;
  running_version: string;
  latest_version: string;
  latest_stable: string;
  latest_beta: string | null;
  channel: ReleaseChannel;
  channel_scope: 'project';
  runtime_scope: 'project' | 'machine';
  check_interval_hours: number;
  last_check: string;
  error: string | null;
  packages: PackageCheckResult[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fetch timeout for registry requests. */
const REGISTRY_FETCH_TIMEOUT_MS = 10_000;

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
 * Called once at daemon startup after `detectDevBuild()` decides whether
 * the running binary is a dev build.
 */
export function setDevBuildCliEntry(cliEntry: string | null): void {
  devBuildCliEntry = cliEntry;
}

/**
 * Returns the recorded dev-build CLI entry, or null when the daemon is
 * running from a proper global install.
 */
export function getDevBuildCliEntry(): string | null {
  return devBuildCliEntry;
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

export function resolveRuntimeCommand(vaultDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(vaultDir, PROJECT_RUNTIME_COMMAND_FILENAME), 'utf-8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * True when `cliEntry` points inside the project-local managed runtime.
 *
 * When `vaultDir` is known, prefer `startsWith` against the exact managed
 * runtime path — this is robust to `.myco` being relocated via
 * `MYCO_VAULT_DIR`. The path-less form falls back to a substring match,
 * used only in contexts where vaultDir is unavailable.
 */
export function isManagedProjectRuntime(cliEntry: string, vaultDir?: string): boolean {
  const normalized = cliEntry.split(path.sep).join('/');
  if (vaultDir !== undefined) {
    const managedPrefix = `${vaultDir.split(path.sep).join('/')}/${PROJECT_RUNTIME_DIRNAME}/node_modules/`;
    return normalized.startsWith(managedPrefix);
  }
  return normalized.includes(`/.myco/${PROJECT_RUNTIME_DIRNAME}/node_modules/`);
}

/**
 * Classify how the current project dispatches the `myco` binary.
 *
 * - `'project'` — a managed project-local runtime exists under the vault
 *   (`.myco/runtime/`), pointed at by `.myco/runtime.command`.
 * - `'machine'` — no project-local runtime; fall back to the machine-
 *   installed myco via PATH or its absolute path.
 *
 * Single source of truth for the "where does this project's myco live"
 * question. Prefer this over reading `runtime.command` directly.
 */
export function getHarnessScope(vaultDir: string): 'project' | 'machine' {
  const runtimeCommand = resolveRuntimeCommand(vaultDir);
  return runtimeCommand !== null && isManagedProjectRuntime(runtimeCommand, vaultDir)
    ? 'project'
    : 'machine';
}

export function readProjectReleaseChannel(vaultDir: string): ReleaseChannel {
  const local = loadLocalConfig(vaultDir);
  const projectChannel = local.update?.channel;
  if (RELEASE_CHANNELS.includes(projectChannel as ReleaseChannel)) {
    return projectChannel as ReleaseChannel;
  }

  // Migration fallback: before 0.22, the channel lived in the machine-global
  // ~/.myco/update.yaml. Honor that preference when this project has not
  // explicitly set one, so existing beta users don't silently fall back to
  // stable after upgrading. Per-project opt-out via the Operations UI writes
  // to local.yaml and shadows this fallback.
  const legacyChannel = readUpdateConfig().channel;
  return RELEASE_CHANNELS.includes(legacyChannel) ? legacyChannel : DEFAULT_RELEASE_CHANNEL;
}

export function writeProjectReleaseChannel(vaultDir: string, channel: ReleaseChannel): void {
  updateLocalConfig(vaultDir, (local) => {
    const next = { ...local };

    if (channel === DEFAULT_RELEASE_CHANNEL) {
      delete next.update;
    } else {
      next.update = { channel };
    }

    return next;
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
    if (isManagedProjectRuntime(resolvedEntry)) {
      return null;
    }
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

/** Default config returned when no update.yaml exists. */
function defaultUpdateConfig(): UpdateConfig {
  return {
    channel: DEFAULT_RELEASE_CHANNEL,
    check_interval_hours: UPDATE_CHECK_INTERVAL_HOURS,
  };
}

/**
 * Reads ~/.myco/update.yaml. Returns defaults when the file is missing or
 * unparseable.
 */
export function readUpdateConfig(): UpdateConfig {
  try {
    const raw = fs.readFileSync(UPDATE_CONFIG_PATH, 'utf-8');
    const parsed = YAML.parse(raw) as Partial<UpdateConfig>;

    const channel = RELEASE_CHANNELS.includes(parsed?.channel as ReleaseChannel)
      ? (parsed.channel as ReleaseChannel)
      : DEFAULT_RELEASE_CHANNEL;

    const check_interval_hours =
      typeof parsed?.check_interval_hours === 'number' && parsed.check_interval_hours > 0
        ? parsed.check_interval_hours
        : UPDATE_CHECK_INTERVAL_HOURS;

    return { channel, check_interval_hours };
  } catch {
    return defaultUpdateConfig();
  }
}

/**
 * Writes UpdateConfig to ~/.myco/update.yaml. Creates ~/.myco/ if needed.
 */
export function writeUpdateConfig(config: UpdateConfig): void {
  fs.mkdirSync(MYCO_GLOBAL_DIR, { recursive: true });
  fs.writeFileSync(UPDATE_CONFIG_PATH, YAML.stringify(config), 'utf-8');
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
// Error file
// ---------------------------------------------------------------------------

/**
 * Reads ~/.myco/update-error.json. Returns the error string when present, null
 * otherwise.
 */
export function readUpdateError(): string | null {
  try {
    const raw = fs.readFileSync(UPDATE_ERROR_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { error?: string };
    return parsed?.error ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

interface NpmDistTags {
  latest: string;
  beta?: string;
  [tag: string]: string | undefined;
}

interface NpmRegistryResponse {
  'dist-tags': NpmDistTags;
}

/** Build the npm registry URL for a specific package. */
function packageRegistryUrl(packageName: string): string {
  return `${NPM_REGISTRY_BASE_URL}/${encodeURIComponent(packageName)}`;
}

// ---------------------------------------------------------------------------
// Channel comparison logic
// ---------------------------------------------------------------------------

/**
 * Returns the target version to compare against based on channel.
 * - Stable: dist-tags.latest
 * - Beta: max(dist-tags.latest, dist-tags.beta) — no-downgrade rule
 */
function resolveTargetVersion(distTags: NpmDistTags, channel: ReleaseChannel): string {
  const stable = distTags.latest;
  const beta = distTags.beta ?? null;

  if (channel === 'stable' || beta === null) {
    return stable;
  }

  // Beta channel: pick whichever is higher (stable can exceed beta tag)
  const higher = semver.gt(beta, stable) ? beta : stable;
  return higher;
}

function resolveTargetVersionFromCache(
  pkg: CachedPackageCheck,
  channel: ReleaseChannel,
): string {
  return resolveTargetVersion(
    { latest: pkg.latest_stable, beta: pkg.latest_beta ?? undefined },
    channel,
  );
}

function buildInstalledPackageVersions(
  globalPrefix: string | null,
  currentVersion: string,
): Record<UpdatePackageId, string | null> {
  const installed: Record<UpdatePackageId, string | null> = {
    myco: currentVersion,
    'myco-team': null,
    'myco-collective': null,
  };

  if (globalPrefix === null) return installed;

  for (const pkg of UPDATE_PACKAGES) {
    if (pkg.id === 'myco') continue;
    installed[pkg.id] = getInstalledVersion(globalPrefix, pkg.packageName);
  }

  return installed;
}

function buildPackageResults(
  currentVersion: string,
  cache: CachedCheck,
  channel: ReleaseChannel,
  globalPrefix: string | null,
  runtimeCommand: string | null = null,
  vaultDir?: string,
): PackageCheckResult[] {
  const installedVersions = buildInstalledPackageVersions(globalPrefix, currentVersion);
  const isManagedStableRevert =
    channel === 'stable'
    && runtimeCommand !== null
    && isManagedProjectRuntime(runtimeCommand, vaultDir);

  return UPDATE_PACKAGES.map((pkg) => {
    const cached = cache.packages[pkg.id];
    const installedVersion = installedVersions[pkg.id];
    const latestVersion = cached ? resolveTargetVersionFromCache(cached, channel) : null;
    const updateAvailable =
      installedVersion !== null &&
      latestVersion !== null &&
      semver.valid(installedVersion) !== null &&
      semver.valid(latestVersion) !== null &&
      semver.gt(latestVersion, installedVersion);
    const revertAvailable =
      pkg.id === 'myco' &&
      isManagedStableRevert &&
      latestVersion !== null &&
      latestVersion !== currentVersion &&
      !updateAvailable;

    return {
      id: pkg.id,
      display_name: pkg.displayName,
      package_name: pkg.packageName,
      installed: installedVersion !== null,
      installed_version: installedVersion,
      latest_version: latestVersion,
      latest_stable: cached?.latest_stable ?? null,
      latest_beta: cached?.latest_beta ?? null,
      update_available: updateAvailable,
      revert_available: revertAvailable,
    };
  });
}

// ---------------------------------------------------------------------------
// CheckResult builder
// ---------------------------------------------------------------------------

function buildCheckResult(
  currentVersion: string,
  cache: CachedCheck,
  config: UpdateConfig,
  channel: ReleaseChannel,
  error: string | null,
  globalPrefix: string | null,
  runtimeCommand: string | null = null,
  vaultDir?: string,
): CheckResult {
  const packages = buildPackageResults(currentVersion, cache, channel, globalPrefix, runtimeCommand, vaultDir);
  const primaryPackage = packages.find((pkg) => pkg.id === 'myco');
  const targetVersion = primaryPackage?.latest_version ?? currentVersion;
  const latestStable = primaryPackage?.latest_stable ?? currentVersion;
  const latestBeta = primaryPackage?.latest_beta ?? null;
  const updateAvailable = packages.some((pkg) => pkg.installed && pkg.update_available);
  const revertAvailable = packages.some((pkg) => pkg.revert_available);
  const runtimeScope: 'project' | 'machine' =
    runtimeCommand !== null && isManagedProjectRuntime(runtimeCommand, vaultDir)
      ? 'project'
      : 'machine';

  return {
    update_available: updateAvailable,
    revert_available: revertAvailable,
    running_version: currentVersion,
    latest_version: targetVersion,
    latest_stable: latestStable,
    latest_beta: latestBeta,
    channel,
    channel_scope: 'project',
    runtime_scope: runtimeScope,
    check_interval_hours: config.check_interval_hours,
    last_check: cache.checked_at,
    error,
    packages,
  };
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

// ---------------------------------------------------------------------------
// Primary exports
// ---------------------------------------------------------------------------

/**
 * Fetches the npm registry, compares versions, and writes the result to cache.
 *
 * On network failure, returns the last cached result (with an error field) if
 * one exists. If no cache exists and the fetch fails, the error field is set
 * and update_available is false.
 */
export async function checkForUpdate(
  currentVersion: string,
  globalPrefix: string | null = null,
  runtimeCommand: string | null = null,
  channelOverride?: ReleaseChannel,
  vaultDir?: string,
): Promise<CheckResult> {
  const config = readUpdateConfig();
  const existingCache = readCachedCheck();
  const effectiveChannel = channelOverride ?? config.channel;

  const freshPackages: Partial<Record<UpdatePackageId, CachedPackageCheck>> = {};
  const fetchErrors: string[] = [];

  const registryChecks = await Promise.allSettled(
    UPDATE_PACKAGES.map(async (pkg) => {
      const response = await fetch(packageRegistryUrl(pkg.packageName), {
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`${pkg.packageName}: registry responded with ${response.status}`);
      }

      const data = (await response.json()) as NpmRegistryResponse;
      return {
        id: pkg.id,
        package_name: pkg.packageName,
        latest_stable: data['dist-tags'].latest,
        latest_beta: data['dist-tags'].beta ?? null,
      };
    }),
  );

  for (const result of registryChecks) {
    if (result.status === 'fulfilled') {
      freshPackages[result.value.id] = {
        package_name: result.value.package_name,
        latest_stable: result.value.latest_stable,
        latest_beta: result.value.latest_beta,
      };
      continue;
    }

    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    fetchErrors.push(message);
  }

  if (existingCache !== null) {
    for (const pkg of UPDATE_PACKAGES) {
      if (freshPackages[pkg.id] !== undefined) continue;
      const cached = existingCache.packages[pkg.id];
      if (cached) {
        freshPackages[pkg.id] = cached;
      }
    }
  }

  if (Object.keys(freshPackages).length === 0) {
    const fetchError = fetchErrors[0] ?? 'registry fetch failed';
    return {
      update_available: false,
      revert_available: false,
      running_version: currentVersion,
      latest_version: currentVersion,
      latest_stable: currentVersion,
      latest_beta: null,
      channel: effectiveChannel,
      channel_scope: 'project',
      runtime_scope:
        runtimeCommand !== null && isManagedProjectRuntime(runtimeCommand, vaultDir)
          ? 'project'
          : 'machine',
      check_interval_hours: config.check_interval_hours,
      last_check: new Date().toISOString(),
      error: fetchError,
      packages: buildPackageResults(
        currentVersion,
        { checked_at: new Date().toISOString(), channel: effectiveChannel, packages: {} },
        effectiveChannel,
        globalPrefix,
        runtimeCommand,
        vaultDir,
      ),
    };
  }

  const freshCache: CachedCheck = {
    checked_at: new Date().toISOString(),
    channel: effectiveChannel,
    packages: freshPackages,
  };

  try {
    fs.mkdirSync(path.dirname(UPDATE_CHECK_CACHE_PATH), { recursive: true });
    fs.writeFileSync(UPDATE_CHECK_CACHE_PATH, JSON.stringify(freshCache, null, 2), 'utf-8');
  } catch {
    // Cache write failure is non-fatal
  }

  const error = fetchErrors.length > 0 ? fetchErrors.join('; ') : null;
  return buildCheckResult(
    currentVersion,
    freshCache,
    config,
    effectiveChannel,
    error,
    globalPrefix,
    runtimeCommand,
    vaultDir,
  );
}

/**
 * Builds a CheckResult from cached data without hitting the registry.
 * Returns null when no cache exists.
 *
 * Accepts optional pre-read `cache` and `config` to avoid redundant file
 * reads when the caller has already loaded them (e.g. for a staleness check).
 */
export function statusFromCache(
  currentVersion: string,
  cache?: CachedCheck | null,
  config?: UpdateConfig,
  globalPrefix: string | null = null,
  runtimeCommand: string | null = null,
  channelOverride?: ReleaseChannel,
  vaultDir?: string,
): CheckResult | null {
  const resolvedCache = cache !== undefined ? cache : readCachedCheck();
  if (resolvedCache === null) return null;

  const resolvedConfig = config !== undefined ? config : readUpdateConfig();
  const effectiveChannel = channelOverride ?? resolvedCache.channel ?? resolvedConfig.channel;
  return buildCheckResult(
    currentVersion,
    resolvedCache,
    resolvedConfig,
    effectiveChannel,
    null,
    globalPrefix,
    runtimeCommand,
    vaultDir,
  );
}
