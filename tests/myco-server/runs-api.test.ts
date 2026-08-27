/**
 * The run control plane over HTTP, through the deployed entry.
 *
 * `runs.test.ts` proves the store's atomicity directly. This proves the surface
 * the agent actually calls: that the compare-and-swap survives being split into
 * a read and a guarded write across two requests, which is the only form
 * `mutateState` can take once its caller is in another process.
 */
import { describe, expect, it } from 'bun:test';
import { memberPost, sqliteEnv } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import worker from '@myco-server-worker/index.js';

const AGENT = 'agent_1';

async function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const t = await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
  fixture.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`).run(Date.now());
  fixture.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, Date.now());
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
    await (await worker.fetch(memberPost(t.token, body, path), env)).json() as Record<string, unknown>;
  return { ...fixture, env, token: t, post };
}

describe('POST /runs/claim', () => {
  it('claims once and reports the live run to the loser, both answered as persisted', async () => {
    const { post } = await harness();
    const first = await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', maxAgeSeconds: 3600 });
    expect(first).toEqual({ persisted: true, claimed: true, runId: 'r1' });

    const second = await post('/runs/claim', { id: 'r2', agentId: AGENT, task: 'digest', maxAgeSeconds: 3600 });
    expect(second.persisted).toBe(true);
    expect(second.claimed).toBe(false);
    expect((second.running as { id: string }).id).toBe('r1');
  });

  it('attributes the run to the presented credential and never to a body field', async () => {
    const { post, sqlite, token } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', maxAgeSeconds: 3600, dispatchedBy: 'someone_else' });
    expect((sqlite.query(`SELECT dispatched_by d FROM agent_runs WHERE id = 'r1'`).get() as { d: string }).d).toBe(token.tokenId);
  });

  it('refuses a malformed claim terminally, in the route shape and with a code', async () => {
    const { post, sqlite } = await harness();
    const res = await post('/runs/claim', { id: 'r1', agentId: AGENT });
    expect({ persisted: res.persisted, coded: typeof res.code === 'string' }).toEqual({ persisted: false, coded: true });
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs`).get() as { c: number }).c).toBe(0);
  });

  it('claims per project: the same task in another Project is not blocked', async () => {
    const { post, sqlite, env, token } = await harness();
    sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_2', 'proj_2', ?)`).run(Date.now());
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', maxAgeSeconds: 3600 });
    const other = await (await worker.fetch(
      memberPost(token.token, { id: 'r2', agentId: AGENT, task: 'digest', maxAgeSeconds: 3600 }, '/runs/claim', { 'x-myco-project': 'proj_2' }),
      env)).json() as Record<string, unknown>;
    expect(other).toEqual({ persisted: true, claimed: true, runId: 'r2' });
  });
});

describe('agent state over HTTP', () => {
  it('carries a read-modify-write across two requests, and refuses the write whose read is stale', async () => {
    const { post } = await harness();
    expect(await post('/runs/state/read', { agentId: AGENT, key: 'k' })).toEqual({ persisted: true, value: null, updatedAt: null });

    // Both callers read the same absent value; only one write may land.
    const a = await post('/runs/state/write', { agentId: AGENT, key: 'k', value: 'from-a' });
    const b = await post('/runs/state/write', { agentId: AGENT, key: 'k', value: 'from-b' });
    expect([a.applied, b.applied]).toEqual([true, false]);

    const read = await post('/runs/state/read', { agentId: AGENT, key: 'k' });
    expect(read.value).toBe('from-a');

    // The loser reads again and offers what it now holds — the retry the caller owns.
    const retry = await post('/runs/state/write', { agentId: AGENT, key: 'k', value: 'from-b', expected: read.value });
    expect(retry.applied).toBe(true);
    expect((await post('/runs/state/read', { agentId: AGENT, key: 'k' })).value).toBe('from-b');
  });

  it('keeps state per project', async () => {
    const { post, sqlite, env, token } = await harness();
    sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_2', 'proj_2', ?)`).run(Date.now());
    await post('/runs/state/write', { agentId: AGENT, key: 'shared', value: 'one' });
    await worker.fetch(memberPost(token.token, { agentId: AGENT, key: 'shared', value: 'two' }, '/runs/state/write', { 'x-myco-project': 'proj_2' }), env);
    expect((await post('/runs/state/read', { agentId: AGENT, key: 'shared' })).value).toBe('one');
  });
});

describe('agent registration', () => {
  it('is idempotent and keeps the identity across a re-declaration', async () => {
    const { env, sqlite } = await harness();
    const put = async (body: unknown) => new Request('https://s/api/agents/agent_2', {
      method: 'PUT',
      headers: { cookie: (await asOwner('/')).headers.get('cookie')!, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await worker.fetch(await put({ name: 'first', model: 'm1' }), env)).status).toBe(200);
    const created = (sqlite.query(`SELECT created_at c FROM agents WHERE id = 'agent_2'`).get() as { c: number }).c;
    expect((await worker.fetch(await put({ name: 'second', model: 'm2' }), env)).status).toBe(200);
    const row = sqlite.query(`SELECT name, model, created_at c FROM agents WHERE id = 'agent_2'`).get() as { name: string; model: string; c: number };
    expect(row).toEqual({ name: 'second', model: 'm2', c: created });
  });
});
