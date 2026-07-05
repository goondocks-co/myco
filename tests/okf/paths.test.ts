import { describe, expect, it } from 'bun:test';
import {
  conceptPathForId,
  deriveConceptId,
  detectCollisions,
  encodePathSegment,
  OkfPathError,
} from '@myco/okf/paths.js';

describe('encodePathSegment', () => {
  it('passes safe characters through untouched', () => {
    expect(encodePathSegment('decision-abcd1234_v2.ts')).toBe('decision-abcd1234_v2.ts');
  });

  it('percent-encodes characters outside [A-Za-z0-9._-] as uppercase UTF-8 hex', () => {
    expect(encodePathSegment('a b')).toBe('a%20b');
    expect(encodePathSegment('#x')).toBe('%23x');
    expect(encodePathSegment('café')).toBe('caf%C3%A9');
  });

  it('encodes % itself so the encoding stays injective', () => {
    expect(encodePathSegment('50%')).toBe('50%25');
    expect(encodePathSegment('50%25')).not.toBe(encodePathSegment('50%'));
  });

  it('preserves case', () => {
    expect(encodePathSegment('MyFile.TS')).toBe('MyFile.TS');
  });
});

describe('deriveConceptId', () => {
  it('joins simple segments', () => {
    expect(deriveConceptId(['spores', 'decisions', 'decision-abcd1234'])).toBe(
      'spores/decisions/decision-abcd1234',
    );
  });

  it('encodes unsafe characters in repo paths deterministically', () => {
    const id = deriveConceptId(['canopy', 'files', 'packages/a b/#x.ts']);
    expect(id).toBe('canopy/files/packages/a%20b/%23x.ts');
    expect(deriveConceptId(['canopy', 'files', 'packages/a b/#x.ts'])).toBe(id);
  });

  it('keeps distinct inputs distinct (no silent character drops)', () => {
    expect(deriveConceptId(['files', 'a b.ts'])).not.toBe(deriveConceptId(['files', 'a_b.ts']));
    expect(deriveConceptId(['files', 'a%20b.ts'])).not.toBe(deriveConceptId(['files', 'a b.ts']));
  });

  it('normalizes backslash separators and strips a leading slash', () => {
    expect(deriveConceptId(['canopy', 'files', '/src\\lib\\util.ts'])).toBe('canopy/files/src/lib/util.ts');
  });

  it('rejects traversal segments', () => {
    expect(() => deriveConceptId(['spores', '..', 'x'])).toThrow(OkfPathError);
    expect(() => deriveConceptId(['spores', '../x'])).toThrow(/path_traversal/);
    expect(() => deriveConceptId(['spores', '.'])).toThrow(/path_traversal/);
  });

  it('rejects empty segments', () => {
    expect(() => deriveConceptId([])).toThrow(/empty_segments/);
    expect(() => deriveConceptId(['spores', ''])).toThrow(/empty_segment/);
    expect(() => deriveConceptId(['spores', 'a//b'])).toThrow(/empty_segment/);
    expect(() => deriveConceptId(['/'])).toThrow(/empty_segment/);
  });

  it('rejects NUL bytes', () => {
    expect(() => deriveConceptId(['spores', 'a\0b'])).toThrow(/nul_byte/);
  });
});

describe('conceptPathForId', () => {
  it('appends .md to the id', () => {
    expect(conceptPathForId('spores/decisions/decision-abcd1234')).toBe(
      'spores/decisions/decision-abcd1234.md',
    );
  });

  it('gives repo-file concepts a compound extension', () => {
    const id = deriveConceptId(['canopy', 'files', 'src/util.ts']);
    expect(conceptPathForId(id)).toBe('canopy/files/src/util.ts.md');
    expect(conceptPathForId(id).endsWith('.ts.md')).toBe(true);
  });

  it('rejects an empty id', () => {
    expect(() => conceptPathForId('')).toThrow(OkfPathError);
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
});
