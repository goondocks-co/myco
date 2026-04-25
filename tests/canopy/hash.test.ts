import { describe, it, expect } from 'bun:test';
import { sha256Hex } from '@myco/canopy/hash';

describe('sha256Hex', () => {
  it('is deterministic for identical input', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
    expect(sha256Hex(Buffer.from('hello'))).toBe(sha256Hex('hello'));
  });

  it('differs for different content', () => {
    expect(sha256Hex('hello')).not.toBe(sha256Hex('Hello'));
  });

  it('returns a 64-char hex string', () => {
    expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});
