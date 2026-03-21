import { describe, it, expect } from 'vitest';
import { Router } from '@myco/daemon/router';

describe('Router', () => {
  it('matches exact routes', () => {
    const router = new Router();
    const handler = async () => ({ body: { ok: true } });
    router.add('GET', '/health', handler);

    const match = router.match('GET', '/health');
    expect(match).toBeDefined();
    expect(match!.handler).toBe(handler);
    expect(match!.params).toEqual({});
  });

  it('does not match unknown routes', () => {
    const router = new Router();
    expect(router.match('GET', '/unknown')).toBeUndefined();
  });

  it('matches parameterized routes', () => {
    const router = new Router();
    router.add('GET', '/api/progress/:token', async () => ({ body: {} }));

    const match = router.match('GET', '/api/progress/abc123');
    expect(match).toBeDefined();
    expect(match!.params).toEqual({ token: 'abc123' });
  });

  it('matches prefix routes', () => {
    const router = new Router();
    router.add('GET', '/ui/*', async () => ({ body: {} }));

    const match = router.match('GET', '/ui/assets/index.js');
    expect(match).toBeDefined();
  });

  it('prioritizes exact over parameterized', () => {
    const router = new Router();
    const exact = async () => ({ body: 'exact' });
    const param = async () => ({ body: 'param' });
    router.add('GET', '/api/config', exact);
    router.add('GET', '/api/:resource', param);

    const match = router.match('GET', '/api/config');
    expect(match!.handler).toBe(exact);
  });

  it('does not match wrong HTTP method', () => {
    const router = new Router();
    router.add('POST', '/health', async () => ({ body: {} }));
    expect(router.match('GET', '/health')).toBeUndefined();
  });

  it('parses query strings', () => {
    const router = new Router();
    router.add('GET', '/api/logs', async () => ({ body: {} }));

    const match = router.match('GET', '/api/logs?since=2026-01-01&level=warn');
    expect(match).toBeDefined();
    expect(match!.query).toEqual({ since: '2026-01-01', level: 'warn' });
  });
});
