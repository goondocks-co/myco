import { describe, it, expect } from 'bun:test';
import { ROUTES, matchRoute } from '@myco-server-worker/routes.js';
import { MAX_BLOB_BYTES } from '@myco-server-worker/constants.js';

const KEY = 'a'.repeat(64);

describe('route table', () => {
  /**
   * Routes whose writes are not charged to the member byte quota.
   *
   * The quota bounds what a member's CAPTURE may write. `/tokens/refresh` mints a
   * successor credential, which is the server's own bookkeeping. The run-control
   * routes are the Deployment's own scheduled intelligence: charging those against
   * a human's capture allowance would let ordinary agent work exhaust that
   * member's ability to record their own sessions.
   */
  const QUOTA_EXEMPT = new Set(['/tokens/refresh', '/mcp', '/members/link-github', '/runs/admission', '/runs/claim', '/runs/get', '/runs/update', '/runs/failed', '/runs/resume-admission', '/runs/supersede', '/runs/reports', '/runs/report', '/runs/events', '/runs/cortex-instructions', '/runs/state/read', '/runs/state/write', '/spores/save', '/spores/list', '/spores/get', '/spores/resolve']);

  it('declares an auth kind and a body mode for every route, a shape for every member route, and charges every member route to the quota but the named exemptions', () => {
    for (const r of ROUTES) {
      expect(['public', 'member', 'auth', 'owner', 'enroll']).toContain(r.auth);
      if (r.auth === 'auth' || r.auth === 'owner' || r.auth === 'enroll') continue;
      expect(['none', 'json', 'stream']).toContain(r.bodyMode);
      if (r.auth === 'public') expect(r.bodyMode).toBe('none');
      if (r.bodyMode === 'stream') expect(r.maxBodyBytes).toBe(MAX_BLOB_BYTES);
      if (r.auth === 'member') {
        expect({ path: r.path, shape: r.shape }).toEqual({ path: r.path, shape: r.bodyMode === 'stream' ? 'stored' : r.path === '/tokens/refresh' ? 'refreshed' : r.path === '/mcp' ? 'answered' : 'persisted' });
        expect({ path: r.path, quotaPrecheck: r.quotaPrecheck }).toEqual({ path: r.path, quotaPrecheck: QUOTA_EXEMPT.has(r.path) ? false : undefined });
      }
    }
    expect(ROUTES.filter((r) => r.auth === 'public' || r.auth === 'member').map((r) => `${r.method} ${r.path}`)).toEqual(['GET /health', 'POST /events', 'POST /blobs/{sha256}', 'POST /tokens/refresh', 'POST /runs/claim', 'POST /runs/admission', 'POST /runs/get', 'POST /runs/update', 'POST /runs/failed', 'POST /runs/resume-admission', 'POST /runs/supersede', 'POST /runs/reports', 'POST /runs/report', 'POST /runs/events', 'POST /runs/cortex-instructions', 'POST /spores/save', 'POST /spores/list', 'POST /spores/get', 'POST /spores/resolve', 'POST /runs/state/read', 'POST /runs/state/write', 'POST /mcp', 'POST /members/link-github']);
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
    expect(matchRoute('POST', '/events')?.route.bodyMode).toBe('json');
    expect(matchRoute('POST', '/tokens/refresh')?.route.bodyMode).toBe('json');
    expect(matchRoute('GET', '/tokens/refresh')).toBeNull();
    expect(matchRoute('POST', '/tokens/refresh/')).toBeNull();
    const blob = matchRoute('POST', `/blobs/${KEY}`);
    expect(blob?.route.bodyMode).toBe('stream');
    expect(blob?.params).toEqual({ key: KEY });
    for (const path of ['/blobs', '/blobs/', `/blobs/${KEY.toUpperCase()}`, `/blobs/${'a'.repeat(63)}`, `/blobs/${KEY}/x`, `/blobs/${'g'.repeat(64)}`]) {
      expect(matchRoute('POST', path)).toBeNull();
    }
    expect(matchRoute('GET', `/blobs/${KEY}`)).toBeNull();
  });
});
