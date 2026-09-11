/**
 * The harness dispatch route: what it refuses, and the whole environment a
 * dispatch carries to the runtime it hands the run to.
 */
import { jsonBody } from '../helpers/json-body.js';
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { wrappingKeyFromText } from '@myco-server-worker/platform/wrapping-key.js';
import { taskEntriesSince } from '@myco-server-worker/core/runs.js';
import { dispatchTask } from '@myco-server-worker/core/harness.js';
import { memberHeaders, sqliteEnv, withHarness } from './helpers/fixtures.js';
import { asOwnerPost, OWNER_ENV } from './helpers/owner.js';

const WRAP_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

const setup = () => {
  const e = sqliteEnv();
  return { ...e, env: { ...e.env, ...OWNER_ENV, SECRET_WRAP_KEY: { get: async () => WRAP_KEY } } };
};

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

    const bound = { ...env, HARNESS_LAUNCH_MODE: 'record' };
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
  });

  it('admits ad-hoc work with no automatic budget and keeps normal concurrency limits', async () => {
    const { env, sqlite, db } = setup();
    seedProvider(sqlite, {
      'agent.provider.type': 'openai-compatible', 'agent.provider.model': 'm', 'agent.provider.base_url': 'http://models.internal/v1',
      'agent.tasks': { 'container-smoke': { schedule: { maxRunsPerDay: 0 } } },
      'agent.limits.concurrent_runs': 1,
    });
    const dispatch = async () => worker.fetch(await asOwnerPost('/api/harness/dispatch', { task: 'container-smoke', projectId: 'proj_1' }), { ...env, HARNESS_LAUNCH_MODE: 'record' });
    expect(await jsonBody(await dispatch())).toMatchObject({ queued: false });
    const response = await dispatch();
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toMatchObject({ queued: true, heldBy: 'concurrent_runs' });
    expect(await taskEntriesSince(db, { projectId: 'proj_1' }, 'container-smoke', 0, 'clock')).toBe(0);
    expect(await taskEntriesSince(db, { projectId: 'proj_1' }, 'container-smoke', 0)).toBe(2);
  });

  it('launches with the whole dispatch as environment: a minted member credential that actually claims, the subscription token under its own variable, and the provider config', async () => {
    const { env, sqlite, db } = setup();
    seedProvider(sqlite, { 'agent.provider.type': 'anthropic', 'agent.provider.model': 'claude-opus-5' });
    await deploymentSecretStore(db, wrappingKeyFromText(async () => WRAP_KEY, 'test')).put('anthropic', 'sk-ant-oat-test-token', 'test', 1);

    // The environment is read off the dispatcher: no target hands a runtime to
    // the entry, so a launch is observable only where the dispatcher makes it.
    const launches: Array<{ runId: string; timeoutSeconds: number; envVars: Record<string, string> }> = [];
    const bound = env;
    const dispatched = await dispatchTask(
      withHarness(() => serverEnvFromBindings(bound as never), { launch: async (spec) => { launches.push(spec); } }),
      'container-smoke', 'proj_1', { serverUrl: 'https://s', actor: 'mem_owner', timeoutSeconds: 240 }, Date.now(),
    );
    // The provider reaching the runtime is asserted below, off the environment itself.
    expect(dispatched.dispatched).toBe(true);

    expect(launches).toHaveLength(1);
    const spec = launches[0]!;
    expect(spec.timeoutSeconds).toBe(240);
    const vars = spec.envVars;
    expect({ url: vars.MYCO_SERVER_URL, project: vars.MYCO_PROJECT, task: vars.MYCO_TASK, run: vars.MYCO_RUN_ID, oat: vars.CLAUDE_CODE_OAUTH_TOKEN, model: vars.MYCO_MODEL, admission: vars.MYCO_TASK_ADMISSION, params: vars.MYCO_TASK_PARAMS })
      .toEqual({ url: 'https://s', project: 'proj_1', task: 'container-smoke', run: spec.runId, oat: 'sk-ant-oat-test-token', model: 'claude-opus-5', admission: 'cortex', params: JSON.stringify({ timeoutSeconds: 240 }) });
    expect(vars.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.parse(vars.MYCO_PROVIDER_JSON!)).toEqual({ type: 'anthropic', model: 'claude-opus-5' });

    // The dispatch wrote the run's row before the launch; the minted credential is real and claims exactly that row over the member surface.
    expect(sqlite.query(`SELECT status, task, agent_id FROM agent_runs WHERE id = ?`).get(spec.runId)).toEqual({ status: 'pending', task: 'container-smoke', agent_id: 'myco-agent' });
    sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, 1, 'test')`).run();
    const claim = await worker.fetch(new Request('https://s/runs/claim', {
      method: 'POST',
      headers: memberHeaders(vars.MYCO_MEMBER_TOKEN!),
      body: JSON.stringify({ id: spec.runId, agentId: 'user', task: 'container-smoke', capability: 'cortex' }),
    }), bound);
    expect(await jsonBody(claim)).toEqual({ persisted: true, claimed: true, runId: spec.runId });
    expect(sqlite.query(`SELECT status, agent_id FROM agent_runs WHERE id = ?`).get(spec.runId)).toEqual({ status: 'running', agent_id: 'myco-agent' });
    // A run the server never dispatched cannot be minted by that credential.
    const foreign = await worker.fetch(new Request('https://s/runs/claim', {
      method: 'POST',
      headers: memberHeaders(vars.MYCO_MEMBER_TOKEN!),
      body: JSON.stringify({ id: 'run_self_minted', agentId: 'user', task: 'container-smoke', capability: 'cortex' }),
    }), bound);
    expect(await jsonBody(foreign)).toEqual({ persisted: true, claimed: false, running: null });
  });

  it('ensures the runtime agent row on dispatch, and never edits one an owner registered', async () => {
    const { env, sqlite, db } = setup();
    seedProvider(sqlite, { 'agent.provider.type': 'anthropic', 'agent.provider.model': 'claude-opus-5' });
    await deploymentSecretStore(db, wrappingKeyFromText(async () => WRAP_KEY, 'test')).put('anthropic', 'sk-ant-oat-test-token', 'test', 1);
    const bound = { ...env, HARNESS_LAUNCH_MODE: 'record' };

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
