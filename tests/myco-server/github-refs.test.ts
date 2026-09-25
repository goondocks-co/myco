/**
 * How a refused GitHub read is named: a rate limit by any of GitHub's signals,
 * a rejected credential only for a lookup with a token, and a refused lookup for one without.
 */
import { describe, expect, it } from 'bun:test';
import { githubReads, type GithubFailure } from '@myco-server-worker/core/github-refs.js';

const SECONDARY_LIMIT_BODY = JSON.stringify({
  message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
  documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits',
});
const FORBIDDEN_BODY = JSON.stringify({ message: 'Forbidden' });

interface Refusal { name: string; status: number; headers?: Record<string, string>; body?: string; withToken: GithubFailure; withoutToken: GithubFailure }

const REFUSALS: Refusal[] = [
  { name: '403 with x-ratelimit-remaining: 0', status: 403, headers: { 'x-ratelimit-remaining': '0' }, withToken: 'rate_limited', withoutToken: 'rate_limited' },
  { name: '403 with retry-after', status: 403, headers: { 'retry-after': '60' }, withToken: 'rate_limited', withoutToken: 'rate_limited' },
  { name: '403 with the secondary rate limit message', status: 403, body: SECONDARY_LIMIT_BODY, withToken: 'rate_limited', withoutToken: 'rate_limited' },
  { name: 'bare 403', status: 403, body: FORBIDDEN_BODY, withToken: 'credential_rejected', withoutToken: 'forbidden' },
  { name: '429', status: 429, withToken: 'rate_limited', withoutToken: 'rate_limited' },
  { name: '401', status: 401, withToken: 'credential_rejected', withoutToken: 'forbidden' },
];

const answering = (refusal: Refusal) => (async () => new Response(refusal.body ?? '{}', { status: refusal.status, headers: refusal.headers })) as unknown as typeof fetch;

async function failureOf(refusal: Refusal, token: string | null) {
  return githubReads({ repo: 'o/r', token, maxLookups: 1, fetcher: answering(refusal) }).repository();
}

describe('a refused GitHub read', () => {
  for (const refusal of REFUSALS) {
    it(`names a ${refusal.name} ${refusal.withToken} with a token and ${refusal.withoutToken} without one`, async () => {
      expect(await failureOf(refusal, 'fixture-token')).toEqual({ ok: false, failure: refusal.withToken, status: refusal.status });
      expect(await failureOf(refusal, null)).toEqual({ ok: false, failure: refusal.withoutToken, status: refusal.status });
    });
  }
});
