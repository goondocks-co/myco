import { describe, it, expect, beforeEach } from 'bun:test';
import {
  recordPendingInjection,
  consumePendingInjection,
  _resetPendingInjections,
  _pendingSize,
} from '@myco/canopy/inject/pending';

describe('pending-injection registry', () => {
  beforeEach(() => _resetPendingInjections());

  it('records and consumes a pending injection', () => {
    recordPendingInjection('s1', 'src/foo.ts', 42);
    expect(consumePendingInjection('s1', 'src/foo.ts')).toBe(42);
  });

  it('returns null for an unknown (session, path) pair', () => {
    expect(consumePendingInjection('s1', 'src/foo.ts')).toBeNull();
  });

  it('consume is one-shot (second consume returns null)', () => {
    recordPendingInjection('s1', 'src/foo.ts', 42);
    expect(consumePendingInjection('s1', 'src/foo.ts')).toBe(42);
    expect(consumePendingInjection('s1', 'src/foo.ts')).toBeNull();
  });

  it('isolates entries by sessionId', () => {
    recordPendingInjection('s1', 'src/foo.ts', 10);
    recordPendingInjection('s2', 'src/foo.ts', 20);
    expect(consumePendingInjection('s1', 'src/foo.ts')).toBe(10);
    expect(consumePendingInjection('s2', 'src/foo.ts')).toBe(20);
  });

  it('isolates entries by filePath', () => {
    recordPendingInjection('s1', 'a.ts', 10);
    recordPendingInjection('s1', 'b.ts', 20);
    expect(consumePendingInjection('s1', 'a.ts')).toBe(10);
    expect(consumePendingInjection('s1', 'b.ts')).toBe(20);
  });

  it('overwrites prior entry for the same key', () => {
    recordPendingInjection('s1', 'src/foo.ts', 10);
    recordPendingInjection('s1', 'src/foo.ts', 20);
    expect(consumePendingInjection('s1', 'src/foo.ts')).toBe(20);
  });

  it('expires entries past the TTL', () => {
    const t0 = 1_000_000;
    recordPendingInjection('s1', 'src/foo.ts', 42, t0);
    expect(consumePendingInjection('s1', 'src/foo.ts', t0 + 60_001)).toBeNull();
  });

  it('honors entries within the TTL', () => {
    const t0 = 1_000_000;
    recordPendingInjection('s1', 'src/foo.ts', 42, t0);
    expect(consumePendingInjection('s1', 'src/foo.ts', t0 + 1_000)).toBe(42);
  });

  it('removes the entry on consume even when expired', () => {
    const t0 = 1_000_000;
    recordPendingInjection('s1', 'src/foo.ts', 42, t0);
    expect(_pendingSize()).toBe(1);
    consumePendingInjection('s1', 'src/foo.ts', t0 + 60_001);
    expect(_pendingSize()).toBe(0);
  });
});
