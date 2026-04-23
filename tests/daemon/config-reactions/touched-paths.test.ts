import { describe, it, expect } from 'bun:test';
import { computeTouchedPaths, enumerateLeafPaths } from '@myco/daemon/config-reactions/touched-paths.js';

describe('enumerateLeafPaths', () => {
  it('emits leaves for nested object', () => {
    expect(enumerateLeafPaths({ capture: { plan_dirs: ['a'] } })).toEqual(['capture.plan_dirs']);
  });

  it('emits multiple leaves under one key', () => {
    expect(enumerateLeafPaths({ a: { b: 1, c: 2 } }).sort()).toEqual(['a.b', 'a.c']);
  });

  it('treats arrays and null as leaves', () => {
    expect(enumerateLeafPaths({ a: [1, 2], b: null }).sort()).toEqual(['a', 'b']);
  });

  it('emits nothing for empty object', () => {
    expect(enumerateLeafPaths({})).toEqual([]);
  });

  it('emits nothing for empty nested object', () => {
    expect(enumerateLeafPaths({ a: {} })).toEqual([]);
  });
});

describe('computeTouchedPaths', () => {
  it('unions patch leaves with clear entries', () => {
    const result = computeTouchedPaths({ capture: { plan_dirs: [] } }, ['agent.provider']);
    expect(result.sort()).toEqual(['agent.provider', 'capture.plan_dirs']);
  });

  it('deduplicates', () => {
    const result = computeTouchedPaths({ a: { b: 1 } }, ['a.b']);
    expect(result).toEqual(['a.b']);
  });

  it('accepts missing patch or clear', () => {
    expect(computeTouchedPaths(undefined, ['a'])).toEqual(['a']);
    expect(computeTouchedPaths({ a: 1 }, undefined)).toEqual(['a']);
    expect(computeTouchedPaths(undefined, undefined)).toEqual([]);
  });
});
