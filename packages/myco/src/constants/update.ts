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

/** Project-local managed runtime directory under the vault. */
export const PROJECT_RUNTIME_DIRNAME = 'runtime';

/** Filename for the version stamp written by `myco update` (lives inside vault .myco/). */
export const UPDATE_STAMP_FILENAME = 'last-update-version';

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

/** Valid release channels. */
export const RELEASE_CHANNELS = ['stable', 'beta'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** Default release channel. */
export const DEFAULT_RELEASE_CHANNEL: ReleaseChannel = 'stable';
