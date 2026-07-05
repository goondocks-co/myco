/**
 * Traversal-safe, deterministic concept path derivation.
 *
 * Concept ids are bundle-relative POSIX paths without the `.md` extension.
 * Derivation never silently drops characters: anything outside `[A-Za-z0-9._-]`
 * is percent-encoded (UTF-8 bytes, uppercase hex), so distinct inputs stay
 * distinct and the encoding is injective (`%` itself is always encoded).
 */

export class OkfPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OkfPathError';
  }
}

const SAFE_SEGMENT_CHAR = /^[A-Za-z0-9._-]$/;

/** Percent-encode every character outside `[A-Za-z0-9._-]` as uppercase UTF-8 hex. */
export function encodePathSegment(segment: string): string {
  let out = '';
  for (const ch of segment) {
    if (SAFE_SEGMENT_CHAR.test(ch)) {
      out += ch;
    } else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

/**
 * Normalize, validate, and encode segments into a concept id.
 *
 * Separators are normalized to `/` (backslashes included) and a leading `/` is
 * stripped; after that, empty segments, `.`, `..`, and NUL bytes are rejected
 * with {@link OkfPathError}. Callers lowercase Myco-controlled directory names
 * themselves; repo-file basename case is preserved here.
 */
export function deriveConceptId(segments: string[]): string {
  if (segments.length === 0) {
    throw new OkfPathError('empty_segments: a concept id requires at least one segment');
  }
  const parts: string[] = [];
  for (const raw of segments) {
    const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalized === '') {
      throw new OkfPathError(`empty_segment: segment ${JSON.stringify(raw)} normalizes to empty`);
    }
    for (const piece of normalized.split('/')) {
      if (piece === '') {
        throw new OkfPathError(`empty_segment: segment ${JSON.stringify(raw)} contains an empty path piece`);
      }
      if (piece === '.' || piece === '..') {
        throw new OkfPathError(`path_traversal: segment ${JSON.stringify(raw)} contains ${JSON.stringify(piece)}`);
      }
      if (piece.includes('\0')) {
        throw new OkfPathError(`nul_byte: segment ${JSON.stringify(raw)} contains a NUL byte`);
      }
      parts.push(encodePathSegment(piece));
    }
  }
  return parts.join('/');
}

/** Bundle-relative file path for a concept id — always `${id}.md`. */
export function conceptPathForId(id: string): string {
  if (id === '') {
    throw new OkfPathError('empty_segments: a concept id cannot be empty');
  }
  return `${id}.md`;
}

/**
 * Return every id that participates in a collision after case-fold
 * normalization (exact duplicates included), preserving input order.
 */
export function detectCollisions(ids: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const key = id.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(id);
    else groups.set(key, [id]);
  }
  const out: string[] = [];
  for (const group of groups.values()) {
    if (group.length > 1) out.push(...group);
  }
  return out;
}
