import { describe, it, expect } from 'vitest';
import { parseCsvList } from '@myco/utils/parse-csv-list.js';

describe('parseCsvList', () => {
  it('returns empty array for undefined', () => {
    expect(parseCsvList(undefined)).toEqual([]);
  });

  it('returns empty array for null', () => {
    expect(parseCsvList(null)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseCsvList('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(parseCsvList('   ,  , ')).toEqual([]);
  });

  it('splits a simple comma-separated list', () => {
    expect(parseCsvList('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('trims surrounding whitespace on each token', () => {
    expect(parseCsvList(' a , b , c ')).toEqual(['a', 'b', 'c']);
  });

  it('drops empty tokens (consecutive commas)', () => {
    expect(parseCsvList('a,,b,,,c')).toEqual(['a', 'b', 'c']);
  });

  it('returns a single-element array for a value with no commas', () => {
    expect(parseCsvList('lonely')).toEqual(['lonely']);
  });
});
