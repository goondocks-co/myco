export function writeInstallMarker(home: string, marker: {
  channel: string;
  source: string;
  bin: string;
  prerelease?: boolean;
}, publish?: (file: string, contents: string) => void): void;
