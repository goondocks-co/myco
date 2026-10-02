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
import { asOwner, asOwnerPatch, asOwnerPost, OWNER_ENV } from './helpers/owner.js';
import { OUTCOME_TASKS, TASK_TIERS } from '@myco-server-worker/core/task-catalogue.js';

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

const remove = async (path: string) => new Request(`https://s${path}`, {
  method: 'DELETE', headers: Object.fromEntries((await asOwnerPost(path)).headers),
});

const patch = asOwnerPatch;

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe('settings API', () => {
  it('shows a bad stored task tier and its repair on owner and member Settings reads', async () => {
    const e = env();
    e.sqlite.run(`INSERT INTO deployment_settings (leaf,value,updated_at,updated_by) VALUES ('agent.tasks',?,1,'mem_machine_1')`, [
      JSON.stringify({ 'title-summary': { reasoningLevel: 'maximum' } }),
    ]);
    const owner = await worker.fetch(await asOwner('/api/settings'), e.all);
    expect(owner.status).toBe(200);
    const ownerTiers = (await json(owner)).taskTiers as Array<Record<string, unknown>>;
    expect(ownerTiers.find((tier) => tier.task === 'title-summary')).toEqual({
      task: 'title-summary', tier: null, source: 'invalid', error: 'invalid_task_tier', repair: 'reset-task',
      remedy: 'Correct the tier in Settings or reset the task tier.',
    });
    expect(ownerTiers.find((tier) => tier.task === 'extract-curate')).toEqual({ task: 'extract-curate', tier: 'default', source: 'task' });
    const token = (await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now())).token;
    const member = await worker.fetch(memberPost(token, {}, '/members/settings'), e.all);
    expect(member.status).toBe(200);
    expect((await json(member)).taskTiers).toEqual(ownerTiers);
  });

  it('resets a malformed task entry while preserving valid siblings', async () => {
    const e = env();
    e.sqlite.run(`INSERT INTO deployment_settings (leaf,value,updated_at,updated_by) VALUES ('agent.tasks',?,1,'historic')`, [
      JSON.stringify({ 'title-summary': 'broken', 'canopy-map': { schedule: { intervalSeconds: 600 } } }),
    ]);
    const rows = (await json(await worker.fetch(await asOwner('/api/settings'), e.all))).taskTiers as Array<Record<string, unknown>>;
    expect(rows.find((row) => row.task === 'title-summary')).toMatchObject({ source: 'invalid', repair: 'reset-task' });
    expect(await json(await worker.fetch(await patch('/api/settings/agent.tasks', { task: 'title-summary', tier: null }), e.all))).toEqual({ applied: true });
    const stored = JSON.parse((e.sqlite.query(`SELECT value FROM deployment_settings WHERE leaf='agent.tasks'`).get() as { value: string }).value);
    expect(stored).toEqual({ 'canopy-map': { schedule: { intervalSeconds: 600 } } });
    e.sqlite.run(`UPDATE deployment_settings SET value = ? WHERE leaf='agent.tasks'`, [JSON.stringify({
      'title-summary': 'broken-again', 'canopy-map': { schedule: { intervalSeconds: 600 } },
    })]);
    expect(await json(await worker.fetch(await patch('/api/settings/agent.tasks', { task: 'title-summary', tier: 'high' }), e.all))).toEqual({ applied: true });
    expect(JSON.parse((e.sqlite.query(`SELECT value FROM deployment_settings WHERE leaf='agent.tasks'`).get() as { value: string }).value))
      .toEqual({ 'title-summary': { reasoningLevel: 'high' }, 'canopy-map': { schedule: { intervalSeconds: 600 } } });
  });

  it('offers a whole-leaf reset when the stored task document is malformed', async () => {
    const e = env();
    e.sqlite.run(`INSERT INTO deployment_settings (leaf,value,updated_at,updated_by) VALUES ('agent.tasks','[]',1,'historic')`);
    const rows = (await json(await worker.fetch(await asOwner('/api/settings'), e.all))).taskTiers as Array<Record<string, unknown>>;
    expect(rows.every((row) => row.source === 'invalid' && row.repair === 'reset-leaf' && String(row.remedy).includes('Reset task overrides'))).toBe(true);
    expect(await json(await worker.fetch(await remove('/api/settings/agent.tasks'), e.all))).toEqual({ applied: true });
    expect((await json(await worker.fetch(await asOwner('/api/settings'), e.all))).taskTiers)
      .toEqual(OUTCOME_TASKS.map((task) => ({ task, tier: TASK_TIERS[task], source: 'task' })));
  });

  it('reports a raw stored JSON error without hiding other Settings leaves', async () => {
    const e = env();
    e.sqlite.run(`INSERT INTO deployment_settings (leaf,value,updated_at,updated_by) VALUES ('agent.tasks','{bad',1,'historic')`);
    const owner = await worker.fetch(await asOwner('/api/settings'), e.all);
    expect(owner.status).toBe(200);
    const answer = await json(owner);
    expect((answer.leaves as Array<Record<string, unknown>>).find((row) => row.leaf === 'agent.tasks'))
      .toMatchObject({ configured: true, source: 'invalid', error: 'invalid_value', remedy: expect.stringContaining('reset') });
    expect((answer.taskTiers as Array<Record<string, unknown>>).every((row) => row.source === 'invalid' && row.repair === 'reset-leaf')).toBe(true);
    const token = (await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now())).token;
    const member = await worker.fetch(memberPost(token, {}, '/members/settings'), e.all);
    expect(member.status).toBe(200);
    expect((await json(member)).taskTiers).toEqual(answer.taskTiers);
    const repaired = await worker.fetch(await put('/api/settings/agent.tasks', { value: { 'title-summary': { reasoningLevel: 'high' } } }), e.all);
    expect(repaired.status).toBe(200);
    expect((await json(await worker.fetch(await asOwner('/api/settings'), e.all))).taskTiers)
      .toContainEqual({ task: 'title-summary', tier: 'high', source: 'task-override' });
    expect(await json(await worker.fetch(await remove('/api/settings/agent.tasks'), e.all))).toEqual({ applied: true });
  });

  it('edits a changed task tier and titling switch beside a legacy model pin without a harness', async () => {
    const e = env();
    e.sqlite.run(`INSERT INTO deployment_settings (leaf,value,updated_at,updated_by) VALUES ('agent.tasks',?,1,'historic')`, [
      JSON.stringify({ 'title-summary': { model: 'sonnet' }, 'canopy-map': { schedule: { intervalSeconds: 600 } } }),
    ]);
    const before = (await json(await worker.fetch(await asOwner('/api/settings'), e.all))).leaves as Array<Record<string, unknown>>;
    expect(before.find((row) => row.leaf === 'agent.tasks')).toMatchObject({ source: 'invalid', error: 'invalid_value', remedy: expect.stringContaining('title-summary.model') });
    expect(await json(await worker.fetch(await patch('/api/settings/agent.tasks', { task: 'canopy-map', tier: 'high' }), e.all))).toEqual({ applied: true });
    const switched = await worker.fetch(await put('/api/titling-backfill', { enabled: true }), e.all);
    expect(switched.status).toBe(200);
    const stored = JSON.parse((e.sqlite.query(`SELECT value FROM deployment_settings WHERE leaf='agent.tasks'`).get() as { value: string }).value);
    expect(stored).toMatchObject({ 'title-summary': { model: 'sonnet', schedule: { enabled: true } }, 'canopy-map': { reasoningLevel: 'high', schedule: { intervalSeconds: 600 } } });
  });

  it('reports stored invalid profile model, effort, and login values with a reset remedy', async () => {
    const e = env();
    const values = {
      'agent.reasoning_map.claude-code.low': 'not-a-claude-model',
      'agent.effort_map.codex.high': 'impossible',
      'agent.harnesses.claude-code.credential': 'broken',
    };
    for (const [leaf, value] of Object.entries(values)) {
      e.sqlite.run(`INSERT INTO deployment_settings (leaf,value,updated_at,updated_by) VALUES (?,?,1,'historic')`, [leaf, JSON.stringify(value)]);
    }
    const rows = (await json(await worker.fetch(await asOwner('/api/settings'), e.all))).leaves as Array<Record<string, unknown>>;
    for (const leaf of Object.keys(values)) {
      expect(rows.find((row) => row.leaf === leaf)).toMatchObject({ configured: true, source: 'invalid', error: 'invalid_value', remedy: expect.stringContaining('reset') });
    }
  });

  it('refuses retired execution settings writes and preserves their readable historical values', async () => {
    const e = env();
    const leaves = ['agent.model', 'agent.reasoningLevel', 'agent.provider.reasoning_map.low', 'agent.provider.effort_map.default.effort', 'agent.provider.thinking_budget_map.high'];
    for (const leaf of leaves) {
      e.sqlite.run(`INSERT INTO deployment_settings (leaf,value,updated_at,updated_by) VALUES (?, '"kept"', 1, 'historic')`, [leaf]);
      const response = await worker.fetch(await put(`/api/settings/${leaf}`, { value: 'replacement' }), e.all);
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 400, body: { applied: false, reason: 'retired', leaf } });
      const reset = await worker.fetch(new Request(await asOwnerPost(`/api/settings/${leaf}`), { method: 'DELETE' }), e.all);
      expect({ status: reset.status, body: await reset.json() }).toEqual({ status: 400, body: { applied: false, reason: 'retired', leaf } });
    }
    const rows = (await json(await worker.fetch(await asOwner('/api/settings'), e.all))).leaves as Array<Record<string, unknown>>;
    for (const leaf of leaves) expect(rows.find((row) => row.leaf === leaf)).toMatchObject({ configured: true, retired: true, value: 'kept', updatedBy: 'historic' });
  });

  it('patches one task tier against the live document and retains concurrent sibling changes', async () => {
    const e = env();
    const initial = { 'title-summary': { reasoningLevel: 'low', schedule: { maxRunsPerDay: 4 }, harness: 'claude-code', model: 'haiku' } };
    await worker.fetch(await put('/api/settings/agent.tasks', { value: initial }), e.all);
    const stale = await json(await worker.fetch(await asOwner('/api/settings'), e.all));
    expect(stale.taskTiers).toBeDefined();
    const latest = {
      'title-summary': { reasoningLevel: 'low', schedule: { maxRunsPerDay: 7 }, harness: 'claude-code', model: 'sonnet' },
      'canopy-map': { schedule: { intervalSeconds: 600 }, harness: 'codex' },
    };
    await worker.fetch(await put('/api/settings/agent.tasks', { value: latest }), e.all);
    expect(await json(await worker.fetch(await patch('/api/settings/agent.tasks', { task: 'title-summary', tier: 'high' }), e.all))).toEqual({ applied: true });
    expect((e.sqlite.query(`SELECT updated_by FROM deployment_settings WHERE leaf = 'agent.tasks'`).get() as { updated_by: string }).updated_by).toBe('mem_machine_1');
    const stored = JSON.parse((e.sqlite.query(`SELECT value FROM deployment_settings WHERE leaf = 'agent.tasks'`).get() as { value: string }).value);
    expect(stored).toEqual({ ...latest, 'title-summary': { ...latest['title-summary'], reasoningLevel: 'high' } });
    expect(await json(await worker.fetch(await patch('/api/settings/agent.tasks', { task: 'title-summary', tier: null }), e.all))).toEqual({ applied: true });
    const reset = JSON.parse((e.sqlite.query(`SELECT value FROM deployment_settings WHERE leaf = 'agent.tasks'`).get() as { value: string }).value);
    expect(reset).toEqual({ ...latest, 'title-summary': { schedule: { maxRunsPerDay: 7 }, harness: 'claude-code', model: 'sonnet' } });
    const absentTask = OUTCOME_TASKS.find((task) => task !== 'title-summary' && task !== 'canopy-map')!;
    expect(await json(await worker.fetch(await patch('/api/settings/agent.tasks', { task: absentTask, tier: 'high' }), e.all))).toEqual({ applied: true });
    expect(await json(await worker.fetch(await patch('/api/settings/agent.tasks', { task: absentTask, tier: null }), e.all))).toEqual({ applied: true });
    expect(JSON.parse((e.sqlite.query(`SELECT value FROM deployment_settings WHERE leaf = 'agent.tasks'`).get() as { value: string }).value)).toEqual(reset);
    expect((await worker.fetch(await patch('/api/settings/agent.tasks', { task: 'unknown-task', tier: 'low' }), e.all)).status).toBe(400);
    expect((await worker.fetch(await patch('/api/settings/agent.tasks', { task: 'title-summary', tier: 'maximum' }), e.all)).status).toBe(400);
    expect((await worker.fetch(await put('/api/settings/agent.tasks', { value: { 'title-summary': null } }), e.all)).status).toBe(400);
  });
  it('reports exactly the declared outcome tiers and where each effective tier came from', async () => {
    const e = env();
    const tiers = async () => (await json(await worker.fetch(await asOwner('/api/settings'), e.all))).taskTiers;
    expect(await tiers()).toEqual(OUTCOME_TASKS.map((task) => ({ task, tier: TASK_TIERS[task], source: 'task' })));
    const overrides = {
      'title-summary': { reasoningLevel: 'high', schedule: { maxRunsPerDay: 4 }, harness: 'claude-code', model: 'opus' },
    };
    expect(await json(await worker.fetch(await put('/api/settings/agent.tasks', { value: overrides }), e.all))).toEqual({ applied: true });
    expect(await tiers()).toEqual(OUTCOME_TASKS.map((task) => ({
      task, tier: task === 'title-summary' ? 'high' : TASK_TIERS[task], source: task === 'title-summary' ? 'task-override' : 'task',
    })));
  });

  it('reports effective profile defaults, configured sources, and reset through the single writer', async () => {
    const e = env();
    const initial = (await json(await worker.fetch(await asOwner('/api/settings'), e.all))).leaves as Array<Record<string, unknown>>;
    const models = { low: 'haiku', default: 'sonnet', high: 'opus' };
    const efforts = { low: 'low', default: 'medium', high: 'high' };
    for (const harness of ['claude-code', 'codex', 'opencode']) {
      for (const tier of ['low', 'default', 'high'] as const) {
        expect(initial.find((entry) => entry.leaf === `agent.reasoning_map.${harness}.${tier}`)).toMatchObject({
          configured: false, effectiveValue: harness === 'claude-code' ? models[tier] : null, source: harness === 'claude-code' ? 'default' : 'unset',
        });
        expect(initial.find((entry) => entry.leaf === `agent.effort_map.${harness}.${tier}`)).toMatchObject({ configured: false, effectiveValue: efforts[tier], source: 'default' });
      }
      expect(initial.find((entry) => entry.leaf === `agent.harnesses.${harness}.credential`)).toMatchObject({ configured: false, effectiveValue: 'deployment', source: 'default' });
    }
    const leaf = 'agent.reasoning_map.claude-code.low';
    const row = async () => ((await json(await worker.fetch(await asOwner('/api/settings'), e.all))).leaves as Array<Record<string, unknown>>)
      .find((entry) => entry.leaf === leaf);
    expect(await row()).toMatchObject({ configured: false, value: null, effectiveValue: 'haiku', source: 'default' });
    expect(await json(await worker.fetch(await put(`/api/settings/${leaf}`, { value: 'sonnet' }), e.all))).toEqual({ applied: true });
    expect(await row()).toMatchObject({ configured: true, value: 'sonnet', effectiveValue: 'sonnet', source: 'configured' });
    expect(await json(await worker.fetch(await remove(`/api/settings/${leaf}`), e.all))).toEqual({ applied: true });
    expect(await row()).toMatchObject({ configured: false, value: null, effectiveValue: 'haiku', source: 'default' });
    const missing = ((await json(await worker.fetch(await asOwner('/api/settings'), e.all))).leaves as Array<Record<string, unknown>>)
      .find((entry) => entry.leaf === 'agent.reasoning_map.opencode.low');
    expect(missing).toMatchObject({ configured: false, effectiveValue: null, source: 'unset' });
  });

  it('refuses reset of a foreign leaf and preserves the configured profile sibling', async () => {
    const e = env();
    const sibling = 'agent.effort_map.claude-code.low';
    await worker.fetch(await put(`/api/settings/${sibling}`, { value: 'xhigh' }), e.all);
    const response = await worker.fetch(await remove('/api/settings/not.a.leaf'), e.all);
    expect({ status: response.status, body: await response.json() })
      .toEqual({ status: 400, body: { applied: false, reason: 'not_deployment_tier', leaf: 'not.a.leaf' } });
    const rows = (await json(await worker.fetch(await asOwner('/api/settings'), e.all))).leaves as Array<Record<string, unknown>>;
    expect(rows.find((entry) => entry.leaf === sibling)).toMatchObject({ configured: true, effectiveValue: 'xhigh' });
  });
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

  it('strips the whitespace a soft-wrapped paste carries before sealing, and refuses a line break rather than repairing it', async () => {
    const e = env();
    const wrapped = await worker.fetch(await put('/api/secrets/anthropic', { value: `  sk-ant-oat01-${'A'.repeat(24)} ${'B'.repeat(24)}\t${'C'.repeat(24)}-DDDD  ` }), e.all);
    const stored = await wrapped.json() as Record<string, unknown>;
    expect({ status: wrapped.status, configured: stored.configured, mask: stored.maskedValue }).toEqual({ status: 200, configured: true, mask: 'sk-ant-o…DDDD' });
    const broken = await worker.fetch(await put('/api/secrets/anthropic', { value: 'sk-ant-oat01-AAAA\n' }), e.all);
    expect({ status: broken.status, body: await broken.json() }).toEqual({ status: 400, body: { applied: false, reason: 'malformed', detail: 'value carries a line break or control character', leaf: 'secret.anthropic' } });
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
    expect(secrets.map((s) => s.name)).toEqual(['anthropic', 'codex', 'openai', 'openrouter', 'github']);
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

import { DEPLOYMENT_LEAF_SPECS, DEPLOYMENT_LEAVES, RETIRED_LEAVES } from '@myco-server-worker/core/settings.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { memberPost } from './helpers/fixtures.js';

/** A value shaped for the leaf, from its name: the kinds the dashboard catalogue renders. */
function sampleFor(leaf: string): unknown {
  // A leaf that declares a rule is sampled FROM that rule, never guessed from
  // its name: a guess that happens to satisfy today's rule stops satisfying it
  // the moment the rule tightens, and the guess is what would need finding.
  const spec = DEPLOYMENT_LEAF_SPECS[leaf];
  if (spec !== undefined && 'type' in spec) {
    if (spec.type === 'integer') return spec.min;
    if (spec.type === 'task-overrides') return { digest: { harness: 'claude-code', model: 'sonnet', schedule: { maxRunsPerDay: 0 } } };
    if (spec.type === 'profile-model') return spec.harness === 'opencode' ? 'openai/gpt-5' : spec.harness === 'claude-code' ? 'sonnet' : 'gpt-5';
    if (spec.type === 'profile-effort') return 'high';
    if (spec.type === 'credential-source') return 'deployment';
    return `# sample ${leaf}`;
  }
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
      expect({ leaf, answer }).toEqual({ leaf, answer: RETIRED_LEAVES.has(leaf) ? { applied: false, reason: 'retired', leaf } : { applied: true } });
    }
    const leaves = (await json(await worker.fetch(await asOwner('/api/settings'), e.all))).leaves as Array<Record<string, unknown>>;
    for (const leaf of DEPLOYMENT_LEAVES) {
      const row = leaves.find((l) => l.leaf === leaf)!;
      if (RETIRED_LEAVES.has(leaf)) { expect(row).toMatchObject({ configured: false, retired: true }); continue; }
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
