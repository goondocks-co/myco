/**
 * Place the resolved binary in its versioned slot and publish it to the stable
 * path, each by atomic temp-and-rename, and pin the runtime command.
 */
export function convergeNpmInstall(args: {
  mycoHome: string;
  platform: string;
  resolvedBinary: string;
  dest: string;
  channel: string;
  version?: string;
  versionedDest?: string;
  /** Injection seam for the install marker; production callers omit it and the inline fallback writes the same JSON. */
  writeMarker?: (mycoHome: string, marker: { channel: string; source: string; bin: string }) => void;
}): { dest: string; copied: boolean; pinAction: string };
