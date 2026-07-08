/**
 * Unit coverage for the deterministic body cross-link normalization pass
 * (Task 7.5). The 6.3 dogfood published a wiki whose model-authored body links
 * were ~48% broken — wrong relative depth that escaped the bundle, and dangling
 * links to pages that were never synthesized. `normalizeBodyLinks` is the
 * structural fix (`feedback_structural_enforcement`): it resolves every
 * bundle-internal `.md` link to the canonical ABSOLUTE bundle-relative form
 * when the target is a real page, and downgrades a dead link to plain text so
 * the reader gets the label, never a 404.
 *
 * Idempotency is load-bearing: the published (normalized) content is what
 * ownership fingerprints, so re-normalizing an unchanged page on a later run
 * MUST be byte-identical or a carried-forward page would look hand-edited.
 */

import { describe, expect, it } from 'bun:test';
import { normalizeBodyLinks } from '@myco/okf/links.js';

/** The pages a link may resolve to in these cases — canonical bundle-relative paths (with `.md`). */
const PAGES = new Set(['concepts/alpha.md', 'concepts/beta.md', 'concepts/spores.md', 'glossary.md']);

describe('normalizeBodyLinks', () => {
  it('(a) rewrites a wrong-depth relative link from a root page to a resolving absolute link', () => {
    // The exact dogfood failure: a root-level page linked ../concepts/... which
    // resolves OUTSIDE the bundle; the `..` clamps to root and resolves.
    const { body, deadTargets } = normalizeBodyLinks(
      'See [Spores](../concepts/spores.md) for details.',
      'glossary.md',
      PAGES,
    );
    expect(body).toBe('See [Spores](/concepts/spores.md) for details.');
    expect(deadTargets).toEqual([]);
  });

  it('(b) rewrites a root-relative `concepts/x.md` link to `/concepts/x.md`', () => {
    const { body } = normalizeBodyLinks('[Alpha](concepts/alpha.md)', 'glossary.md', PAGES);
    expect(body).toBe('[Alpha](/concepts/alpha.md)');
  });

  it('(c) downgrades a dead link to plain text and reports it as a warning target', () => {
    // The real page is `lineage-graph.md`; a link to `lineage.md` is dangling.
    const { body, deadTargets } = normalizeBodyLinks(
      'See [Lineage](../concepts/lineage.md) and [Alpha](../concepts/alpha.md).',
      'glossary.md',
      PAGES,
    );
    expect(body).toBe('See Lineage and [Alpha](/concepts/alpha.md).');
    expect(deadTargets).toEqual(['../concepts/lineage.md']);
  });

  it('(d) leaves external, anchor, and non-`.md` links untouched', () => {
    const input =
      'A [site](https://example.com), a [mail](mailto:x@y.z), an [anchor](#section), ' +
      'an [image](./diagram.png), and an [extensionless](../concepts/alpha).';
    const { body, deadTargets } = normalizeBodyLinks(input, 'glossary.md', PAGES);
    expect(body).toBe(input);
    expect(deadTargets).toEqual([]);
  });

  it('(d2) never rewrites an image link even when it points at a real `.md` page', () => {
    const input = '![diagram](/concepts/alpha.md)';
    expect(normalizeBodyLinks(input, 'glossary.md', PAGES).body).toBe(input);
  });

  it('(e) preserves a `#fragment` on a resolved link (absolute and relative forms)', () => {
    expect(normalizeBodyLinks('[X](/concepts/alpha.md#usage)', 'glossary.md', PAGES).body).toBe(
      '[X](/concepts/alpha.md#usage)',
    );
    expect(normalizeBodyLinks('[X](../concepts/alpha.md#usage)', 'glossary.md', PAGES).body).toBe(
      '[X](/concepts/alpha.md#usage)',
    );
  });

  it('resolves a sibling relative link from a nested page', () => {
    const { body } = normalizeBodyLinks('[Beta](beta.md)', 'concepts/alpha.md', PAGES);
    expect(body).toBe('[Beta](/concepts/beta.md)');
  });

  it('clamps a `..` chain that escapes the bundle root instead of escaping it', () => {
    // Matches OkfDocumentView.resolveInAppTarget's pop-on-empty posture.
    expect(normalizeBodyLinks('[A](../../../concepts/alpha.md)', 'glossary.md', PAGES).body).toBe(
      '[A](/concepts/alpha.md)',
    );
    expect(normalizeBodyLinks('[A](../../concepts/alpha.md)', 'concepts/deep/x.md', PAGES).body).toBe(
      '[A](/concepts/alpha.md)',
    );
  });

  it('leaves an already-absolute resolving link byte-identical', () => {
    const input = 'Prose with [Alpha](/concepts/alpha.md) inline.';
    expect(normalizeBodyLinks(input, 'concepts/beta.md', PAGES).body).toBe(input);
  });

  it('(f) is idempotent: normalize(normalize(body)) === normalize(body)', () => {
    const input =
      'From root: [Spores](../concepts/spores.md), [Beta](concepts/beta.md#x), ' +
      'a dead [Ghost](../concepts/ghost.md), an [ext](https://example.com), and an [anchor](#top).';
    const once = normalizeBodyLinks(input, 'glossary.md', PAGES).body;
    const twice = normalizeBodyLinks(once, 'glossary.md', PAGES).body;
    expect(twice).toBe(once);
    // And the once-normalized form has no dangling relative `.md` bundle link left.
    expect(once).toContain('[Spores](/concepts/spores.md)');
    expect(once).toContain('[Beta](/concepts/beta.md#x)');
    expect(once).toContain('a dead Ghost,');
  });
});
