// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { fetchJson, ApiError, __setReloadPageForTests } from '../../packages/myco/ui/src/lib/api';

/**
 * The daemon rotates `window.__MYCO_AUTH__` on every process start. When it
 * restarts mid-session, the browser's cached token is stale and the API
 * returns 401 `unauthorized_context_switch`. `fetchJson` recovers by
 * reloading the page so the daemon re-injects the new token — but it must
 * not loop when the daemon is genuinely down.
 */

describe('fetchJson stale-auth recovery', () => {
  const originalFetch = globalThis.fetch;
  let reloadCalls: number;

  beforeEach(() => {
    reloadCalls = 0;
    window.sessionStorage.clear();
    __setReloadPageForTests(() => { reloadCalls += 1; });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __setReloadPageForTests();
  });

  function stubFetch(status: number, body: unknown): void {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      headers: { get: () => null } as unknown as Headers,
    } as Response) as unknown as typeof fetch;
  }

  it('reloads the page on 401 unauthorized_context_switch', async () => {
    stubFetch(401, { error: 'unauthorized_context_switch', message: 'stale token' });
    try {
      await fetchJson('/grove/list');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
    }
    expect(reloadCalls).toBe(1);
  });

  it('does not reload twice within the cooldown window', async () => {
    stubFetch(401, { error: 'unauthorized_context_switch', message: 'stale token' });
    try { await fetchJson('/grove/list'); } catch { /* expected */ }
    expect(reloadCalls).toBe(1);
    try { await fetchJson('/grove/list'); } catch { /* expected */ }
    expect(reloadCalls).toBe(1); // loop guard prevents second reload
  });

  it('does not reload on 401 with a different error code', async () => {
    stubFetch(401, { error: 'invalid_credentials' });
    try { await fetchJson('/grove/list'); } catch { /* expected */ }
    expect(reloadCalls).toBe(0);
  });

  it('does not reload on non-401 errors', async () => {
    stubFetch(500, { error: 'internal_error' });
    try { await fetchJson('/grove/list'); } catch { /* expected */ }
    expect(reloadCalls).toBe(0);
  });

  it('reloads again after the cooldown elapses', async () => {
    stubFetch(401, { error: 'unauthorized_context_switch' });
    try { await fetchJson('/grove/list'); } catch { /* expected */ }
    expect(reloadCalls).toBe(1);
    // Simulate cooldown expiry by backdating the stored timestamp.
    window.sessionStorage.setItem('myco:auth-reload-ts', String(Date.now() - 20_000));
    try { await fetchJson('/grove/list'); } catch { /* expected */ }
    expect(reloadCalls).toBe(2);
  });
});
