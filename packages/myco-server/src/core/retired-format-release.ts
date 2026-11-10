/**
 * The last Myco release that restores a backup holding content in the format before session documents, or null until
 * a release ships without it. `scripts/prepare-plugin-release.mjs` sets it to the release it replaces the first time it
 * prepares a release, and leaves it as it stands after that.
 */
export const LAST_RELEASE_RESTORING_RETIRED_FORMAT: string | null = null;
