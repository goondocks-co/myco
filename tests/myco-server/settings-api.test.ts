/**
 * The Deployment Settings surface (#915 L4), through the deployed entry.
 *
 * Every write here goes through the one validated operation; these tests hold the
 * surface to never becoming a second way in, and to never answering with a value
 * a caller handed it to store.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueStepUpAuthority } from '@myco-server-worker/auth/step-up.js';
import { STEP_UP_HEADER } from '@myco-server-worker/constants.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, asOwnerPost, OWNER_ENV } from './helpers/owner.js';

const ANTHROPIC = 'sk-ant-api03-ZmFrZS1rZXktZm9yLXRlc3Rpbmc';
const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

const env = () => {
  const e = sqliteEnv();
  // Built explicitly rather than by spreading `e`: that object exposes a re-mapping
  // accessor, and spreading it evaluates the mapping once instead of per access.
  return { db: e.db, sqlite: e.sqlite, all: { ...e.env, ...OWNER_ENV, SECRET_WRAP_KEY: { get: async () => WRAP_KEY } } };
};

/** An authenticated owner PUT. `Headers` is not a plain object, so it is converted rather than spread. */
const put = async (path: string, body: unknown, extra: Record<string, string> = {}) =>
  new Request(`https://s${path}`, {
    method: 'PUT',
    headers: { ...Object.fromEntries((await asOwnerPost(path)).headers), ...extra },
    body: JSON.stringify(body),
  });

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe('settings API', () => {
  it('lists every Deployment leaf, marking which need step-up', async () => {
    const e = env();
    const body = await json(await worker.fetch(await asOwner('/api/settings'), e.all));
    const leaves = body.leaves as Array<{ leaf: string; configured: boolean; requiresStepUp: boolean }>;
    expect(leaves.length).toBeGreaterThan(40);
    expect(leaves.every((l) => l.configured === false)).toBe(true);
    expect(leaves.find((l) => l.leaf === 'agent.provider.base_url')?.requiresStepUp).toBe(true);
    expect(leaves.find((l) => l.leaf === 'cortex.digest.tier')?.requiresStepUp).toBe(false);
  });

  it('sets an ordinary leaf and reads it back', async () => {
    const e = env();
    expect(await json(await worker.fetch(await put('/api/settings/cortex.digest.tier', { value: 5000 }), e.all))).toEqual({ applied: true });
    const leaves = (await json(await worker.fetch(await asOwner('/api/settings'), e.all))).leaves as Array<Record<string, unknown>>;
    expect(leaves.find((l) => l.leaf === 'cortex.digest.tier')).toMatchObject({ configured: true, value: 5000 });
  });

  it('refuses a member-tier leaf through the surface, not only in the core', async () => {
    const e = env();
    const res = await worker.fetch(await put('/api/settings/capture.buffer_max_events', { value: 1 }), e.all);
    expect({ status: res.status, body: await res.json() })
      .toEqual({ status: 400, body: { applied: false, reason: 'not_deployment_tier', leaf: 'capture.buffer_max_events' } });
  });

  it('refuses an endpoint change with no step-up authority, and admits one with', async () => {
    const e = env();
    const denied = await worker.fetch(await put('/api/settings/agent.provider.base_url', { value: 'https://attacker.example' }), e.all);
    expect(denied.status).toBe(403);

    const issued = await issueStepUpAuthority(e.db, 'provider_credential', Date.now());
    const allowed = await worker.fetch(
      await put('/api/settings/agent.provider.base_url', { value: 'https://ok.example' }, { [STEP_UP_HEADER]: issued.key }),
      e.all,
    );
    expect({ status: allowed.status, body: await allowed.json() }).toEqual({ status: 200, body: { applied: true } });
  });
});

describe('provider credentials through the surface', () => {
  it('stores a credential and answers with its description, never the value', async () => {
    const e = env();
    const res = await worker.fetch(await put('/api/secrets/anthropic', { value: ANTHROPIC }), e.all);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ name: 'anthropic', configured: true, maskedValue: `${ANTHROPIC.slice(0, 8)}…${ANTHROPIC.slice(-4)}` });
    // A caller that just wrote a value learns only what any other reader may learn.
    expect(JSON.stringify(body)).not.toContain(ANTHROPIC);
  });

  it('never returns a stored credential from the list, and reports absent slots', async () => {
    const e = env();
    await worker.fetch(await put('/api/secrets/anthropic', { value: ANTHROPIC }), e.all);
    const listed = await worker.fetch(await asOwner('/api/secrets'), e.all);
    const text = await listed.text();
    expect(text).not.toContain(ANTHROPIC);
    const secrets = (JSON.parse(text) as { secrets: Array<Record<string, unknown>> }).secrets;
    expect(secrets.map((s) => s.name)).toEqual(['anthropic', 'openai', 'openrouter', 'github']);
    expect(secrets.find((s) => s.name === 'openai')).toMatchObject({ configured: false, maskedValue: null });
  });

  it('deletes a credential, and reports a slot it does not define as absent', async () => {
    const e = env();
    await worker.fetch(await put('/api/secrets/github', { value: 'ghp_aaaaaaaaaaaaaaaaaaaa' }), e.all);
    expect(await json(await worker.fetch(new Request('https://s/api/secrets/github', {
      method: 'DELETE', headers: Object.fromEntries((await asOwnerPost('/api/secrets/github')).headers),
    }), e.all))).toEqual({ deleted: true });

    const unknown = await worker.fetch(await put('/api/secrets/not_a_provider', { value: 'x' }), e.all);
    expect(unknown.status).toBe(404);
  });

  it('refuses an empty value rather than storing one nothing can authenticate with', async () => {
    const e = env();
    expect((await worker.fetch(await put('/api/secrets/anthropic', { value: '' }), e.all)).status).toBe(400);
  });
});

describe('project capability admission through the surface', () => {
  it('reports every capability off for a Project nothing has admitted', async () => {
    const e = env();
    expect(await json(await worker.fetch(await asOwner('/api/projects/proj_1/capabilities'), e.all)))
      .toEqual({ capabilities: { cortex: false, canopy: false, skills: false, vault_evolution: false } });
  });

  it('admits one capability, and leaves other Projects untouched', async () => {
    const e = env();
    expect(await json(await worker.fetch(await put('/api/projects/proj_1/capabilities/cortex', { enabled: true }), e.all))).toEqual({ applied: true });
    expect(await json(await worker.fetch(await asOwner('/api/projects/proj_1/capabilities'), e.all)))
      .toEqual({ capabilities: { cortex: true, canopy: false, skills: false, vault_evolution: false } });
    expect(await json(await worker.fetch(await asOwner('/api/projects/proj_2/capabilities'), e.all)))
      .toMatchObject({ capabilities: { cortex: false } });
  });

  it('answers a Project it does not hold as absent rather than confirming it exists', async () => {
    const e = env();
    expect((await worker.fetch(await asOwner('/api/projects/proj_nope/capabilities'), e.all)).status).toBe(404);
  });

  it('refuses a capability it does not define', async () => {
    const e = env();
    const res = await worker.fetch(await put('/api/projects/proj_1/capabilities/made_up', { enabled: true }), e.all);
    expect({ status: res.status, body: await res.json() })
      .toEqual({ status: 400, body: { applied: false, reason: 'unknown_capability', capability: 'made_up' } });
  });
});
