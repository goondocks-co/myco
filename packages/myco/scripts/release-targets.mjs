/**
 * Every target Myco releases a binary for, and what each binary carries.
 *
 * `native` says whether the binary embeds the native SQLite artifacts (an extension-enabled libsqlite3 and
 * sqlite-vec's vec0) that a Deployment hosted on the machine needs. A target built without them is a member and
 * runner platform: every verb runs on it except those that host a Deployment natively or open one's data files,
 * which refuse.
 */
export const RELEASE_TARGETS = Object.freeze([
  Object.freeze({ name: 'darwin-arm64', platform: 'darwin', arch: 'arm64', label: 'macOS on Apple silicon', native: true }),
  Object.freeze({ name: 'darwin-x64', platform: 'darwin', arch: 'x64', label: 'macOS on Intel', native: true }),
  Object.freeze({ name: 'linux-x64', platform: 'linux', arch: 'x64', label: 'Linux x64', native: true }),
  Object.freeze({ name: 'linux-arm64', platform: 'linux', arch: 'arm64', label: 'Linux ARM64', native: true }),
  Object.freeze({ name: 'windows-x64', platform: 'win32', arch: 'x64', label: 'Windows x64', native: true }),
  Object.freeze({ name: 'windows-arm64', platform: 'win32', arch: 'arm64', label: 'Windows ARM64', native: false }),
]);

/** The release target named `name`, or undefined for a name no release builds. */
export function releaseTarget(name) {
  return RELEASE_TARGETS.find((target) => target.name === name);
}

/** The release target for a platform and architecture (raw `uname -m` spellings accepted), or undefined. */
export function hostReleaseTarget(platform = process.platform, arch = process.arch) {
  const normalized = arch === 'aarch64' ? 'arm64' : arch === 'x86_64' || arch === 'amd64' ? 'x64' : arch;
  return RELEASE_TARGETS.find((target) => target.platform === platform && target.arch === normalized);
}

/** The executable's file name inside a target's build output. */
export function binaryFileName(target) {
  return target.platform === 'win32' ? 'myco.exe' : 'myco';
}

/** The target's asset name on a GitHub release, as SHA256SUMS lists it. */
export function releaseAssetName(target) {
  return target.platform === 'win32' ? `myco-${target.name}.exe` : `myco-${target.name}`;
}
