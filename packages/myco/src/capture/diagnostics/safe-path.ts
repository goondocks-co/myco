import { sha256Hex } from './hash.js';

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Zip entry names built from row-derived identifiers (session ids, etc.) must
 * be a single safe path segment: bundles leave the machine and are unzipped
 * by arbitrary third-party tools, so a raw id containing '/' or '..' would
 * produce a traversal-shaped entry name in an archive built for export.
 */
export function safePathSegment(raw: string): { segment: string; sanitized: boolean } {
  if (raw !== '.' && raw !== '..' && SAFE_SEGMENT_PATTERN.test(raw)) {
    return { segment: raw, sanitized: false };
  }
  return { segment: `unsafe-${sha256Hex(raw).slice(0, 16)}`, sanitized: true };
}
