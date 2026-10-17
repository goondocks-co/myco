import path from 'node:path';

export const SOURCE_VERSION_PATTERN = '^0[.]0[.]0-dev[+][0-9A-Za-z-]+([.][0-9A-Za-z-]+)*[.]b[0-9a-z]+$';

export const SOURCE_MARKER_SCHEMA = {
  source: 'checkout',
  channels: Object.freeze(['stable', 'beta', 'alpha']),
  versionPattern: SOURCE_VERSION_PATTERN,
  hexCharacters: '0-9a-fA-F',
  commitLength: 40,
  binaryHashLength: 64,
};

const matchesEntire = (pattern, value) => new RegExp(pattern).exec(value)?.[0] === value;
const hexPattern = (length) => `^[${SOURCE_MARKER_SCHEMA.hexCharacters}]{${length}}$`;

/** Source provenance remains valid after the checkout has been removed. */
export function validSourceInstallMarker(value) {
  const s = SOURCE_MARKER_SCHEMA;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.source === s.source && s.channels.includes(value.channel)
    && typeof value.bin === 'string' && path.isAbsolute(value.bin)
    && typeof value.checkout === 'string' && path.isAbsolute(value.checkout)
    && path.parse(value.checkout).root !== value.checkout && path.resolve(value.checkout) === value.checkout
    && typeof value.commit === 'string' && matchesEntire(hexPattern(s.commitLength), value.commit)
    && typeof value.version === 'string' && matchesEntire(s.versionPattern, value.version)
    && typeof value.binary_sha256 === 'string' && matchesEntire(hexPattern(s.binaryHashLength), value.binary_sha256)
    && (value.prerelease === undefined || typeof value.prerelease === 'boolean');
}
