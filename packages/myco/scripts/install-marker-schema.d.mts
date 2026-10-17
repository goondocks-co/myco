export const SOURCE_VERSION_PATTERN: string;
export const SOURCE_MARKER_SCHEMA: {
  source: 'checkout'; channels: readonly ['stable', 'beta', 'alpha']; versionPattern: string; hexCharacters: string;
  commitLength: number; binaryHashLength: number;
};
export function validSourceInstallMarker(value: unknown): boolean;
