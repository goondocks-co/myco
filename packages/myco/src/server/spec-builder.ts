import { RELEASE_TARGETS } from '../../scripts/release-targets.mjs';

const PLATFORM_BUILD = new RegExp(`/packages/myco-(?:${RELEASE_TARGETS.map((target) => target.name).join('|')})/bin/`);
const LEGACY_VENDOR = /\/packages\/[^/]+\/vendor\//;

/** Whether an executable names a checkout's per-platform or vendor build. */
export function looksLikeDevBuildExecutable(executable: string): boolean {
  return PLATFORM_BUILD.test(executable) || LEGACY_VENDOR.test(executable);
}
