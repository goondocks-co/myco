import { describe, expect, test } from 'bun:test';
import { stampSporeCountInPayload } from './types.js';

describe('stampSporeCountInPayload', () => {
  test('replaces spores_created when present with a different value', () => {
    const result = stampSporeCountInPayload({ spores_created: 3, other: 'x' }, 7);
    expect(result).toEqual({ spores_created: 7, other: 'x' });
  });

  test('returns the same reference when spores_created already equals count', () => {
    const payload = { spores_created: 7 };
    const result = stampSporeCountInPayload(payload, 7);
    expect(result).toBe(payload);
  });

  test('returns the input unchanged when spores_created is absent', () => {
    const payload = { other: 'x' };
    const result = stampSporeCountInPayload(payload, 7);
    expect(result).toBe(payload);
  });

  test('returns non-object payloads unchanged', () => {
    expect(stampSporeCountInPayload('a string', 7)).toBe('a string');
    expect(stampSporeCountInPayload(42, 7)).toBe(42);
    expect(stampSporeCountInPayload(null, 7)).toBe(null);
    expect(stampSporeCountInPayload(undefined, 7)).toBe(undefined);
  });

  test('returns array payloads unchanged', () => {
    const payload = [1, 2, 3];
    expect(stampSporeCountInPayload(payload, 7)).toBe(payload);
  });
});
