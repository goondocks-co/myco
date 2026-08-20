import { describe, it, expect } from 'bun:test';
import { ROUTES, matchRoute } from '@myco-server-worker/routes.js';
import { MAX_BLOB_BYTES } from '@myco-server-worker/constants.js';

const KEY = 'a'.repeat(64);

describe('route table', () => {
  it('declares an auth kind and a body mode for every route', () => {
    for (const r of ROUTES) {
      expect(['public', 'member']).toContain(r.auth);
      expect(['none', 'json', 'stream']).toContain(r.bodyMode);
      if (r.auth === 'public') expect(r.bodyMode).toBe('none');
      if (r.bodyMode === 'stream') expect(r.maxBodyBytes).toBe(MAX_BLOB_BYTES);
    }
  });

  it('permits exactly the enumerated public paths', () => {
    expect(ROUTES.filter((r) => r.auth === 'public').map((r) => r.path)).toEqual(['/health']);
  });

  it('matches on method and path together, and captures the blob key from the pattern route', () => {
    expect(matchRoute('GET', '/health')?.route.path).toBe('/health');
    expect(matchRoute('POST', '/health')).toBeNull();
    expect(matchRoute('POST', '/events')?.route.bodyMode).toBe('json');
    const blob = matchRoute('POST', `/blobs/${KEY}`);
    expect(blob?.route.bodyMode).toBe('stream');
    expect(blob?.params).toEqual({ key: KEY });
    for (const path of ['/blobs', '/blobs/', `/blobs/${KEY.toUpperCase()}`, `/blobs/${'a'.repeat(63)}`, `/blobs/${KEY}/x`, `/blobs/${'g'.repeat(64)}`]) {
      expect(matchRoute('POST', path)).toBeNull();
    }
    expect(matchRoute('GET', `/blobs/${KEY}`)).toBeNull();
  });
});
