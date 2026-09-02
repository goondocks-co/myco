/**
 * The harness probe route: refuses without a bound runtime, drives it when
 * bound, and stays owner-only.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { wrappingKeyFromText } from '@myco-server-worker/platform/wrapping-key.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { asOwnerPost, OWNER_ENV } from './helpers/owner.js';

const WRAP_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

const setup = () => {
  const e = sqliteEnv();
  return { ...e, env: { ...e.env, ...OWNER_ENV, SECRET_WRAP_KEY: { get: async () => WRAP_KEY } } };
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

  it("probes a NAMED runtime in place, so a dispatched run's live state is readable", async () => {
    const { env } = setup();
    const probed: string[] = [];
    const stub = (name: string) => ({ beginRun: async () => { probed.push(name); }, fetch: async () => Response.json({ ok: true }) });
    const bound = { ...env, HARNESS: { idFromName: (name: string) => ({ name }), get: (id: { name: string }) => stub(id.name) } };
    const named = await worker.fetch(await asOwnerPost('/api/harness/probe', { runId: 'run_dispatched_1' }), bound);
    expect({ status: named.status, runId: ((await named.json()) as { runId: string }).runId }).toEqual({ status: 200, runId: 'run_dispatched_1' });
    expect(probed).toEqual(['run_dispatched_1']);
  });
});

describe('POST /api/harness/dispatch', () => {
  const seedProvider = (sqlite: { query: (sql: string) => { run: (...a: unknown[]) => unknown } }, leaves: Record<string, unknown>) => {
    for (const [leaf, value] of Object.entries(leaves)) {
      sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 1, 'test')`).run(leaf, JSON.stringify(value));
    }
  };

  it('refuses without a bound runtime, an unknown project, and a missing provider, each by name', async () => {
    const { env, sqlite } = setup();
    const unbound = await worker.fetch(await asOwnerPost('/api/harness/dispatch', { task: 'container-smoke', projectId: 'proj_1' }), env);
    expect(unbound.status).toBe(409);

    const launch: unknown[] = [];
    const bound = { ...env, HARNESS: { idFromName: (name: string) => ({ name }), get: () => ({ launch: async (spec: unknown) => { launch.push(spec); } }) } };
    const ghost = await worker.fetch(await asOwnerPost('/api/harness/dispatch', { task: 'container-smoke', projectId: 'proj_ghost' }), bound);
    expect({ status: ghost.status, reason: ((await ghost.json()) as { reason: string }).reason }).toEqual({ status: 400, reason: 'projectId names no Project this Deployment holds' });

    const unconfigured = await worker.fetch(await asOwnerPost('/api/harness/dispatch', { task: 'container-smoke', projectId: 'proj_1' }), bound);
    expect(unconfigured.status).toBe(400);
    seedProvider(sqlite, { 'agent.provider.type': 'ollama' });
    const unsupported = await worker.fetch(await asOwnerPost('/api/harness/dispatch', { task: 'container-smoke', projectId: 'proj_1' }), bound);
    expect(((await unsupported.json()) as { reason: string }).reason).toContain('ollama');
    seedProvider(sqlite, { 'agent.provider.type': 'anthropic' });
    const unknown = await worker.fetch(await asOwnerPost('/api/harness/dispatch', { task: 'no-such-task', projectId: 'proj_1' }), bound);
    expect({ status: unknown.status, reason: ((await unknown.json()) as { reason: string }).reason }).toEqual({ status: 400, reason: 'the task is not one this deployment serves' });
    expect(launch).toEqual([]);
  });

  it('launches with the whole dispatch as environment: a minted member credential that actually claims, the subscription token under its own variable, and the provider config', async () => {
    const { env, sqlite, db } = setup();
    seedProvider(sqlite, { 'agent.provider.type': 'anthropic', 'agent.provider.model': 'claude-opus-5' });
    await deploymentSecretStore(db, wrappingKeyFromText(async () => WRAP_KEY)).put('anthropic', 'sk-ant-oat-test-token', 'test', 1);

    const launches: Array<{ runId: string; timeoutSeconds: number; envVars: Record<string, string> }> = [];
    const bound = { ...env, HARNESS: { idFromName: (name: string) => ({ name }), get: () => ({ launch: async (spec: never) => { launches.push(spec); } }) } };
    const res = await worker.fetch(await asOwnerPost('/api/harness/dispatch', { task: 'container-smoke', projectId: 'proj_1', timeoutSeconds: 240 }), bound);
    const body = await res.json() as Record<string, unknown>;
    expect({ status: res.status, task: body.task, provider: body.provider }).toEqual({ status: 200, task: 'container-smoke', provider: 'anthropic' });

    expect(launches).toHaveLength(1);
    const spec = launches[0]!;
    expect(spec.runId).toBe(String(body.runId));
    expect(spec.timeoutSeconds).toBe(240);
    const vars = spec.envVars;
    expect({ url: vars.MYCO_SERVER_URL, project: vars.MYCO_PROJECT, task: vars.MYCO_TASK, run: vars.MYCO_RUN_ID, oat: vars.CLAUDE_CODE_OAUTH_TOKEN, apiKey: vars.ANTHROPIC_API_KEY, model: vars.MYCO_MODEL, admission: vars.MYCO_TASK_ADMISSION, params: vars.MYCO_TASK_PARAMS })
      .toEqual({ url: 'https://s', project: 'proj_1', task: 'container-smoke', run: spec.runId, oat: 'sk-ant-oat-test-token', apiKey: undefined, model: 'claude-opus-5', admission: 'cortex', params: undefined });
    expect(JSON.parse(vars.MYCO_PROVIDER_JSON!)).toEqual({ type: 'anthropic', model: 'claude-opus-5' });

    // The minted credential is real: it claims a run over the member surface.
    const claim = await worker.fetch(new Request('https://s/runs/claim', {
      method: 'POST',
      headers: memberHeaders(vars.MYCO_MEMBER_TOKEN!),
      body: JSON.stringify({ id: spec.runId, agentId: 'user', task: 'container-smoke', maxAgeSeconds: 3600, capability: 'cortex' }),
    }), bound);
    const claimed = await claim.json() as Record<string, unknown>;
    expect({ persisted: claimed.persisted, refusedOrClaimed: claimed.claimed !== undefined || claimed.notAdmitted !== undefined }).toEqual({ persisted: true, refusedOrClaimed: true });
  });

  it('ensures the runtime agent row on dispatch, and never edits one an owner registered', async () => {
    const { env, sqlite, db } = setup();
    seedProvider(sqlite, { 'agent.provider.type': 'anthropic', 'agent.provider.model': 'claude-opus-5' });
    await deploymentSecretStore(db, wrappingKeyFromText(async () => WRAP_KEY)).put('anthropic', 'sk-ant-oat-test-token', 'test', 1);
    const bound = { ...env, HARNESS: { idFromName: (name: string) => ({ name }), get: () => ({ launch: async () => {} }) } };

    const first = await worker.fetch(await asOwnerPost('/api/harness/dispatch', { task: 'container-smoke', projectId: 'proj_1' }), bound);
    expect(first.status).toBe(200);
    const ensured = sqlite.query(`SELECT name, provider, model, enabled FROM agents WHERE id = 'myco-agent'`).get() as Record<string, unknown>;
    expect(ensured).toEqual({ name: 'myco-agent', provider: 'anthropic', model: 'claude-opus-5', enabled: 1 });

    sqlite.query(`UPDATE agents SET name = 'Custom Name', model = 'claude-sonnet-5' WHERE id = 'myco-agent'`).run();
    const second = await worker.fetch(await asOwnerPost('/api/harness/dispatch', { task: 'container-smoke', projectId: 'proj_1' }), bound);
    expect(second.status).toBe(200);
    const kept = sqlite.query(`SELECT name, model FROM agents WHERE id = 'myco-agent'`).get() as Record<string, unknown>;
    expect(kept).toEqual({ name: 'Custom Name', model: 'claude-sonnet-5' });
  });
});
