import { describe, it, expect } from 'bun:test';
import { deepMerge, isPlainObject } from '@myco/utils/deep-merge';

/**
 * `deepMerge` over bare records, which is the shape it walks. The exported
 * signature narrows `source` to a patch of the target for its config callers;
 * the cases here drive keys the target does not declare and values of another
 * type, which that narrowing refuses.
 */
const merge = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  options: Parameters<typeof deepMerge>[2],
): Record<string, unknown> => deepMerge(target, source, options);

describe('deepMerge', () => {
  it('merges nested objects at the leaf', () => {
    const target = { a: { x: 1, y: 2 } };
    const source = { a: { y: 20, z: 30 } };
    expect(merge(target, source, { arrayStrategy: 'replace' })).toEqual({ a: { x: 1, y: 20, z: 30 } });
  });

  it('source overwrites primitives and nulls', () => {
    expect(merge({ a: 1, b: null }, { a: 2, b: 'ok' }, { arrayStrategy: 'replace' })).toEqual({ a: 2, b: 'ok' });
  });

  it('skips undefined values in source', () => {
    expect(merge({ a: 1 }, { a: undefined }, { arrayStrategy: 'replace' })).toEqual({ a: 1 });
  });

  it('arrayStrategy=replace overwrites arrays', () => {
    expect(deepMerge({ xs: [1, 2] }, { xs: [3] }, { arrayStrategy: 'replace' })).toEqual({ xs: [3] });
  });

  it('arrayStrategy=union concatenates and dedupes arrays', () => {
    expect(deepMerge({ xs: [1, 2] }, { xs: [2, 3] }, { arrayStrategy: 'union' })).toEqual({ xs: [1, 2, 3] });
  });

  it('treats null differently from object to avoid typeof-null bug', () => {
    expect(merge({ a: { x: 1 } }, { a: null }, { arrayStrategy: 'replace' })).toEqual({ a: null });
    expect(merge({ a: null }, { a: { x: 1 } }, { arrayStrategy: 'replace' })).toEqual({ a: { x: 1 } });
  });

  it('isPlainObject rejects arrays, null, primitives', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(1)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
  });
});
