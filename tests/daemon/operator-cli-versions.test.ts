/**
 * Tests for daemon/operator-cli-versions.ts — checkOperatorCliVersions
 *
 * Covers:
 * - myco-team and myco-collective resolve from the mocked npm registry
 * - update_available is correct (false when up-to-date, true when newer exists)
 * - beta channel: resolves max(stable, beta) — no-downgrade rule
 * - stable channel: only uses dist-tags.latest
 * - revert_available is always false for operator packages
 * - partial failure: still returns successful packages
 * - all failure: throws
 */

import { describe, it, expect } from 'bun:test';
import { checkOperatorCliVersions } from '@myco/daemon/operator-cli-versions.js';
import { TEAM_PACKAGE_NAME, COLLECTIVE_PACKAGE_NAME } from '@myco/constants/update.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_NPM_URL = `https://registry.npmjs.org/${encodeURIComponent(TEAM_PACKAGE_NAME)}`;
const COLLECTIVE_NPM_URL = `https://registry.npmjs.org/${encodeURIComponent(COLLECTIVE_PACKAGE_NAME)}`;

function makeNpmResponse(latest: string, beta?: string): Record<string, unknown> {
  return {
    'dist-tags': {
      latest,
      ...(beta !== undefined ? { beta } : {}),
    },
  };
}

