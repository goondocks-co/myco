import { describe, it, expect } from 'bun:test';
import { deepMerge, isPlainObject } from '@myco/utils/deep-merge';

describe('deepMerge', () => {
  it('merges nested objects at the leaf', () => {
    const target = { a: { x: 1, y: 2 } };
    const source = { a: { y: 20, z: 30 } };
    expect(deepMerge(target, source, { arrayStrategy: 'replace' })).toEqual({ a: { x: 1, y: 20, z: 30 } });
  });

  it('source overwrites primitives and nulls', () => {
    expect(deepMerge({ a: 1, b: null }, { a: 2, b: 'ok' } as any, { arrayStrategy: 'replace' })).toEqual({ a: 2, b: 'ok' });
  });

  it('skips undefined values in source', () => {
    expect(deepMerge({ a: 1 }, { a: undefined as any }, { arrayStrategy: 'replace' })).toEqual({ a: 1 });
  });

  it('arrayStrategy=replace overwrites arrays', () => {
    expect(deepMerge({ xs: [1, 2] }, { xs: [3] }, { arrayStrategy: 'replace' })).toEqual({ xs: [3] });
  });

  it('arrayStrategy=union concatenates and dedupes arrays', () => {
    expect(deepMerge({ xs: [1, 2] }, { xs: [2, 3] }, { arrayStrategy: 'union' })).toEqual({ xs: [1, 2, 3] });
  });

  it('treats null differently from object to avoid typeof-null bug', () => {
    expect(deepMerge({ a: { x: 1 } }, { a: null as any }, { arrayStrategy: 'replace' })).toEqual({ a: null });
    expect(deepMerge({ a: null as any }, { a: { x: 1 } }, { arrayStrategy: 'replace' })).toEqual({ a: { x: 1 } });
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
