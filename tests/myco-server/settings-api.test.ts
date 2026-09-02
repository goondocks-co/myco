/**
 * The Deployment Settings surface (#915 L4), through the deployed entry.
 *
 * Every write here goes through the one validated operation; these tests hold the
 * surface to never becoming a second way in, and to never answering with a value
 * a caller handed it to store.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
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
  it('lists every Deployment leaf, none demanding proof beyond the session', async () => {
    const e = env();
    const body = await json(await worker.fetch(await asOwner('/api/settings'), e.all));
    const leaves = body.leaves as Array<Record<string, unknown>>;
    expect(leaves.length).toBeGreaterThan(40);
    expect(leaves.every((l) => l.configured === false)).toBe(true);
    expect(leaves.every((l) => !('requiresStepUp' in l))).toBe(true);
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

  it('answers a malformed body as a terminal refusal, in the same shape as every other one', async () => {
    // `null` is valid JSON, so `request.json()` resolves and a property read throws —
    // which the owner catch turns into a 503 with retry-after. A malformed body is the
    // caller's own fault and can never succeed on retry.
    const e = env();
    for (const [path, body] of [
      ['/api/settings/cortex.digest.tier', null],
      ['/api/projects/proj_1/capabilities/cortex', null],
      ['/api/secrets/anthropic', null],
      ['/api/settings/cortex.digest.tier', []],
    ] as const) {
      const res = await worker.fetch(await put(path, body), e.all);
      expect({ path, status: res.status, applied: (await res.json() as Record<string, unknown>).applied })
        .toEqual({ path, status: 400, applied: false });
    }
  });

  it('refuses a credential longer than any provider issues, terminally', async () => {
    const e = env();
    const res = await worker.fetch(await put('/api/secrets/anthropic', { value: 'x'.repeat(5000) }), e.all);
    expect(res.status).toBe(400);
  });

  it('applies an endpoint change on the member session alone, and records the actor', async () => {
    const e = env();
    const allowed = await worker.fetch(await put('/api/settings/agent.provider.base_url', { value: 'https://ok.example' }), e.all);
    expect({ status: allowed.status, body: await allowed.json() }).toEqual({ status: 200, body: { applied: true } });
    const leaves = (await json(await worker.fetch(await asOwner('/api/settings'), e.all))).leaves as Array<Record<string, unknown>>;
    expect(leaves.find((l) => l.leaf === 'agent.provider.base_url')).toMatchObject({ configured: true, value: 'https://ok.example', updatedBy: 'mem_machine_1' });
  });
});

describe('provider credentials through the surface', () => {
  it('stores and deletes a credential on the member session alone', async () => {
    const e = env();
    expect((await worker.fetch(await put('/api/secrets/anthropic', { value: ANTHROPIC }), e.all)).status).toBe(200);
    expect((e.sqlite.query(`SELECT COUNT(*) c FROM deployment_secrets`).get() as any).c).toBe(1);
    expect(await json(await worker.fetch(new Request('https://s/api/secrets/anthropic', {
      method: 'DELETE', headers: Object.fromEntries((await asOwnerPost('/api/secrets/anthropic')).headers),
    }), e.all))).toEqual({ deleted: true });
  });

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
      method: 'DELETE', headers: { ...Object.fromEntries((await asOwnerPost('/api/secrets/github')).headers) },
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

import { DEPLOYMENT_LEAVES } from '@myco-server-worker/core/settings.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { memberPost } from './helpers/fixtures.js';

/** A value shaped for the leaf, from its name: the kinds the dashboard catalogue renders. */
function sampleFor(leaf: string): unknown {
  if (leaf === 'agent.tasks') return { digest: { model: 'claude' } };
  if (/thinking_budget_map/.test(leaf)) return { adaptive: true };
  if (/patterns$/.test(leaf)) return ['dist/**'];
  if (/(_enabled|inject_on_|inject_intent|prevent_deep_sleep|auto_optimize$|auto_integrity_check$|semantic_write_check)/.test(leaf)) return true;
  if (/(_days|_hours|_minutes|_bytes|tier$|max_per_prompt|context_length|batch_interval|keep_daily|keep_weekly)/.test(leaf)) return 7;
  if (leaf === 'skills.confidence_threshold') return 0.75;
  if (/base_url$/.test(leaf)) return 'https://provider.example';
  return 'sample';
}

describe('every Deployment leaf, the way the dashboard writes it', () => {
  it('round-trips a kind-shaped value for every leaf on the member session alone, attributed to who wrote it', async () => {
    const e = env();
    for (const leaf of DEPLOYMENT_LEAVES) {
      const value = sampleFor(leaf);
      const answer = await json(await worker.fetch(await put(`/api/settings/${leaf}`, { value }), e.all));
      expect({ leaf, answer }).toEqual({ leaf, answer: { applied: true } });
    }
    const leaves = (await json(await worker.fetch(await asOwner('/api/settings'), e.all))).leaves as Array<Record<string, unknown>>;
    for (const leaf of DEPLOYMENT_LEAVES) {
      const row = leaves.find((l) => l.leaf === leaf)!;
      expect({ leaf, value: row.value, updatedBy: row.updatedBy, updatedAt: typeof row.updatedAt }).toEqual({ leaf, value: sampleFor(leaf), updatedBy: 'mem_machine_1', updatedAt: 'number' });
    }
  });

  it('changes task admission on the next run when a capability is toggled', async () => {
    const e = env();
    const token = (await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now())).token;
    e.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_s', 'a', 'built-in', 1, ?)`).run(Date.now());
    const claim = async (id: string) => json(await worker.fetch(memberPost(token, { id, agentId: 'agent_s', task: `digest_${id}`, capability: 'cortex' }, '/runs/claim'), e.all));
    expect(await claim('run_off')).toMatchObject({ persisted: true, claimed: false, notAdmitted: 'cortex' });
    expect(await json(await worker.fetch(await put('/api/projects/proj_1/capabilities/cortex', { enabled: true }), e.all))).toEqual({ applied: true });
    expect(await claim('run_on')).toMatchObject({ persisted: true, claimed: true });
    expect(await json(await worker.fetch(await put('/api/projects/proj_1/capabilities/cortex', { enabled: false }), e.all))).toEqual({ applied: true });
    expect(await claim('run_off_again')).toMatchObject({ persisted: true, claimed: false, notAdmitted: 'cortex' });
  });
});
