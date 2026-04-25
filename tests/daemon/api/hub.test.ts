import { describe, expect, it } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import {
  checkHubStatus,
  createHubStatusHandler,
  resolveHubUrl,
} from '@myco/daemon/api/hub.js';

describe('hub status API', () => {
  it('resolves the hub URL from config and trims trailing slashes', () => {
    expect(resolveHubUrl({ hub: { url: 'http://127.0.0.1:21000/' } })).toBe('http://127.0.0.1:21000');
  });

  it('lets MYCO_HUB_URL override config', () => {
    vi.stubEnv('MYCO_HUB_URL', 'http://localhost:21999/');
    try {
      expect(resolveHubUrl({ hub: { url: 'http://127.0.0.1:21000' } })).toBe('http://localhost:21999');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports running when the configured hub health endpoint responds', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ mycoHub: true }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(checkHubStatus('http://127.0.0.1:21000')).resolves.toEqual({ running: true, error: null });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:21000/health');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports offline when hub health is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connection refused'))));

    try {
      await expect(checkHubStatus('http://127.0.0.1:21000')).resolves.toEqual({
        running: false,
        error: 'Error',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not fetch non-loopback URLs from the daemon API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(checkHubStatus('https://example.com')).resolves.toEqual({
        running: false,
        error: 'unsupported_hub_url',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns the configured hub status response shape', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ mycoHub: true }), { status: 200 }))));

    try {
      const handler = createHubStatusHandler({
        liveConfig: { current: { hub: { url: 'http://127.0.0.1:21000' } } },
      });

      const result = await handler({ body: undefined, query: {}, params: {}, pathname: '/api/hub/status' });

      expect(result.body).toEqual({
        configured: true,
        url: 'http://127.0.0.1:21000',
        running: true,
        error: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
