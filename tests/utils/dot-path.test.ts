import { describe, it, expect } from 'bun:test';
import { getAtPath, setAtPath, unsetAtPath } from '@myco/utils/dot-path';

describe('getAtPath', () => {
  it('returns the leaf when the path exists', () => {
    expect(getAtPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined when any segment is missing', () => {
    expect(getAtPath({ a: { b: {} } }, 'a.b.c')).toBeUndefined();
    expect(getAtPath({}, 'a.b.c')).toBeUndefined();
  });

  it('returns undefined when a segment descends into a non-object', () => {
    expect(getAtPath({ a: 'string' }, 'a.b')).toBeUndefined();
    expect(getAtPath({ a: null }, 'a.b')).toBeUndefined();
    expect(getAtPath({ a: [1, 2] }, 'a.b')).toBeUndefined();
  });
});

describe('setAtPath', () => {
  it('sets a leaf on an existing path', () => {
    const obj: Record<string, unknown> = { a: { b: 1 } };
    setAtPath(obj, 'a.b', 2);
    expect(obj).toEqual({ a: { b: 2 } });
  });

  it('creates intermediate objects when they do not exist', () => {
    const obj: Record<string, unknown> = {};
    setAtPath(obj, 'a.b.c', 42);
    expect(obj).toEqual({ a: { b: { c: 42 } } });
  });

  it('overwrites non-object intermediates with an object', () => {
    const obj: Record<string, unknown> = { a: 'string', b: null, c: [1, 2] };
    setAtPath(obj, 'a.x', 1);
    setAtPath(obj, 'b.x', 2);
    setAtPath(obj, 'c.x', 3);
    expect(obj).toEqual({ a: { x: 1 }, b: { x: 2 }, c: { x: 3 } });
  });
});

describe('unsetAtPath', () => {
  it('removes the leaf and returns true', () => {
    const obj: Record<string, unknown> = { a: { b: 1, c: 2 } };
    expect(unsetAtPath(obj, 'a.b')).toBe(true);
    expect(obj).toEqual({ a: { c: 2 } });
  });

  it('returns false and is a no-op when the leaf does not exist', () => {
    const obj: Record<string, unknown> = { a: { b: 1 } };
    expect(unsetAtPath(obj, 'a.c')).toBe(false);
    expect(obj).toEqual({ a: { b: 1 } });
  });

  it('returns false and is a no-op when an intermediate path is missing', () => {
    const obj: Record<string, unknown> = { a: { b: 1 } };
    expect(unsetAtPath(obj, 'x.y.z')).toBe(false);
    expect(obj).toEqual({ a: { b: 1 } });
  });

  it('does not descend through non-object intermediates', () => {
    const obj: Record<string, unknown> = { a: 'string' };
    expect(unsetAtPath(obj, 'a.b')).toBe(false);
    expect(obj).toEqual({ a: 'string' });
  });
});
