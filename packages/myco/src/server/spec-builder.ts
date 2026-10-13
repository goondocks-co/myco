/** Whether an executable names a checkout's per-platform or vendor build. */
export function looksLikeDevBuildExecutable(executable: string): boolean {
  const platformPkgPattern = /\/packages\/myco-(?:darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64)\/bin\//;
  const legacyVendorPattern = /\/packages\/[^/]+\/vendor\//;
  return platformPkgPattern.test(executable) || legacyVendorPattern.test(executable);
}
