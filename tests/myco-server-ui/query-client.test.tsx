import { describe, expect, it } from 'bun:test';
import { ApiError, SignedOutError } from '../../packages/myco-server/ui/src/lib/api';
import { shouldRetry } from '../../packages/myco-server/ui/src/lib/query-client';
import { noProviderYet } from '../../packages/myco-server/ui/src/pages/ProjectHome';

describe('dashboard query retry', () => {
  it('never asks again after a 4xx — a missing session, a refusal, a signed-out visitor', () => {
    expect(shouldRetry(0, new ApiError(404, { error: 'not_found' }))).toBe(false);
    expect(shouldRetry(0, new ApiError(403, null))).toBe(false);
    expect(shouldRetry(0, new SignedOutError())).toBe(false);
  });

  it('asks twice more after a 5xx or a connection that never answered', () => {
    expect(shouldRetry(0, new ApiError(503, null))).toBe(true);
    expect(shouldRetry(1, new ApiError(503, null))).toBe(true);
    expect(shouldRetry(2, new ApiError(503, null))).toBe(false);
    expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(2, new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('home provider note', () => {
  const leaf = (over: Partial<{ configured: boolean; value: unknown }>) => [{ leaf: 'agent.provider.type', configured: true, value: 'anthropic', updatedAt: null, updatedBy: null, ...over }];

  it('is unknown until the leaves are read, and quiet once a provider is named', () => {
    expect(noProviderYet(undefined)).toBe(false);
    expect(noProviderYet(leaf({}))).toBe(false);
  });

  it('says why the panels are empty when Settings names no provider', () => {
    expect(noProviderYet([])).toBe(true);
    expect(noProviderYet(leaf({ configured: false, value: null }))).toBe(true);
    expect(noProviderYet(leaf({ value: '' }))).toBe(true);
  });
});
