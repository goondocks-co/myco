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
 * Append-only event log the DETACHED adopt orchestrator writes (it is
 * `stdio:'ignore'` and cannot reach the grove DB it is restarting). The daemon
 * drains it on the next startup and replays each line through the structured
 * logger (LOG_KINDS.UPGRADE_ADOPT) into `log_entries`, so the self-upgrade
 * sequence is visible in the log viewer instead of vanishing into /dev/null.
 */
export const UPDATE_EVENTS_PATH = path.join(MYCO_GLOBAL_DIR, 'update-events.jsonl');

/**
 * Filename for the machine-scope runtime command pin (lives in `~/.myco/`).
 *
 * Single source of truth for which `myco` binary the launcher shims exec.
 * Still load-bearing post native-installer: convergence, `runtime-redirect.cjs`,
 * the launch preamble, and dev dogfood pins all read/write it. (The retired
 * managed-runtime DIR/TMP constants were deleted with the native installer; the
 * pin file itself remains.)
 */
export const MACHINE_RUNTIME_COMMAND_FILENAME = 'runtime.command';

/**
 * Filename for the runtime home pin — a sibling of `runtime.command` in the
 * SAME (project or machine) dir. A plaintext, single-line, absolute home path
 * that redirects MYCO_HOME for that scope, routing the CLI, hooks, MCP, and
 * symbiont capture plugins at a non-default daemon (e.g. a dogfood `~/.myco-dev`).
 * Read under the same G7 trust check as `runtime.command`.
 */
export const MACHINE_RUNTIME_HOME_FILENAME = 'runtime.home';

/** Filename for the restart reason signal file (lives inside vault .myco/). */
export const RESTART_REASON_FILENAME = 'restart-reason.json';

/** Default check interval in hours. */
export const UPDATE_CHECK_INTERVAL_HOURS = 6;

/** Milliseconds per hour. */
export const MS_PER_HOUR = 3_600_000;

/** Primary Myco npm package name. */
export const NPM_PACKAGE_NAME = '@goondocks/myco';

/** Global-package update targets shown in the Operations UI. */
export const UPDATE_PACKAGES = [
  { id: 'myco', packageName: NPM_PACKAGE_NAME, displayName: 'Myco' },
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
