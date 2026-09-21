/**
 * Release classification against a modelled GitHub: containment by compare,
 * squash-merged pull requests, the monorepo package map, and the rule that a
 * truncated listing or a failed read is never negative evidence.
 */
import { describe, expect, it } from 'bun:test';
import { githubReads, MAX_LISTED_REFS } from '@myco-server-worker/core/github-refs.js';
import {
  classifyCommit, memoizedCompare, newestPerLine, resolveRunRefs, MAX_RELEASE_LINES, type ReleaseRefConfig,
} from '@myco-server-worker/core/release-classify.js';

import { A, B, C, D, M, MISSING, REPO, X, fakeGithub, sha, type Repo } from './helpers/github-fake.js';

const CONFIG: ReleaseRefConfig = {
  productionRefs: ['refs/tags/a/v*', 'refs/tags/b/v*'],
  integrationRefs: ['origin/main'],
  packageMap: [{ pathGlob: 'packages/a/', tagPattern: 'refs/tags/a/v*' }, { pathGlob: 'packages/b/', tagPattern: 'refs/tags/b/v*' }],
};

async function classify(headSha: string | null, changedPaths: string[] = [], opts: { repo?: Repo; maxLookups?: number; fetcher?: typeof fetch; config?: ReleaseRefConfig } = {}) {
  const calls: string[] = [];
  const reads = githubReads({ repo: 'o/r', token: 'fixture-token', maxLookups: opts.maxLookups ?? 50, fetcher: opts.fetcher ?? fakeGithub(opts.repo ?? REPO, calls) });
  const run = await resolveRunRefs(reads, opts.config ?? CONFIG);
  const outcome = await classifyCommit(reads, memoizedCompare(reads), run, { headSha, changedPaths });
  return { outcome, calls, used: reads.lookupsUsed() };
}

const state = (o: Awaited<ReturnType<typeof classify>>['outcome']) => (o.kind === 'classified' ? o.classification.state : `unavailable:${o.failure}`);

