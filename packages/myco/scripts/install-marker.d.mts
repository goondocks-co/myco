export function writeInstallMarker(home: string, marker: {
  channel: string;
  source: string;
  bin: string;
  prerelease?: boolean;
}, publish?: (file: string, contents: string) => void): void;
export const AUTOMATIC_UPDATE_PREFERENCE_FILE: string;
export function writeAutomaticUpdatePreference(home: string, enabled: boolean, publish?: (file: string, contents: string) => void): void;
