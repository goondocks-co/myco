import { describe, it, expect } from 'bun:test';
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

  it('narrows via validator predicate when caller supplies one', () => {
    interface Shape { foo: number }
    const isShape = (v: unknown): v is Shape =>
      typeof v === 'object' && v !== null && typeof (v as Shape).foo === 'number';
    const parsed = tryParseJson('{"foo":7}', isShape);
    expect(parsed?.foo).toBe(7);
  });

  it('returns null when the validator rejects the parsed value', () => {
    interface Shape { foo: number }
    const isShape = (v: unknown): v is Shape =>
      typeof v === 'object' && v !== null && typeof (v as Shape).foo === 'number';
    expect(tryParseJson('{"foo":"not-a-number"}', isShape)).toBeNull();
  });
});