function makeFetchFn(opts: {
  teamLatest?: string;
  teamBeta?: string;
  collectiveLatest?: string;
  collectiveBeta?: string;
  teamStatus?: number;
  collectiveStatus?: number;
}): typeof fetch {
  return async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;

    if (urlStr === TEAM_NPM_URL) {
      const status = opts.teamStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({}), { status });
      }
      return new Response(
        JSON.stringify(makeNpmResponse(opts.teamLatest ?? '1.0.0', opts.teamBeta)),
        { status: 200 },
      );
    }

    if (urlStr === COLLECTIVE_NPM_URL) {
      const status = opts.collectiveStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({}), { status });
      }
      return new Response(
        JSON.stringify(makeNpmResponse(opts.collectiveLatest ?? '1.0.0', opts.collectiveBeta)),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected URL in operator-cli-versions test: ${urlStr}`);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkOperatorCliVersions() — stable channel', () => {
  it('returns PackageCheckResult rows for myco-team and myco-collective', async () => {
    const results = await checkOperatorCliVersions(
      'stable',
      { 'myco-team': '2.0.0', 'myco-collective': '3.0.0' },
      makeFetchFn({ teamLatest: '2.5.0', collectiveLatest: '3.5.0' }),
    );

    expect(results).toHaveLength(2);
    const teamRow = results.find((r) => r.id === 'myco-team');
    const collectiveRow = results.find((r) => r.id === 'myco-collective');

    expect(teamRow).toBeDefined();
    expect(teamRow?.latest_stable).toBe('2.5.0');
    expect(teamRow?.latest_version).toBe('2.5.0');
    expect(teamRow?.update_available).toBe(true);
    expect(teamRow?.installed).toBe(true);
    expect(teamRow?.installed_version).toBe('2.0.0');

    expect(collectiveRow).toBeDefined();
    expect(collectiveRow?.latest_stable).toBe('3.5.0');
    expect(collectiveRow?.update_available).toBe(true);
  });

  it('update_available=false when installed version matches registry', async () => {
    const results = await checkOperatorCliVersions(
      'stable',
      { 'myco-team': '2.5.0', 'myco-collective': '3.5.0' },
      makeFetchFn({ teamLatest: '2.5.0', collectiveLatest: '3.5.0' }),
    );

    const teamRow = results.find((r) => r.id === 'myco-team');
    const collectiveRow = results.find((r) => r.id === 'myco-collective');

    expect(teamRow?.update_available).toBe(false);
    expect(collectiveRow?.update_available).toBe(false);
  });

  it('installed=false when package is not installed (null)', async () => {
    const results = await checkOperatorCliVersions(
      'stable',
      { 'myco-team': null, 'myco-collective': null },
      makeFetchFn({ teamLatest: '2.0.0', collectiveLatest: '3.0.0' }),
    );

    const teamRow = results.find((r) => r.id === 'myco-team');
    expect(teamRow?.installed).toBe(false);
    expect(teamRow?.installed_version).toBeNull();
    expect(teamRow?.update_available).toBe(false); // not installed → no update
  });

  it('revert_available is always false for operator packages', async () => {
    const results = await checkOperatorCliVersions(
      'stable',
      { 'myco-team': '2.0.0-beta.1', 'myco-collective': null },
      makeFetchFn({ teamLatest: '1.0.0', collectiveLatest: '1.0.0' }),
    );

    for (const r of results) {
      expect(r.revert_available).toBe(false);
    }
  });

  it('ignores beta dist-tag on stable channel', async () => {
    const results = await checkOperatorCliVersions(
      'stable',
      { 'myco-team': '2.0.0', 'myco-collective': '3.0.0' },
      makeFetchFn({ teamLatest: '2.0.0', teamBeta: '2.5.0-beta.1', collectiveLatest: '3.0.0' }),
    );

    const teamRow = results.find((r) => r.id === 'myco-team');
    // stable channel: target = dist-tags.latest (2.0.0), not beta (2.5.0-beta.1)
    expect(teamRow?.latest_version).toBe('2.0.0');
    expect(teamRow?.update_available).toBe(false);
    // latest_beta is still reported
    expect(teamRow?.latest_beta).toBe('2.5.0-beta.1');
  });

  it('does not include myco row (only operator packages)', async () => {
    const results = await checkOperatorCliVersions(
      'stable',
      {},
      makeFetchFn({ teamLatest: '1.0.0', collectiveLatest: '1.0.0' }),
    );

    const mycoRow = results.find((r) => r.id === 'myco');
    expect(mycoRow).toBeUndefined();
  });
});

describe('checkOperatorCliVersions() — beta channel', () => {
  it('picks higher prerelease over stable', async () => {
    const results = await checkOperatorCliVersions(
      'beta',
      { 'myco-team': '2.0.0', 'myco-collective': '3.0.0' },
      makeFetchFn({
        teamLatest: '2.0.0',
        teamBeta: '2.5.0-beta.1',
        collectiveLatest: '3.0.0',
        collectiveBeta: '3.5.0-beta.2',
      }),
    );

    const teamRow = results.find((r) => r.id === 'myco-team');
    expect(teamRow?.latest_version).toBe('2.5.0-beta.1');
    expect(teamRow?.update_available).toBe(true);
  });

  it('no-downgrade: picks stable over lower prerelease', async () => {
    const results = await checkOperatorCliVersions(
      'beta',
      { 'myco-team': '1.0.0', 'myco-collective': '1.0.0' },
      makeFetchFn({
        teamLatest: '2.0.0',       // stable is higher
        teamBeta: '1.5.0-beta.1',  // beta is lower than stable
        collectiveLatest: '1.0.0',
      }),
    );

    const teamRow = results.find((r) => r.id === 'myco-team');
    expect(teamRow?.latest_version).toBe('2.0.0');
    expect(teamRow?.update_available).toBe(true);
  });
});

describe('checkOperatorCliVersions() — error handling', () => {
  it('returns partial results when one package fails', async () => {
    // myco-team fails, myco-collective succeeds → should return collective row
    const fetchFn = async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr === TEAM_NPM_URL) {
        throw new Error('network error for team');
      }
      if (urlStr === COLLECTIVE_NPM_URL) {
        return new Response(
          JSON.stringify(makeNpmResponse('3.0.0')),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    };

    const results = await checkOperatorCliVersions('stable', {}, fetchFn as typeof fetch);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('myco-collective');
  });

  it('throws when all packages fail', async () => {
    const failingFetch = async () => {
      throw new Error('total network failure');
    };

    await expect(
      checkOperatorCliVersions('stable', {}, failingFetch as typeof fetch),
    ).rejects.toThrow('total network failure');
  });

  it('throws on non-ok HTTP response for all packages', async () => {
    await expect(
      checkOperatorCliVersions(
        'stable',
        {},
        makeFetchFn({ teamStatus: 503, collectiveStatus: 503 }),
      ),
    ).rejects.toThrow();
  });
});
