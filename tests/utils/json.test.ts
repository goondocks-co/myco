import { describe, it, expect } from 'vitest';
import { tryParseJson } from '@myco/utils/json.js';

describe('tryParseJson', () => {
  it('parses a valid JSON object', () => {
    expect(tryParseJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('parses a valid JSON array', () => {
    expect(tryParseJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('parses a valid JSON primitive', () => {
    expect(tryParseJson('true')).toBe(true);
    expect(tryParseJson('42')).toBe(42);
    expect(tryParseJson('"hello"')).toBe('hello');
  });

  it('returns null for invalid JSON', () => {
    expect(tryParseJson('{not json}')).toBeNull();
    expect(tryParseJson('undefined')).toBeNull();
    expect(tryParseJson('{')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(tryParseJson('')).toBeNull();
  });

  it('returns null for non-string inputs', () => {
    expect(tryParseJson(null)).toBeNull();
    expect(tryParseJson(undefined)).toBeNull();
    expect(tryParseJson(123)).toBeNull();
    expect(tryParseJson({ already: 'parsed' })).toBeNull();
    expect(tryParseJson([])).toBeNull();
  });

  it('narrows via generic type parameter when caller specifies a type', () => {
    interface Shape { foo: number }
    const parsed = tryParseJson<Shape>('{"foo":7}');
    // If parsed is non-null, TS treats it as Shape — runtime-check the value
    expect(parsed?.foo).toBe(7);
  });
});
