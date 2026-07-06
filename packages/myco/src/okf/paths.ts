/**
 * Traversal-safe, deterministic OKF bundle path derivation.
 *
 * Concept ids are bundle-relative POSIX paths without the `.md` extension,
 * built from segments that satisfy the OKF slug charset
 * (`[A-Za-z0-9_][A-Za-z0-9_.\-]*` — see {@link okfSlug}). `assertSafeConceptId`
 * is the single choke point that turns an id into a filesystem path: it
 * enforces that charset per segment (closing off whitespace, unicode, and
 * other surprises in one place) and rejects traversal (`.`/`..`), NUL bytes,
 * backslashes, and a leading `/`.
 */

export class OkfPathError extends Error {
  /** Stable machine-readable code, e.g. 'path_traversal', 'invalid_segment'. */
  readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = 'OkfPathError';
    // Every throw site formats messages as '<code>: <detail>'.
    const prefix = message.split(':', 1)[0];
    this.code = /^[a-z_]+$/.test(prefix) ? prefix : 'okf_path_error';
  }
}

/**
 * Slugify arbitrary text (a title, a heading) into a valid OKF concept-id
 * segment: `[A-Za-z0-9_][A-Za-z0-9_.\-]*`, lowercase, never leading `-`/`.`.
 *
 * Diacritics are dropped (NFKD-decompose, then strip the combining marks)
 * before folding case, so accented and unaccented spellings of the same
 * title — and NFC- vs. NFD-composed spellings of the same accented title —
 * slugify to the same result instead of silently drifting apart. Any
 * remaining run of characters outside `[a-z0-9_.-]` collapses to a single
 * underscore, and leading/trailing separators are trimmed so the result
 * always matches the segment charset. A title that slugifies to nothing
 * (all punctuation, or empty) falls back to `_` — still a valid segment, and
 * still caught by {@link detectCollisions} if another title collapses the
 * same way.
 */
export function okfSlug(text: string): string {
  const deaccented = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const lowered = deaccented.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9_.-]+/g, '_');
  const trimmed = replaced.replace(/^[-._]+/, '').replace(/[-._]+$/, '');
  return trimmed === '' ? '_' : trimmed;
}

/**
 * Root-anchor `toPath` into an OKF §5.1 absolute link: always begins with
 * `/`, resolved against the bundle root regardless of the linking document's
 * own location (never computed relative to a `from` path). Idempotent — a
 * `toPath` that already starts with `/` passes through unchanged.
 */
export function bundleLink(toPath: string): string {
  return toPath.startsWith('/') ? toPath : `/${toPath}`;
}

const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * Reject a concept id that could escape the bundle root, or that carries a
 * segment outside the OKF slug charset (the shape {@link okfSlug} always
 * produces).
 *
 * Ids that arrive from a surface (`save_concept`/`get`/`supersede`) reach
 * `conceptPathForId` directly, so this is the single choke point that turns
 * an id into a filesystem path: every path derivation — read and write — is
 * guarded here, and a future caller cannot reintroduce the hole. Mirrors
 * `okfSlug`'s per-segment charset; a segment outside it (whitespace, most
 * punctuation, non-ASCII) is rejected rather than silently reinterpreted —
 * this also closes the lone-surrogate hole the old percent-encoding scheme
 * needed a dedicated check for, since no surrogate can match the charset.
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
    if (!SEGMENT_RE.test(piece)) {
      throw new OkfPathError(
        `invalid_segment: concept id ${JSON.stringify(id)} segment ${JSON.stringify(piece)} is outside the okfSlug charset`,
      );
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
 *
 * `okfSlug` already lowercases its output, so ids built from it collide here
 * only on exact duplicates; the NFC-normalize-then-fold is defense in depth
 * for ids that reach this path some other way (e.g. hand-authored concept
 * ids saved directly through `saveConcept`).
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
