import { it, expect } from 'bun:test';
import { isPlainObject } from '@myco/utils/deep-merge';

it('isPlainObject rejects arrays, null, primitives', () => {
  expect(isPlainObject({})).toBe(true);
  expect(isPlainObject({ a: 1 })).toBe(true);
  expect(isPlainObject([])).toBe(false);
  expect(isPlainObject(null)).toBe(false);
  expect(isPlainObject(1)).toBe(false);
  expect(isPlainObject('x')).toBe(false);
});
