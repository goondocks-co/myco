import { describe, it, expect } from 'bun:test';
import { ROUTES, matchRoute } from '../../packages/myco-server/worker/src/routes.js';

describe('route table', () => {
  it('declares an auth kind for every route', () => {
    for (const r of ROUTES) expect(['public', 'member']).toContain(r.auth);
  });

  it('permits exactly the enumerated public paths', () => {
    expect(ROUTES.filter((r) => r.auth === 'public').map((r) => r.path)).toEqual(['/health']);
  });

  it('matches on method and path together', () => {
    expect(matchRoute('GET', '/health')?.path).toBe('/health');
    expect(matchRoute('POST', '/health')).toBeNull();
  });
});