describe('release classification', () => {
  it('is released when the newest tag of a line contains the commit', async () => {
    const { outcome } = await classify(A, ['packages/a/src/x.ts']);
    expect(outcome).toMatchObject({ kind: 'classified', classification: { state: 'released', confidence: 'high', basisKind: 'git_ancestry', basisRef: 'refs/tags/a/v1.2.0', basisSha: A } });
  });

  it('is merged_unreleased when only the integration branch contains it', async () => {
    const { outcome } = await classify(B);
    expect(outcome).toMatchObject({ kind: 'classified', classification: { state: 'merged_unreleased', basisKind: 'git_ancestry', basisRef: 'main' } });
  });

  it('follows a squash-merged pull request to its merge commit', async () => {
    const { outcome } = await classify(C);
    expect(outcome).toMatchObject({ kind: 'classified', classification: { state: 'released', basisKind: 'github_pr_squash', basisSha: M, releasePrNumber: 7 } });
  });

  it('checks a monorepo package only against its own tag family', async () => {
    const onlyB = await classify(X, ['packages/b/y.ts']);
    expect(state(onlyB.outcome)).toBe('released');
    expect(onlyB.calls.filter((c) => c.startsWith('/compare')).some((c) => c.includes('refs/tags/a/'))).toBe(false);
    const wrongPackage = await classify(X, ['packages/a/y.ts']);
    expect(state(wrongPackage.outcome)).toBe('not_on_release_line');
  });

  it('is not_on_release_line only after every ref was listed and checked', async () => {
    expect(state((await classify(D)).outcome)).toBe('not_on_release_line');
  });

  it('is unknown when the commit is not on GitHub', async () => {
    const { outcome } = await classify(MISSING);
    expect(outcome).toMatchObject({ kind: 'classified', classification: { state: 'unknown', basisKind: 'missing_git_evidence' } });
  });

  it('is unknown without a captured commit and unreconciled without refs', async () => {
    expect(state((await classify(null)).outcome)).toBe('unknown');
    expect(state((await classify(A, [], { config: { productionRefs: [], integrationRefs: [], packageMap: [] } })).outcome)).toBe('unreconciled');
  });

  it('never reads a truncated listing as absence', async () => {
    const truncated = await classify(D, [], { repo: { ...REPO, link: '<https://api.github.com/x?page=2>; rel="next"' } });
    expect(truncated.outcome).toMatchObject({ kind: 'classified', classification: { state: 'unknown', basisKind: 'ref_check_failed' } });
    const oversized = await classify(D, [], { repo: { ...REPO, tags: Array.from({ length: MAX_LISTED_REFS + 1 }, (_, i) => `refs/tags/a/v0.0.${i}`) } });
    expect(state(oversized.outcome)).toBe('unknown');
  });

  it('never reads more release lines than it checks as absence, but still finds a hit among them', async () => {
    const tags = Array.from({ length: MAX_RELEASE_LINES + 2 }, (_, i) => `refs/tags/a/v1.${i}.0`);
    const repo: Repo = { ...REPO, tags, contains: { ...REPO.contains, ...Object.fromEntries(tags.map((t) => [t, [] as string[]])) } };
    expect(state((await classify(D, [], { repo })).outcome)).toBe('unknown');
    repo.contains[tags.at(-1)!] = [D];
    expect(state((await classify(D, [], { repo })).outcome)).toBe('released');
  });

  it('is unavailable when the budget runs out, and stops making requests', async () => {
    const { outcome, used, calls } = await classify(D, [], { maxLookups: 3 });
    expect(state(outcome)).toBe('unavailable:budget_exhausted');
    expect(used).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it('names a rejected credential, a rate limit, a timeout and a network failure as unavailable', async () => {
    const status = (code: number, headers: Record<string, string> = {}) => (async () => new Response('{}', { status: code, headers })) as unknown as typeof fetch;
    expect(state((await classify(A, [], { fetcher: status(401) })).outcome)).toBe('unavailable:credential_rejected');
    expect(state((await classify(A, [], { fetcher: status(403, { 'x-ratelimit-remaining': '0' }) })).outcome)).toBe('unavailable:rate_limited');
    expect(state((await classify(A, [], { fetcher: status(429) })).outcome)).toBe('unavailable:rate_limited');
    const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(state((await classify(A, [], { fetcher: offline })).outcome)).toBe('unavailable:network');
    const hang = ((_: unknown, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const reads = githubReads({ repo: 'o/r', token: null, maxLookups: 5, fetcher: hang, timeoutMs: 5 });
    expect(await reads.compare(A, 'main')).toEqual({ ok: false, failure: 'timeout' });
  });

  it('never sends the token anywhere but the Authorization header, and omits it when absent', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const spy = (async (input: RequestInfo | URL, init: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init.headers).get('authorization') });
      return new Response(JSON.stringify({ status: 'ahead' }));
    }) as typeof fetch;
    await githubReads({ repo: 'o/r', token: 'secret-token', maxLookups: 1, fetcher: spy }).compare(A, 'main');
    await githubReads({ repo: 'o/r', token: null, maxLookups: 1, fetcher: spy }).compare(A, 'main');
    expect(seen[0]).toEqual({ url: `https://api.github.com/repos/o/r/compare/${A}...main?per_page=1`, auth: 'Bearer secret-token' });
    expect(seen[1].auth).toBeNull();
  });

  it('spends one compare per commit and ref across a run', async () => {
    const calls: string[] = [];
    const reads = githubReads({ repo: 'o/r', token: null, maxLookups: 50, fetcher: fakeGithub(REPO, calls) });
    const run = await resolveRunRefs(reads, CONFIG);
    const compare = memoizedCompare(reads);
    await classifyCommit(reads, compare, run, { headSha: A, changedPaths: [] });
    const before = reads.lookupsUsed();
    await classifyCommit(reads, compare, run, { headSha: A, changedPaths: [] });
    expect(reads.lookupsUsed()).toBe(before);
  });
});

describe('newest tag per release line', () => {
  it('orders lines newest first and prefers a final release over its prerelease', () => {
    const picked = newestPerLine('refs/tags/v*', ['refs/tags/v1.9.0', 'refs/tags/v1.10.0-rc.1', 'refs/tags/v1.10.0', 'refs/tags/v1.9.3', 'refs/tags/v2.0.0-rc.2']);
    expect(picked).toEqual({ refs: ['refs/tags/v2.0.0-rc.2', 'refs/tags/v1.10.0', 'refs/tags/v1.9.3'], complete: true });
  });
});
