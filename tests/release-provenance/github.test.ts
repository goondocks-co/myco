import { describe, expect, it } from 'bun:test';
import { findSquashMergeForCommit, readGithubToken } from '@myco/release-provenance/github.js';

describe('readGithubToken', () => {
  it('returns null when repo is empty', () => {
    expect(readGithubToken({ repo: '', token_env: 'GITHUB_TOKEN', max_lookups_per_run: 20 })).toBeNull();
  });

  it('returns null when env var is unset', () => {
    const envName = 'MYCO_TEST_GITHUB_TOKEN_NEVER_SET';
    delete process.env[envName];
    expect(readGithubToken({ repo: 'goondocks/myco', token_env: envName, max_lookups_per_run: 20 })).toBeNull();
  });

  it('returns the env var value when set', () => {
    const envName = 'MYCO_TEST_GITHUB_TOKEN_FIXTURE';
    process.env[envName] = 'gh-fixture-value';
    try {
      expect(readGithubToken({ repo: 'goondocks/myco', token_env: envName, max_lookups_per_run: 20 })).toBe('gh-fixture-value');
    } finally {
      delete process.env[envName];
    }
  });
});

describe('findSquashMergeForCommit', () => {
  it('returns null when repo is empty', async () => {
    const result = await findSquashMergeForCommit('abc123', {
      repo: '',
      token: 'fake',
      fetcher: (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it('returns null when token is null', async () => {
    const result = await findSquashMergeForCommit('abc123', {
      repo: 'goondocks/myco',
      token: null,
      fetcher: (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it('returns the merge_commit_sha when a merged PR is found', async () => {
    const fetcher = async (url: string | URL) => {
      const href = url.toString();
      if (href.includes('/search/issues')) {
        return new Response(JSON.stringify({
          items: [{ number: 42, pull_request: { merged_at: '2025-01-01T00:00:00Z' } }],
        }), { status: 200 });
      }
      if (href.includes('/pulls/42')) {
        return new Response(JSON.stringify({
          number: 42,
          merged: true,
          merge_commit_sha: 'squash-sha',
        }), { status: 200 });
      }
      throw new Error(`unexpected url: ${href}`);
    };
    const result = await findSquashMergeForCommit('abc123', {
      repo: 'goondocks/myco',
      token: 'fake',
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result).toEqual({ number: 42, merge_commit_sha: 'squash-sha', merged: true });
  });

  it('returns null when GitHub responds non-200', async () => {
    const fetcher = async () => new Response('', { status: 401 });
    const result = await findSquashMergeForCommit('abc123', {
      repo: 'goondocks/myco',
      token: 'fake',
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it('does not throw on network errors', async () => {
    const fetcher = async () => { throw new Error('ECONNREFUSED'); };
    const result = await findSquashMergeForCommit('abc123', {
      repo: 'goondocks/myco',
      token: 'fake',
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });
});
