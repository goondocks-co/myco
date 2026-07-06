/**
 * Traversal-safe, deterministic concept path derivation.
 *
 * Concept ids are bundle-relative POSIX paths without the `.md` extension.
 * Derivation never silently drops characters: anything outside `[A-Za-z0-9._-]`
 * is percent-encoded (UTF-8 bytes, uppercase hex), so distinct inputs stay
 * distinct and the encoding is injective (`%` itself is always encoded).
 */

export class OkfPathError extends Error {
  /** Stable machine-readable code, e.g. 'path_traversal', 'lone_surrogate'. */
  readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = 'OkfPathError';
    // Every throw site formats messages as '<code>: <detail>'.
    const prefix = message.split(':', 1)[0];
    this.code = /^[a-z_]+$/.test(prefix) ? prefix : 'okf_path_error';
  }
}

const SAFE_SEGMENT_CHAR = /^[A-Za-z0-9._-]$/;

/**
 * Percent-encode every character outside `[A-Za-z0-9._-]` as uppercase UTF-8 hex.
 *
 * Rejects lone surrogates: Node's UTF-8 encoder collapses every unpaired
 * surrogate (and U+FFFD itself) to the replacement character, which would make
 * distinct inputs encode identically and silently overwrite one another.
 */
export function encodePathSegment(segment: string): string {
  let out = '';
  for (const ch of segment) {
    const code = ch.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new OkfPathError(`lone_surrogate: segment ${JSON.stringify(segment)} contains an unpaired surrogate`);
    }
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
      // NFC-normalize BEFORE per-codepoint encoding so composed/decomposed
      // spellings of the same text (café U+00E9 vs. e + U+0301) derive to the
      // SAME id instead of two distinct percent-encodings that later slip past
      // the case-fold-only `detectCollisions`.
      parts.push(encodePathSegment(piece.normalize('NFC')));
    }
  }
  return parts.join('/');
}

/**
 * Reject a concept id that could escape the bundle root.
 *
 * `deriveConceptId` sanitizes machine-generated ids at projection time, but ids
 * that arrive from a surface (`save_concept`/`get`/`supersede`) reach
 * `conceptPathForId` directly. This is the single choke point that turns an id
 * into a filesystem path, so the traversal rejection lives here: every path
 * derivation — read and write — is guarded, and a future caller cannot
 * reintroduce the hole. Mirrors `deriveConceptId`'s per-segment rules.
 */
export function assertSafeConceptId(id: string): void {
  if (id === '') {
    throw new OkfPathError('empty_segments: a concept id cannot be empty');
  }
  if (id.startsWith('/')) {
    throw new OkfPathError(`path_traversal: concept id ${JSON.stringify(id)} is absolute`);
  }
  for (const piece of id.split('/')) {
    if (piece === '') {
      throw new OkfPathError(`empty_segment: concept id ${JSON.stringify(id)} contains an empty path piece`);
    }
    if (piece === '.' || piece === '..') {
      throw new OkfPathError(`path_traversal: concept id ${JSON.stringify(id)} contains ${JSON.stringify(piece)}`);
    }
    if (piece.includes('\0')) {
      throw new OkfPathError(`nul_byte: concept id ${JSON.stringify(id)} contains a NUL byte`);
    }
    if (piece.includes('\\')) {
      throw new OkfPathError(`path_traversal: concept id ${JSON.stringify(id)} contains a backslash`);
    }
  }
}

/** Bundle-relative file path for a concept id — always `${id}.md`. */
export function conceptPathForId(id: string): string {
  assertSafeConceptId(id);
  return `${id}.md`;
}

/**
 * Return every id that participates in a collision after case-fold
 * normalization (exact duplicates included), preserving input order.
 */
export function detectCollisions(ids: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    // NFC-normalize before folding so composed/decomposed spellings of the
    // same text collide the way case-insensitive filesystems treat them.
    const key = id.normalize('NFC').toLowerCase();
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
