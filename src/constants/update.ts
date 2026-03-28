import path from 'node:path';
import os from 'node:os';

/** npm registry URL for the Myco package. */
export const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@goondocks/myco';

/** Global Myco directory for machine-wide state. */
export const MYCO_GLOBAL_DIR = path.join(os.homedir(), '.myco');

/** Path to the cached update check result. */
export const UPDATE_CHECK_CACHE_PATH = path.join(MYCO_GLOBAL_DIR, 'last-update-check.json');

/** Path to the update configuration file (channel, interval). */
export const UPDATE_CONFIG_PATH = path.join(MYCO_GLOBAL_DIR, 'update.yaml');

/** Path to the update error file (written by update script on failure). */
export const UPDATE_ERROR_PATH = path.join(MYCO_GLOBAL_DIR, 'update-error.json');

/** Default check interval in hours. */
export const UPDATE_CHECK_INTERVAL_HOURS = 6;

/** Milliseconds per hour. */
export const MS_PER_HOUR = 3_600_000;

/** npm package name. */
export const NPM_PACKAGE_NAME = '@goondocks/myco';

/** Delay in seconds before update script starts (allows daemon to exit). */
export const UPDATE_SCRIPT_DELAY_SECONDS = 2;

/** Valid release channels. */
export const RELEASE_CHANNELS = ['stable', 'beta'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** Default release channel. */
export const DEFAULT_RELEASE_CHANNEL: ReleaseChannel = 'stable';
