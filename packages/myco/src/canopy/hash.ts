import { createHash } from 'node:crypto';
import { CONTENT_HASH_ALGORITHM } from '@myco/constants.js';

/** SHA-256 hex digest of a buffer or string. */
export function sha256Hex(buf: Buffer | string): string {
  return createHash(CONTENT_HASH_ALGORITHM).update(buf).digest('hex');
}
