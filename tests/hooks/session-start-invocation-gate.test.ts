import { describe, it, expect } from 'bun:test';
import { isNonFirstAntigravityInvocation } from '@myco/hooks/session-start.js';

describe('isNonFirstAntigravityInvocation', () => {
  it('returns true when invocationNum is a positive number', () => {
    expect(isNonFirstAntigravityInvocation({ invocationNum: 1 })).toBe(true);
    expect(isNonFirstAntigravityInvocation({ invocationNum: 7 })).toBe(true);
  });

  it('returns false when invocationNum is 0 (the first execution)', () => {
    expect(isNonFirstAntigravityInvocation({ invocationNum: 0 })).toBe(false);
  });

  it('returns false when the field is absent (non-AGY symbionts)', () => {
    expect(isNonFirstAntigravityInvocation({})).toBe(false);
    expect(isNonFirstAntigravityInvocation({ session_id: 'x' })).toBe(false);
  });

  it('returns false for non-number values (defensive against malformed payloads)', () => {
    expect(isNonFirstAntigravityInvocation({ invocationNum: '1' })).toBe(false);
    expect(isNonFirstAntigravityInvocation({ invocationNum: null })).toBe(false);
    expect(isNonFirstAntigravityInvocation({ invocationNum: undefined })).toBe(false);
  });
});
