import path from 'node:path';
import os from 'node:os';
import { RUNTIME_HOME_FILENAME } from '../paths/home.js';

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
 * Filename for the machine-scope runtime command pin (lives in `~/.myco/`).
 *
 * An operator override: when present and trusted it redirects every
 * launcher shim ahead of the managed binary. Absence is the normal state.
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
export const MACHINE_RUNTIME_HOME_FILENAME = RUNTIME_HOME_FILENAME;

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

/** Valid release channels. */
export const RELEASE_CHANNELS = ['stable', 'beta', 'alpha'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** Default release channel. */
export const DEFAULT_RELEASE_CHANNEL: ReleaseChannel = 'stable';
