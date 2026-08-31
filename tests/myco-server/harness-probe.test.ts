/**
 * The harness probe route: refuses without a bound runtime, drives it when
 * bound, and stays owner-only.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwnerPost, OWNER_ENV } from './helpers/owner.js';

const setup = () => {
  const e = sqliteEnv();
  return { ...e, env: { ...e.env, ...OWNER_ENV } };
};

describe('POST /api/harness/probe', () => {
  it('refuses with the capability named where no runtime is bound, and refuses an anonymous caller', async () => {
    const { env } = setup();
    const anonymous = await worker.fetch(new Request('https://s/api/harness/probe', { method: 'POST', headers: { 'cf-connecting-ip': '1.2.3.4' } }), env);
    expect(anonymous.status).toBe(401);
    const refused = await worker.fetch(await asOwnerPost('/api/harness/probe', {}), env);
    expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 409, body: { error: 'harness_unavailable', message: 'this deployment has no harness runtime bound' } });
  });

  it('drives a bound runtime with a bounded timeout and answers what it reported', async () => {
    const { env } = setup();
    const held: Array<{ runId: string; timeoutSeconds: number }> = [];
    const fakeStub = {
      beginRun: async (runId: string, timeoutSeconds: number) => { held.push({ runId, timeoutSeconds }); },
      fetch: async () => Response.json({ ok: true, uptimeMs: 5 }),
    };
    const harness = { idFromName: (name: string) => ({ name }), get: () => fakeStub };
    const bound = { ...env, HARNESS: harness };
    const res = await worker.fetch(await asOwnerPost('/api/harness/probe', { timeoutSeconds: 9999 }), bound);
    const body = await res.json() as Record<string, unknown>;
    expect({ status: res.status, held: body.held, timeout: body.timeoutSeconds, container: body.container }).toEqual({ status: 200, held: true, timeout: 120, container: { ok: true, uptimeMs: 5 } });
    expect(held[0]).toEqual({ runId: 'probe', timeoutSeconds: 120 });

    // a start failure's text answer reaches the caller as text, never a parse error
    const failingStub = {
      beginRun: async () => {},
      fetch: async () => new Response('Failed to start container: image pull failed', { status: 500 }),
    };
    const failing = { ...env, HARNESS: { idFromName: (name: string) => ({ name }), get: () => failingStub } };
    const failed = await worker.fetch(await asOwnerPost('/api/harness/probe', {}), failing);
    const failedBody = await failed.json() as Record<string, unknown>;
    expect({ status: failed.status, ok: failedBody.ok, container: failedBody.container }).toEqual({ status: 200, ok: false, container: 'Failed to start container: image pull failed' });
  });
});
