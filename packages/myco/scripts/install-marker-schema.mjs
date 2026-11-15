import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const SOURCE_VERSION_PATTERN = '^0[.]0[.]0-dev[+][0-9A-Za-z-]+([.][0-9A-Za-z-]+)*[.]b[0-9a-z]+$';

export const INSTALL_MARKER_SCHEMA = {
  source: 'checkout',
  channels: Object.freeze(['stable', 'beta', 'alpha']),
  versionPattern: SOURCE_VERSION_PATTERN,
  hexCharacters: '0-9a-fA-F',
  commitLength: 40,
  binaryHashLength: 64,
};

const matchesEntire = (pattern, value) => new RegExp(pattern).exec(value)?.[0] === value;
const hexPattern = (length) => `^[${INSTALL_MARKER_SCHEMA.hexCharacters}]{${length}}$`;

/** Checkout provenance is lexical and may be read on a different operating system. */
export function isCanonicalCheckoutPath(value) {
  if (typeof value !== 'string') return false;
  const syntax = value.startsWith('/') ? path.posix :
    (/^[A-Za-z]:\\/.test(value) || value.startsWith('\\\\')) ? path.win32 : null;
  return syntax !== null && syntax.isAbsolute(value) && syntax.parse(value).root !== value &&
    syntax.normalize(value) === value && !value.endsWith(syntax.sep);
}

/** Source provenance remains valid after the checkout has been removed. */
export function validSourceInstallMarker(value, readerPath = path) {
  const s = INSTALL_MARKER_SCHEMA;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.source === s.source && s.channels.includes(value.channel)
    && typeof value.bin === 'string' && readerPath.isAbsolute(value.bin)
    && isCanonicalCheckoutPath(value.checkout)
    && typeof value.commit === 'string' && matchesEntire(hexPattern(s.commitLength), value.commit)
    && typeof value.version === 'string' && matchesEntire(s.versionPattern, value.version)
    && typeof value.binary_sha256 === 'string' && matchesEntire(hexPattern(s.binaryHashLength), value.binary_sha256)
    && (value.prerelease === undefined || typeof value.prerelease === 'boolean');
}

const BUILD_ID_RANDOM_BYTES = 4;

/** Stamp each source artifact with its own full version identity. */
export function stampDevelopmentVersion(description) {
  const describe = description.replace(/^myco\/v/, '').replace(/[^0-9A-Za-z.-]/g, '').split('.').filter(Boolean).join('.') || 'unknown';
  return `0.0.0-dev+${describe}.b${Date.now().toString(36)}${randomBytes(BUILD_ID_RANDOM_BYTES).toString('hex')}`;
}
