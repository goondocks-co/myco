/**
 * How a refused GitHub read is named: a rate limit by any of GitHub's signals, and a rejected App token otherwise.
 */
import { describe, expect, it } from 'bun:test';
import { githubReads, type GithubFailure } from '@myco-server-worker/core/github-refs.js';

const SECONDARY_LIMIT_BODY = JSON.stringify({
  message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
  documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits',
});

const REFUSALS: Array<{ name: string; status: number; headers?: Record<string, string>; body?: string; failure: GithubFailure }> = [
  { name: '403 with x-ratelimit-remaining: 0', status: 403, headers: { 'x-ratelimit-remaining': '0' }, failure: 'rate_limited' },
  { name: '403 with retry-after', status: 403, headers: { 'retry-after': '60' }, failure: 'rate_limited' },
  { name: '403 with the secondary rate limit message', status: 403, body: SECONDARY_LIMIT_BODY, failure: 'rate_limited' },
  { name: 'bare 403', status: 403, body: JSON.stringify({ message: 'Forbidden' }), failure: 'credential_rejected' },
  { name: '429', status: 429, failure: 'rate_limited' },
  { name: '401', status: 401, failure: 'credential_rejected' },
];

describe('a refused GitHub read', () => {
  for (const refusal of REFUSALS) {
    it(`names a ${refusal.name} ${refusal.failure}`, async () => {
      const fetcher = (async () => new Response(refusal.body ?? '{}', { status: refusal.status, headers: refusal.headers })) as unknown as typeof fetch;
      expect(await githubReads({ repositoryId: 1, token: 'fixture-token', maxLookups: 1, fetcher }).repository())
        .toEqual({ ok: false, failure: refusal.failure, status: refusal.status });
    });
  }
});
