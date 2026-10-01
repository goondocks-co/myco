/**
 * A 1.4 daemon with no dashboard build on disk answers every page with the
 * retired-dashboard notice: an HTML page that loads no script and points at the
 * Deployment's dashboard.
 */
import { describe, expect, it } from 'bun:test';

import { hasEmbeddedUi, resolveEmbeddedAsset } from '@myco/daemon/static.js';

describe('the retired 1.4 dashboard', () => {
  it('answers every path with the one notice', () => {
    expect(hasEmbeddedUi()).toBe(true);
    for (const pathname of ['/', '/g/default/p/myco/sessions', '/assets/index-abc123.js']) {
      const page = resolveEmbeddedAsset(pathname);
      const body = page.body.toString('utf-8');
      expect({ pathname, contentType: page.contentType, cacheControl: page.cacheControl })
        .toEqual({ pathname, contentType: 'text/html', cacheControl: 'no-cache' });
      expect(body).toContain('The 1.4 dashboard is retired');
      expect(body).not.toContain('<script');
    }
  });
});
