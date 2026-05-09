/**
 * Tests for the team-sync worker's bearer-token Authorization gate.
 *
 * The validation now hashes both the presented token and the configured
 * key with SHA-256 before deferring to `crypto.subtle.timingSafeEqual`,
 * so the comparison runs in constant time regardless of input length.
 * These tests verify the canonical accept/reject paths plus the helper.
 */

import { describe, it, expect } from 'bun:test';
import { timingSafeEqualString, validateAuth } from '@myco-team-worker/auth';

const env = { MYCO_TEAM_API_KEY: 'super-secret-team-key' };

describe('validateAuth', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const request = new Request('https://example.com/sync', { method: 'GET' });
    const response = await validateAuth(request, env);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    const body = await response!.json();
    expect(body).toEqual({ error: 'Missing Authorization header' });
  });

  it('returns 401 when bearer token is wrong', async () => {
    const request = new Request('https://example.com/sync', {
      method: 'GET',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    const response = await validateAuth(request, env);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    const body = await response!.json();
    expect(body).toEqual({ error: 'Invalid Team key' });
  });

  it('returns 401 when bearer token is wrong AND lengths differ', async () => {
    // Length-asymmetric inputs are the historical timing-leak shape.
    // The digest step normalizes both sides to 32 bytes before compare.
    const request = new Request('https://example.com/sync', {
      method: 'GET',
      headers: { Authorization: 'Bearer x' },
    });
    const response = await validateAuth(request, env);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
  });

  it('returns 401 when env key is empty (refuses any token)', async () => {
    const request = new Request('https://example.com/sync', {
      method: 'GET',
      headers: { Authorization: 'Bearer anything' },
    });
    const response = await validateAuth(request, { MYCO_TEAM_API_KEY: '' });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
  });

  it('returns null when bearer token matches', async () => {
    const request = new Request('https://example.com/sync', {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.MYCO_TEAM_API_KEY}` },
    });
    const response = await validateAuth(request, env);
    expect(response).toBeNull();
  });

  it('rejects an Authorization header without the Bearer prefix', async () => {
    const request = new Request('https://example.com/sync', {
      method: 'GET',
      headers: { Authorization: env.MYCO_TEAM_API_KEY },
    });
    const response = await validateAuth(request, env);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
  });
});

describe('timingSafeEqualString', () => {
  it('returns true for equal strings', async () => {
    expect(await timingSafeEqualString('hello', 'hello')).toBe(true);
  });

  it('returns false for distinct equal-length strings', async () => {
    expect(await timingSafeEqualString('hello', 'hellp')).toBe(false);
  });

  it('returns false for distinct different-length strings', async () => {
    // Inputs are normalized to 32-byte digests before compare, so
    // length mismatches do not short-circuit early — they must always
    // walk the full digest and still come back false.
    expect(await timingSafeEqualString('a', 'aaaaaaaaaaaaa')).toBe(false);
  });

  it('returns true for the empty-string self comparison', async () => {
    expect(await timingSafeEqualString('', '')).toBe(true);
  });
});
