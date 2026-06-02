import { describe, it, expect } from 'bun:test';
import { enumerateLeafPaths } from '../../packages/myco/src/config/leaf-paths';

describe('enumerateLeafPaths', () => {
  it('walks nested objects to dotted leaves; arrays/null are leaves', () => {
    expect(enumerateLeafPaths({ a: { b: 1, c: [1, 2] }, d: null }).sort())
      .toEqual(['a.b', 'a.c', 'd']);
  });
});
