import { describe, expect, test } from 'bun:test';
import { safePathSegment } from '@myco/capture/diagnostics/safe-path.js';
import { sha256Hex } from '@myco/capture/diagnostics/hash.js';

describe('safePathSegment', () => {
  test('clean id passes through unchanged', () => {
    const result = safePathSegment('s1-abc_DEF.123');
    expect(result).toEqual({ segment: 's1-abc_DEF.123', sanitized: false });
  });

  test('a traversal-shaped id is sanitized', () => {
    const result = safePathSegment('../evil');
    expect(result.sanitized).toBe(true);
    expect(result.segment).toBe(`unsafe-${sha256Hex('../evil').slice(0, 16)}`);
    expect(result.segment.includes('/')).toBe(false);
    expect(result.segment.includes('..')).toBe(false);
  });

  test('"." is sanitized even though it matches the character class', () => {
    const result = safePathSegment('.');
    expect(result.sanitized).toBe(true);
    expect(result.segment).toBe(`unsafe-${sha256Hex('.').slice(0, 16)}`);
  });

  test('".." is sanitized even though it matches the character class', () => {
    const result = safePathSegment('..');
    expect(result.sanitized).toBe(true);
    expect(result.segment).toBe(`unsafe-${sha256Hex('..').slice(0, 16)}`);
  });

  test('an id longer than 128 chars is sanitized', () => {
    const longId = 'a'.repeat(200);
    const result = safePathSegment(longId);
    expect(result.sanitized).toBe(true);
    expect(result.segment).toBe(`unsafe-${sha256Hex(longId).slice(0, 16)}`);
  });
});
