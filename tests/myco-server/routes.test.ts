import { describe, it, expect } from 'bun:test';
import { ROUTES, matchRoute, type Route } from '@myco-server-worker/routes.js';
import { MAX_BLOB_BYTES } from '@myco-server-worker/constants.js';

const KEY = 'a'.repeat(64);

/** The body mode a route declares; the variants reached without a body declare none. */
const bodyModeOf = (route: Route): string | undefined => ('bodyMode' in route ? route.bodyMode : undefined);

describe('route table', () => {
  /**
   * Routes whose writes are not charged to the member byte quota.
   *
   * The quota bounds what a member's CAPTURE may write. `/tokens/refresh` mints a
   * successor credential, which is the server's own bookkeeping. The run-control
   * routes are the Deployment's own scheduled intelligence: charging those against
   * a human's capture allowance would let ordinary agent work exhaust that
   * member's ability to record their own sessions. A worker's claim, lease and
   * end are the Deployment's own work for the same reason, and are scoped to the
   * Deployment rather than to any Project, so no member's capture pays for them.
   */
  /**
   * Member routes exempt from the byte quota that are not run routes, each
   * labelled with what it does instead of a member's capture.
   *
   * Fail-closed on purpose: exemption is a decision, so a new route declaring
   * `quotaPrecheck: false` fails here until someone names it. Inverting this to
   * name the capture routes instead would make every future route exempt by
   * default, which is the direction that costs the user.
   */
  const NON_RUN_EXEMPT = new Set([
    '/tokens/refresh',        // mints a successor credential; the server's own bookkeeping
    '/mcp',                   // reads and tool writes, charged where they store
    '/members/link-github',   // identity, not capture
    '/import/plan',           // advice on what to ship; stores nothing
    '/spores/save', '/spores/list', '/spores/get', '/spores/resolve',  // the member's own spore surface
    '/context/prompt', '/context/session',                              // injection reads
    '/worker/claim', '/worker/lease', '/worker/end', '/worker/repository',                    // the Deployment's own work, scoped to no Project
  ]);
  const quotaExempt = (r: { path: string; legacyRunRoute?: true }): boolean =>
    r.legacyRunRoute === true || NON_RUN_EXEMPT.has(r.path);

  it('declares an auth kind and a body mode for every route, a shape for every member route, and charges every member route to the quota but the named exemptions', () => {
    for (const r of ROUTES) {
      expect(['public', 'member', 'auth', 'owner', 'enroll']).toContain(r.auth);
      if (r.auth === 'auth' || r.auth === 'owner' || r.auth === 'enroll') continue;
      expect(['none', 'json', 'stream']).toContain(r.bodyMode);
      if (r.auth === 'public') expect(r.bodyMode).toBe('none');
      if (r.bodyMode === 'stream') expect(r.maxBodyBytes).toBe(MAX_BLOB_BYTES);
      if (r.auth === 'member') {
        expect({ path: r.path, shape: r.shape }).toEqual({ path: r.path, shape: r.bodyMode === 'stream' ? 'stored' : r.path === '/tokens/refresh' ? 'refreshed' : r.path === '/mcp' ? 'answered' : 'persisted' });
        expect({ path: r.path, quotaPrecheck: r.quotaPrecheck }).toEqual({ path: r.path, quotaPrecheck: quotaExempt(r) ? false : undefined });
      }
    }
    expect(ROUTES.filter((r) => r.auth === 'public' || r.auth === 'member').map((r) => `${r.method} ${r.path}`)).toEqual(['GET /health', 'POST /events', 'POST /blobs/{sha256}', 'POST /tokens/refresh', 'POST /import/plan', 'POST /runs/claim', 'POST /runs/get', 'POST /runs/update', 'POST /runs/failed', 'POST /runs/resume-admission', 'POST /runs/supersede', 'POST /runs/reports', 'POST /runs/report', 'POST /runs/events', 'POST /runs/embedding-step', 'POST /spores/save', 'POST /spores/list', 'POST /spores/get', 'POST /spores/resolve', 'POST /context/prompt', 'POST /context/session', 'POST /runs/repository', 'POST /runs/canopy-map', 'POST /worker/claim', 'POST /worker/lease', 'POST /worker/end', 'POST /worker/repository', 'POST /mcp', 'POST /members/link-github']);
  });

  it('admits a run credential as a member on the run-control plane alone: every /runs/ route is flagged legacy, no other route is, and /mcp is the one route that serves the run principal', () => {
    for (const r of ROUTES) {
      if (r.auth !== 'member') continue;
      expect({ path: r.path, legacy: r.legacyRunRoute === true }).toEqual({ path: r.path, legacy: r.path.startsWith('/runs/') });
      expect({ path: r.path, run: r.bodyMode === 'json' && r.run !== undefined }).toEqual({ path: r.path, run: r.path === '/mcp' });
    }
  });

  it('routes exactly the child segments the handler serves', async () => {
    const { CHILD_SEGMENTS } = await import('@myco-server-worker/api/sessions.js');
    const child = ROUTES.find((r) => r.path.endsWith('/{child}'));
    const alternation = /\(\?<child>([^)]*)\)/.exec(String((child as { pattern: RegExp }).pattern))![1].split('|');
    expect(alternation.sort()).toEqual([...CHILD_SEGMENTS].sort());
  });

  it('permits exactly the enumerated public paths', () => {
    expect(ROUTES.filter((r) => r.auth === 'public').map((r) => r.path)).toEqual(['/health']);
  });

  it('matches on method and path together, and captures the blob key from the pattern route', () => {
    expect(matchRoute('GET', '/health')?.route.path).toBe('/health');
    expect(matchRoute('POST', '/health')).toBeNull();
    expect(bodyModeOf(matchRoute('POST', '/events')!.route)).toBe('json');
    expect(bodyModeOf(matchRoute('POST', '/tokens/refresh')!.route)).toBe('json');
    expect(matchRoute('GET', '/tokens/refresh')).toBeNull();
    expect(matchRoute('POST', '/tokens/refresh/')).toBeNull();
    const blob = matchRoute('POST', `/blobs/${KEY}`);
    expect(bodyModeOf(blob!.route)).toBe('stream');
    expect(blob?.params).toEqual({ key: KEY });
    for (const path of ['/blobs', '/blobs/', `/blobs/${KEY.toUpperCase()}`, `/blobs/${'a'.repeat(63)}`, `/blobs/${KEY}/x`, `/blobs/${'g'.repeat(64)}`]) {
      expect(matchRoute('POST', path)).toBeNull();
    }
    expect(matchRoute('GET', `/blobs/${KEY}`)).toBeNull();
  });
});
