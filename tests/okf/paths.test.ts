import { describe, expect, it } from 'bun:test';
import {
  assertSafeConceptId,
  bundleLink,
  conceptPathForId,
  detectCollisions,
  okfSlug,
  OkfPathError,
} from '@myco/okf/paths.js';

describe('okfSlug', () => {
  it('lowercases and underscores spaces and punctuation', () => {
    expect(okfSlug('Grove Architecture!')).toBe('grove_architecture');
  });

  it('collapses a run of punctuation/whitespace to a single underscore', () => {
    expect(okfSlug('Hello,   World???')).toBe('hello_world');
  });

  it('never starts with - or .', () => {
    expect(okfSlug('.hidden')).toBe('hidden');
    expect(okfSlug('-leading-hyphen')).toBe('leading-hyphen');
    expect(okfSlug('.hidden')[0]).not.toBe('.');
    expect(okfSlug('-leading-hyphen')[0]).not.toBe('-');
  });

  it('always matches the segment charset', () => {
    for (const input of ['Grove Architecture!', '.hidden', '-x', 'café', '!!!', '', '   ']) {
      expect(okfSlug(input)).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
    }
  });

  it('falls back to a single underscore when the input slugifies to nothing', () => {
    expect(okfSlug('')).toBe('_');
    expect(okfSlug('!!!')).toBe('_');
    expect(okfSlug('...')).toBe('_');
  });

  it('drops diacritics so accented and unaccented spellings agree', () => {
    expect(okfSlug('café')).toBe('cafe');
  });

  it('slugifies NFC- and NFD-composed spellings of the same title identically', () => {
    const nfc = 'caf\u00e9'; // pre-composed \u00e9 (single code point)
    const nfd = 'cafe\u0301'; // e + combining acute accent U+0301 (two code points)
    expect(nfc).not.toBe(nfd); // sanity: genuinely different code unit sequences
    expect(okfSlug(nfc)).toBe(okfSlug(nfd));
  });

  it('preserves already-safe text unchanged (aside from case)', () => {
    expect(okfSlug('decision-abcd1234_v2.ts')).toBe('decision-abcd1234_v2.ts');
  });
});

describe('bundleLink', () => {
  it('root-anchors a bundle-relative path with a leading /', () => {
    expect(bundleLink('a/c/d.md')).toBe('/a/c/d.md');
    expect(bundleLink('x/y.md')).toBe('/x/y.md');
  });

  it('is root-anchored regardless of the source page depth (no from-relative computation)', () => {
    // bundleLink takes only the target — there is no `from` parameter to vary,
    // so a deeply nested source page links to the same absolute target.
    expect(bundleLink('architecture/overview.md')).toBe('/architecture/overview.md');
  });

  it('is idempotent for an already-absolute path', () => {
    expect(bundleLink('/a/c/d.md')).toBe('/a/c/d.md');
  });
});

describe('assertSafeConceptId', () => {
  it('rejects traversal segments', () => {
    expect(() => assertSafeConceptId('spores/../x')).toThrow(OkfPathError);
    expect(() => assertSafeConceptId('spores/../x')).toThrow(/path_traversal/);
    expect(() => assertSafeConceptId('spores/.')).toThrow(/path_traversal/);
  });

  it('rejects a leading slash', () => {
    expect(() => assertSafeConceptId('/etc/passwd')).toThrow(/path_traversal/);
  });

  it('rejects NUL bytes', () => {
    expect(() => assertSafeConceptId('spores/a\0b')).toThrow(/nul_byte/);
  });

  it('rejects backslashes', () => {
    expect(() => assertSafeConceptId('concepts\\..\\..\\x')).toThrow(/path_traversal|backslash/);
  });

  it('rejects empty segments', () => {
    expect(() => assertSafeConceptId('')).toThrow(/empty_segments/);
    expect(() => assertSafeConceptId('spores/')).toThrow(/empty_segment/);
  });

  it('rejects a segment outside the okfSlug charset', () => {
    expect(() => assertSafeConceptId('concepts/has space')).toThrow(OkfPathError);
    expect(() => assertSafeConceptId('concepts/has space')).toThrow(/invalid_segment/);
    expect(() => assertSafeConceptId('canopy/café')).toThrow(/invalid_segment/);
  });

  it('accepts ids built from okfSlug segments', () => {
    expect(() => assertSafeConceptId('spores/decisions/decision-abcd1234')).not.toThrow();
    expect(() => assertSafeConceptId(['spores', okfSlug('Grove Architecture!')].join('/'))).not.toThrow();
  });
});

describe('conceptPathForId', () => {
  it('appends .md to the id', () => {
    expect(conceptPathForId('spores/decisions/decision-abcd1234')).toBe(
      'spores/decisions/decision-abcd1234.md',
    );
  });

  it('gives repo-file concepts a compound extension', () => {
    expect(conceptPathForId('canopy/files/src/util.ts')).toBe('canopy/files/src/util.ts.md');
    expect(conceptPathForId('canopy/files/src/util.ts').endsWith('.ts.md')).toBe(true);
  });

  it('rejects an empty id', () => {
    expect(() => conceptPathForId('')).toThrow(OkfPathError);
  });

  it('rejects an id with a segment outside the okfSlug charset', () => {
    expect(() => conceptPathForId('concepts/has space')).toThrow(OkfPathError);
  });
});

describe('detectCollisions', () => {
  it('reports case-fold collisions', () => {
    expect(detectCollisions(['A/b', 'a/B'])).toEqual(['A/b', 'a/B']);
  });

  it('reports exact duplicates', () => {
    expect(detectCollisions(['a/b', 'c/d', 'a/b'])).toEqual(['a/b', 'a/b']);
  });

  it('returns empty for distinct ids', () => {
    expect(detectCollisions(['a/b', 'a/c', 'd'])).toEqual([]);
  });

  it('catches two titles that slug-collide', () => {
    const a = okfSlug('Grove Architecture');
    const b = okfSlug('GROVE ARCHITECTURE!!!');
    expect(a).toBe(b); // same slug, different source titles
    expect(detectCollisions([`concepts/${a}`, `concepts/${b}`])).toEqual([
      `concepts/${a}`,
      `concepts/${b}`,
    ]);
  });
});
