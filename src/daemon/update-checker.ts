/**
 * Update checker — fetches the npm registry for @goondocks/myco, compares
 * versions against the current installation, caches results, and supports
 * stable/beta release channels.
 *
 * - Stable channel: compare against dist-tags.latest only.
 * - Beta channel: compare against max(dist-tags.latest, dist-tags.beta).
 *   Beta users can always reach stable (no-downgrade rule).
 * - Dev mode exemption: if MYCO_CMD is set the binary is a dev symlink;
 *   update checks are skipped entirely.
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import semver from 'semver';

import {
  NPM_REGISTRY_URL,
  MYCO_GLOBAL_DIR,
  UPDATE_CHECK_CACHE_PATH,
  UPDATE_CONFIG_PATH,
  UPDATE_ERROR_PATH,
  UPDATE_CHECK_INTERVAL_HOURS,
  MS_PER_HOUR,
  DEFAULT_RELEASE_CHANNEL,
  RELEASE_CHANNELS,
  type ReleaseChannel,
} from '../constants/update.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Persisted update configuration stored in ~/.myco/update.yaml */
export interface UpdateConfig {
  channel: ReleaseChannel;
  check_interval_hours: number;
}

/** Cached result of a registry check stored in ~/.myco/last-update-check.json */
export interface CachedCheck {
  checked_at: string;
  current_version: string;
  latest_stable: string;
  latest_beta: string | null;
  channel: ReleaseChannel;
}

/** Result returned to callers of checkForUpdate / statusFromCache */
export interface CheckResult {
  update_available: boolean;
  running_version: string;
  latest_version: string;
  latest_stable: string;
  latest_beta: string | null;
  channel: ReleaseChannel;
  check_interval_hours: number;
  last_check: string;
  error: string | null;
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
 * Returns true when MYCO_CMD is set — indicates a dev symlink is in use and
 * update checks should be skipped.
 */
export function isUpdateExempt(): boolean {
  return Boolean(process.env.MYCO_CMD);
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
    return JSON.parse(raw) as CachedCheck;
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

// ---------------------------------------------------------------------------
// CheckResult builder
// ---------------------------------------------------------------------------

function buildCheckResult(
  currentVersion: string,
  cache: CachedCheck,
  config: UpdateConfig,
  error: string | null,
): CheckResult {
  const targetVersion = cache.channel === 'stable'
    ? cache.latest_stable
    : resolveHigherVersion(cache.latest_stable, cache.latest_beta);

  const update_available =
    semver.valid(currentVersion) !== null &&
    semver.valid(targetVersion) !== null &&
    semver.gt(targetVersion, currentVersion);

  return {
    update_available,
    running_version: currentVersion,
    latest_version: targetVersion,
    latest_stable: cache.latest_stable,
    latest_beta: cache.latest_beta,
    channel: cache.channel,
    check_interval_hours: config.check_interval_hours,
    last_check: cache.checked_at,
    error,
  };
}

/** Returns the higher of two semver strings. When beta is null, returns stable. */
function resolveHigherVersion(stable: string, beta: string | null): string {
  if (beta === null) return stable;
  return semver.gt(beta, stable) ? beta : stable;
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
export async function checkForUpdate(currentVersion: string): Promise<CheckResult> {
  const config = readUpdateConfig();
  const existingCache = readCachedCheck();

  let distTags: NpmDistTags;
  let fetchError: string | null = null;

  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Registry responded with ${response.status}`);
    }

    const data = (await response.json()) as NpmRegistryResponse;
    distTags = data['dist-tags'];
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);

    // Fall back to stale cache on network error
    if (existingCache !== null) {
      return buildCheckResult(currentVersion, existingCache, config, fetchError);
    }

    // No cache at all — return a no-update result with the error
    return {
      update_available: false,
      running_version: currentVersion,
      latest_version: currentVersion,
      latest_stable: currentVersion,
      latest_beta: null,
      channel: config.channel,
      check_interval_hours: config.check_interval_hours,
      last_check: new Date().toISOString(),
      error: fetchError,
    };
  }

  const latestStable = distTags.latest;
  const latestBeta = distTags.beta ?? null;
  const targetVersion = resolveTargetVersion(distTags, config.channel);

  // Write fresh cache
  const freshCache: CachedCheck = {
    checked_at: new Date().toISOString(),
    current_version: currentVersion,
    latest_stable: latestStable,
    latest_beta: latestBeta,
    channel: config.channel,
  };

  try {
    fs.mkdirSync(path.dirname(UPDATE_CHECK_CACHE_PATH), { recursive: true });
    fs.writeFileSync(UPDATE_CHECK_CACHE_PATH, JSON.stringify(freshCache, null, 2), 'utf-8');
  } catch {
    // Cache write failure is non-fatal
  }

  return buildCheckResult(currentVersion, freshCache, config, null);
}

/**
 * Builds a CheckResult from cached data without hitting the registry.
 * Returns null when no cache exists.
 */
export function statusFromCache(currentVersion: string): CheckResult | null {
  const cache = readCachedCheck();
  if (cache === null) return null;

  const config = readUpdateConfig();
  return buildCheckResult(currentVersion, cache, config, null);
}
