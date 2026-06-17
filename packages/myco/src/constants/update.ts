import path from 'node:path';
import os from 'node:os';

/** npm registry base URL for Myco packages. */
export const NPM_REGISTRY_BASE_URL = 'https://registry.npmjs.org';

/** Global Myco directory for machine-wide state. */
export const MYCO_GLOBAL_DIR = path.join(os.homedir(), '.myco');

/** Path to the cached update check result. */
export const UPDATE_CHECK_CACHE_PATH = path.join(MYCO_GLOBAL_DIR, 'last-update-check.json');

/** Path to the update configuration file (channel, interval). */
export const UPDATE_CONFIG_PATH = path.join(MYCO_GLOBAL_DIR, 'update.yaml');

/** Path to the update error file (written by update script on failure). */
export const UPDATE_ERROR_PATH = path.join(MYCO_GLOBAL_DIR, 'update-error.json');

/**
 * Path to the cached dev-build verdict.
 *
 * Avoids spawning `npm prefix -g` (200-600ms cold start) on every CLI
 * invocation. The cache is keyed by the running binary's realpath plus
 * the package version, so any reinstall, version bump, or symlink retarget
 * invalidates it automatically.
 */
export const DEV_BUILD_CACHE_PATH = path.join(MYCO_GLOBAL_DIR, 'dev-build-cache.json');

/**
 * Machine-scope managed runtime directory.
 *
 * Lives under `~/.myco/` (or whatever `resolveMycoHome()` returns). When
 * the user opts into the beta channel, `update-installer.ts` does
 * `npm install --prefix ~/.myco/runtime/` and writes the resolved binary
 * path into {@link MACHINE_RUNTIME_COMMAND_FILENAME} so the daemon, hooks,
 * and MCP launchers all dispatch to the same managed binary regardless of
 * which project they're invoked from.
 */
export const MACHINE_RUNTIME_DIRNAME = 'runtime';

/**
 * Staging directory used during atomic swap on update. Same machine-scope
 * sibling as {@link MACHINE_RUNTIME_DIRNAME}: install into `runtime.tmp/`,
 * then `mv` it into place.
 */
export const MACHINE_RUNTIME_TMP_DIRNAME = `${MACHINE_RUNTIME_DIRNAME}.tmp`;

/** Filename for the machine-scope runtime command alias (lives in `~/.myco/`). */
export const MACHINE_RUNTIME_COMMAND_FILENAME = 'runtime.command';

/** Filename for the restart reason signal file (lives inside vault .myco/). */
export const RESTART_REASON_FILENAME = 'restart-reason.json';

/** Default check interval in hours. */
export const UPDATE_CHECK_INTERVAL_HOURS = 6;

/** Milliseconds per hour. */
export const MS_PER_HOUR = 3_600_000;

/** Primary Myco npm package name. */
export const NPM_PACKAGE_NAME = '@goondocks/myco';

/** Optional standalone Myco Team package name. */
export const TEAM_PACKAGE_NAME = '@goondocks/myco-team';

/** Optional standalone Myco Collective package name. */
export const COLLECTIVE_PACKAGE_NAME = '@goondocks/myco-collective';

/** Global-package update targets shown in the Operations UI. */
export const UPDATE_PACKAGES = [
  { id: 'myco', packageName: NPM_PACKAGE_NAME, displayName: 'Myco' },
  { id: 'myco-team', packageName: TEAM_PACKAGE_NAME, displayName: 'Myco Team' },
  { id: 'myco-collective', packageName: COLLECTIVE_PACKAGE_NAME, displayName: 'Myco Collective' },
] as const;
export type UpdatePackageId = (typeof UPDATE_PACKAGES)[number]['id'];

/** Delay in seconds before update script starts (allows daemon to exit). */
export const UPDATE_SCRIPT_DELAY_SECONDS = 2;

/**
 * Crash-loop watch for the binary self-update path: how many times the
 * orchestrator polls /health for the target version after a swap+restart, and
 * the spacing between polls. If the new binary never reports the target version
 * within this window, `applyBinaryUpdate` restores `myco.prev`.
 */
export const BINARY_UPDATE_HEALTH_ATTEMPTS = 10;
export const BINARY_UPDATE_HEALTH_INTERVAL_MS = 2_000;

/** Valid release channels. */
export const RELEASE_CHANNELS = ['stable', 'beta'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** Default release channel. */
export const DEFAULT_RELEASE_CHANNEL: ReleaseChannel = 'stable';
