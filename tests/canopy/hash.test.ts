import { describe, it, expect } from 'bun:test';
import { sha256Hex, estimateTokens } from '@myco/canopy/hash';

describe('sha256Hex', () => {
  it('is deterministic for identical input', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
    expect(sha256Hex(Buffer.from('hello'))).toBe(sha256Hex('hello'));
  });

  it('differs for different content', () => {
    expect(sha256Hex('hello')).not.toBe(sha256Hex('Hello'));
  });

  it('returns a 64-char hex string', () => {
    const h = sha256Hex('anything');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('uses a 4-char-per-token heuristic with ceiling', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('is stable across re-scans for identical content', () => {
    const text = 'export function foo() { return 42; }';
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });
});
