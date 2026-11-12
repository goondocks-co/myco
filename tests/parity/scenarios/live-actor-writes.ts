import { embeddingFixture } from '../embedding/provider.ts';
import { expect } from 'bun:test';
import { type ParityScenario, type ParityTarget } from '../harness.ts';
import { revisionHeaders } from '../settings-revision.ts';
import { assignRole, memberView, person, selectOwner } from '../clients/identity.ts';
import { owner, putCapability, putSetting } from '../clients/requests.ts';
import { runList } from '../clients/runs.ts';

const TASK = 'title-summary';

async function request(target: ParityTarget, path: string, method: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  return fetch(`${target.url}${path}`, {
    method, headers: { ...headers, origin: target.url, 'content-type': 'application/json', ...(/^\/api\/(settings\/|titling-backfill|embedding$)/.test(path) || /\/capabilities\//.test(path) ? await revisionHeaders(target, path, body) : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Demotion commits on the serving store before the guarded mutation batch begins. One representative race per guard:
 * the settings write, a fresh dispatch and the recovery forget; the write-boundary matrix over every worker path, revocation included, is
 * `live-worker-writes.test.ts` and `member-write-store.test.ts`.
 */
export const liveActorWrites: ParityScenario = {
  name: 'live actor writes: settings and dispatch refuse demotion at the native and D1 commit',
  dedicated: { cloudflare: { main: '../../tests/parity/owner-review/embedding-worker-entry.ts' }, stopRace: true, timeoutMs: 240_000 },
  async run(target) {
    const stopProvider = await embeddingFixture(target);
    try {
    await selectOwner(target);
    const adminActor = await person(target, '720901', { role: 'admin', login: 'live-write' });
    const memberActor = await person(target, '720902', { login: 'live-write' });
    const admin = adminActor.session;
    const member = memberActor.session;
    expect((await putCapability(target, 'vault_evolution', true)).status).toBe(200);
    for (const [leaf, value] of [['agent.tasks', { [TASK]: { schedule: { memberRunsPerDay: 1 } } }],
      ...['claude-code', 'codex', 'opencode'].map((harness) => [`agent.harnesses.${harness}.credential`, 'worker-login'] as const)] as const) {
      expect((await putSetting(target, leaf, value)).status).toBe(200);
    }
    expect((await request(target, '/api/settings/agent.reasoning_map.claude-code.default', 'PUT', admin, { value: 'claude-opus-5' })).status).toBe(200);
    expect((await request(target, '/api/secrets/anthropic', 'PUT', admin, { value: 'synthetic-subscription' })).status).toBe(200);
    const runs = async () => (await runList(target)).map(({ id, task, status }) => ({ id, task, status }));
    const learningAsk = { task: 'extract-curate', projectId: target.projectId, fresh: true };
    const beforeLearning = await runs();
    const memberLearning = await request(target, '/api/harness/dispatch', 'POST', member, learningAsk);
    expect({ status: memberLearning.status, body: await memberLearning.json() }).toEqual({ status: 403, body: { error: 'fresh_needs_admin' } });
    expect(await runs()).toEqual(beforeLearning);
    const adminLearning = await request(target, '/api/harness/dispatch', 'POST', admin, learningAsk);
    expect({ status: adminLearning.status, body: await adminLearning.json() }).toMatchObject({ status: 200, body: { queued: true, task: 'extract-curate' } });
    const setting = async () => (await owner(target, '/api/settings')).body.leaves.find((row: { leaf: string }) => row.leaf === 'agent.scheduled_tasks_enabled');
    const projectName = async () => (await owner(target, '/api/projects')).body.projects.find((row: { projectId: string }) => row.projectId === target.projectId)?.name;
    const cases = [
      { path: '/api/harness/dispatch', method: 'POST', body: { task: 'embedding-reconcile', projectId: target.projectId, fresh: true, timeoutSeconds: 123 }, read: runs },
      { path: '/api/settings/agent.scheduled_tasks_enabled', method: 'PUT', body: { value: true }, read: setting },
      { path: '/api/harness/dispatch', method: 'POST', body: { task: TASK, projectId: target.projectId, fresh: true, timeoutSeconds: 123 }, read: runs },
      { path: `/api/projects/${target.projectId}`, method: 'PATCH', body: { name: 'renamed' }, read: projectName },
    ];
    // A member is refused every protected write, and nothing it would have written is read back.
    for (const operation of cases) {
      const before = await operation.read();
      expect((await request(target, operation.path, operation.method, member, operation.body)).status).toBe(403);
      expect(await operation.read()).toEqual(before);
    }
    const race = async (write: string, send: () => Promise<Response>, unchanged: () => Promise<unknown>) => {
      const before = await unchanged();
      expect((await request(target, '/__parity/stop-race/arm', 'POST', {}, { memberId: adminActor.id, write })).status).toBe(200);
      const refused = await send();
      expect(refused.status).toBe(403);
      expect(await unchanged()).toEqual(before);
      expect(await (await fetch(`${target.url}/__parity/stop-race/status`)).json() as Record<string, unknown>).toEqual({ fired: true, armed: false });
      expect((await memberView(target, adminActor.id))?.role).toBe('member');
      expect((await assignRole(target, adminActor.id, 'admin')).status).toBe(200);
      return refused;
    };
    // The admin is demoted after its authority was read and before the setting's write commits: refused, nothing written.
    const settingRace = cases[1]!;
    const refusedSetting = await race('INSERT INTO deployment_settings', () => request(target, settingRace.path, settingRace.method, admin, settingRace.body), settingRace.read);
    expect(await refusedSetting.json() as Record<string, unknown>).toEqual({ error: 'not_admin', reason: 'this action is for an admin' });
    // The same demotion at a fresh dispatch's insert queues no run.
    const dispatchRace = cases[0]!;
    const refusedDispatch = await race('INSERT INTO agent_runs', () => request(target, dispatchRace.path, dispatchRace.method, admin, dispatchRace.body), dispatchRace.read);
    expect(await refusedDispatch.json() as Record<string, unknown>).toEqual({ error: 'fresh_needs_admin' });
    // The same demotion at a recovery forget's write: no forget command is issued, which no route lists.
    const forgets = () => target.sql('SELECT COUNT(*) AS n FROM recovery_forget_commands');
    await race('INSERT INTO recovery_forget_commands', () => request(target, '/__parity/live-write', 'POST', {}, { memberId: adminActor.id, operation: 'recovery', projectId: target.projectId }), forgets);
    // The live admin then makes every write.
    for (const operation of cases) {
      const before = await operation.read();
      expect((await request(target, operation.path, operation.method, admin, operation.body)).status).toBe(200);
      expect(await operation.read()).not.toEqual(before);
    }
    const ordinary = { task: TASK, projectId: target.projectId, timeoutSeconds: 123 };
    expect((await request(target, '/api/harness/dispatch', 'POST', member, ordinary)).status).toBe(200);
    expect((await request(target, '/api/harness/dispatch', 'POST', member, ordinary)).status).toBe(429);
    } finally { stopProvider(); }
  },
};
