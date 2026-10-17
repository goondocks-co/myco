export const SOURCE_VERSION_PATTERN: string;
export const INSTALL_MARKER_SCHEMA: {
  source: 'checkout'; channels: readonly ['stable', 'beta', 'alpha']; versionPattern: string; hexCharacters: string;
  commitLength: number; binaryHashLength: number;
};
export function validSourceInstallMarker(value: unknown, readerPath?: typeof import('node:path').posix): boolean;
export function isCanonicalCheckoutPath(value: unknown): boolean;
export function stampDevelopmentVersion(description: string): string;
