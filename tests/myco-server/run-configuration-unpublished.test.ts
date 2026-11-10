/**
 * A run's configuration columns stay in storage. The run list, a run's detail and the MCP `myco_agent` run read publish
 * the run's phases parsed out of `checkpoints` and the named keys of `run_context` they describe the run by, and nothing
 * else from `execution_overrides`, `run_context`, `cost_data` or `checkpoints`: whatever a dispatch put there never
 * reaches a dashboard or an agent.
 *
 * The run is written the way the server writes one: its dispatch through `recordDispatch`, its configuration and its
 * end through `applyRunUpdate`. The one SQL write is the built-in agent row, which a Deployment holds from install and
 * no route the test can reach writes.
 */
import { expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/constants.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { recordDispatch } from '@myco-server-worker/db/runs/claim.js';
import { applyRunUpdate } from '@myco-server-worker/db/runs/change.js';
import { issueMemberToken } from './helpers/member-token.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';

const MARKERS = ['context-marker-7f3a', 'override-marker-91c2', 'override-secret-91c2', 'cost-marker-44de', 'checkpoint-marker-0b8e'];

it('the run list, detail and MCP run read publish phases and named context keys, never the configuration columns', async () => {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const now = Date.now();
  seedMemberRoleAccount(fixture.sqlite);
  await ensureMember(fixture.db, HARNESS_MEMBER_ID, now, 'member', 'harness');
  const harness = await issueMemberToken(fixture.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, now);
  const reader = await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
  fixture.sqlite.run("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,0)");
  const scope = { projectId: 'proj_1' };
  expect(await recordDispatch(fixture.db, scope, { id: 'run_1', agentId: 'myco-agent', task: 'extract-curate', provider: null, model: null,
    runContext: JSON.stringify({ reason: 'learning_paused', session_id: 's_named', provider_key: 'context-marker-7f3a' }),
    startedAt: now, dispatchedBy: harness.tokenId })).toBe(true);
  expect(await applyRunUpdate(fixture.db, scope, 'run_1', {
    status: 'skipped', completed_at: now,
    execution_overrides: JSON.stringify({ model: 'override-marker-91c2', apiKey: 'override-secret-91c2' }),
    cost_data: JSON.stringify({ provider: 'cost-marker-44de', invoice: 'cost-marker-44de' }),
    checkpoints: JSON.stringify({ phases: { gather: { status: 'done', summary: 'gathered' } }, providerConfig: 'checkpoint-marker-0b8e' }),
  })).toBe(1);

  const get = async (path: string) => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(fixture.db, Date.now()), 'cf-connecting-ip': '1.2.3.4' } }), env);
    expect(res.status).toBe(200);
    return res.text();
  };
  const mcp = async () => {
    const res = await worker.fetch(new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(reader.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_agent', arguments: { op: 'run', id: 'run_1', project: 'proj_1' } } }) }), env);
    expect(res.status).toBe(200);
    return res.text();
  };
  const list = await get('/api/projects/proj_1/runs');
  const detail = await get('/api/projects/proj_1/runs/run_1');
  const agentRun = await mcp();
  for (const [surface, body] of [['list', list], ['detail', detail], ['myco_agent run', agentRun]] as const) {
    expect({ surface, names: body.includes('run_1') }).toEqual({ surface, names: true });
    for (const marker of MARKERS) expect({ surface, marker, published: body.includes(marker) }).toEqual({ surface, marker, published: false });
  }
  expect((JSON.parse(agentRun) as { result: { structuredContent: { result: unknown } } }).result.structuredContent.result)
    .toMatchObject({ ok: true, op: 'run', data: { run: { id: 'run_1', status: 'skipped' } } });
  const run = JSON.parse(detail) as { phases: Array<Record<string, unknown>> };
  expect(run.phases).toEqual([expect.objectContaining({ name: 'gather', status: 'done', summary: 'gathered' })]);
  expect(detail).toContain('s_named');
  expect(detail).toContain('learning_paused');
});
