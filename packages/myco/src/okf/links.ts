/**
 * Deterministic body cross-link normalization for synthesized OKF pages.
 *
 * The synthesis model authors page bodies with raw markdown links, and nothing
 * downstream corrects them: `okf_write_page` stages the body verbatim, and
 * serialize.ts's link handling only covers the legacy `concept.links`/`##
 * Related` path. The 6.3 live dogfood proved the model gets these wrong at
 * scale — ~48% of body cross-links were broken, split between wrong relative
 * depth that escapes the bundle root and dangling links to pages that were
 * never synthesized. Per `feedback_structural_enforcement` /
 * `feedback_tool_gates_over_self_checks`, the fix is deterministic code the
 * model can't fool, not a better prompt.
 *
 * This is a PURE format-core module (node:path only) — bundle.ts calls it at
 * finalize, over the full content-doc set, so the WRITTEN and fingerprinted
 * content is the normalized content.
 */

/** Any URL scheme prefix (http:, https:, mailto:, tel:, ...) — never a bundle-relative link. Mirrors validate.ts / OkfDocumentView. */
const EXTERNAL_LINK_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Markdown inline links `[label](target)`. Mirrors validate.ts's
 * `MARKDOWN_LINK_PATTERN`, but also captures the label so a dead link can be
 * downgraded to its plain-text label. `[^\]]*` / `[^)]+` keep it linear-time
 * and consistent with the validator's scan; nested brackets and titled
 * `(url "title")` targets are out of scope for both (the latter is left
 * untouched below via the whitespace guard).
 */
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(([^)]+)\)/g;

export interface NormalizeBodyLinksResult {
  /** The body with in-bundle `.md` links canonicalized and dead links downgraded. */
  body: string;
  /** Original targets that resolved to no bundle page and were downgraded to plain text. */
  deadTargets: string[];
}

/**
 * Resolve a link's path portion (fragment already stripped) to a canonical
 * bundle-relative path (no leading slash). A relative target resolves against
 * `fromPath`'s own directory; an absolute ("/"-rooted) target resolves against
 * the bundle root. A `..` that would escape the root clamps to the root —
 * matching `OkfDocumentView.resolveInAppTarget`'s pop-on-empty posture so the
 * in-app navigator and this normalization always agree on where a link points.
 */
function resolveBundlePath(pathPart: string, fromPath: string): string {
  const absolute = pathPart.startsWith('/');
  const fromDir = !absolute && fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const segments = fromDir === '' ? [] : fromDir.split('/');
  for (const piece of pathPart.split('/')) {
    if (piece === '' || piece === '.') continue;
    if (piece === '..') segments.pop();
    else segments.push(piece);
  }
  return segments.join('/');
}

/**
 * Normalize the body cross-links of one OKF page. For each markdown link whose
 * target is a bundle-internal `.md` reference (relative or absolute; external
 * `scheme:` targets, pure `#anchor`s, and non-`.md` targets are left verbatim):
 *
 *  - resolve it against `fromPath` to a canonical bundle path;
 *  - if that path IS a real page (`pages`), rewrite the link to the ABSOLUTE
 *    bundle-relative form `/canonical.md` (Task 1.2), preserving any `#fragment`;
 *  - if NOT, downgrade the link to its plain-text label — the reader keeps the
 *    label instead of a 404 (`feedback_data_preservation`) — and record the
 *    original target so the caller can warn.
 *
 * Idempotent by construction: a rewritten absolute link re-resolves to itself,
 * and a downgraded link is plain text with no `](...)` left to match. Re-running
 * over already-normalized content is a byte-for-byte no-op, so it never perturbs
 * the ownership fingerprint of a carried-forward unchanged page.
 */
export function normalizeBodyLinks(
  body: string,
  fromPath: string,
  pages: ReadonlySet<string>,
): NormalizeBodyLinksResult {
  const deadTargets: string[] = [];
  const normalized = body.replace(
    MARKDOWN_LINK_PATTERN,
    (whole: string, label: string, target: string, offset: number, source: string): string => {
      // An image (`![alt](src)`) is not a page cross-link — leave it untouched.
      if (offset > 0 && source[offset - 1] === '!') return whole;
      const trimmed = target.trim();
      // Empty, same-doc anchor, or external scheme → not a bundle page link.
      if (trimmed === '' || trimmed.startsWith('#') || EXTERNAL_LINK_SCHEME_PATTERN.test(trimmed)) return whole;
      // A target carrying whitespace is a titled `(url "title")` form or is
      // malformed — the synthesis links this pass fixes are always bare targets.
      if (/\s/.test(trimmed)) return whole;
      const hashIndex = trimmed.indexOf('#');
      const pathPart = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? '' : trimmed.slice(hashIndex);
      // Only bundle-internal `.md` links are in scope; asset/extensionless links stay.
      if (!pathPart.endsWith('.md')) return whole;
      const canonical = resolveBundlePath(pathPart, fromPath);
      if (pages.has(canonical)) {
        return `[${label}](/${canonical}${fragment})`;
      }
      deadTargets.push(trimmed);
      return label;
    },
  );
  return { body: normalized, deadTargets };
}
