import { RUN_AUDIT } from '../../helpers/run-audit.ts';
import { expect } from 'bun:test';
import { ageRows, type ParityScenario } from '../harness.ts';
import { event, owner, allowWorkerClaims, putCapability, putSetting, runTool } from '../clients/requests.ts';
import { asMember, linkedMember, repository, dispatch, takeRun, worker } from '../clients/runs.ts';

const DAY_MS = 86_400_000;
export const today: ParityScenario = {
  name: 'today: the lists across Projects, Myco\'s work, capture recency and Needs you, read by a member and an admin',
  dedicated: { timeoutMs: 180_000 },
  async run(target) {
    await allowWorkerClaims(target);
    expect((await putSetting(target, 'agent.scheduled_tasks_enabled', false)).status).toBe(200);
    expect((await putCapability(target, 'vault_evolution', true)).status).toBe(200);
    await repository(target);
    const joined = await linkedMember(target, '1518001');
    const member = asMember(target, joined.token);
    const read = (path: string) => owner({ ...target, ownerHeaders: () => joined.headers }, path);
    const stamp = Date.now(), sessionId = `today-${crypto.randomUUID()}`;
    await event(member, sessionId, 'session.start', { agent: 'claude-code', startedAt: stamp });
    expect((await read(`/api/sessions?since=${stamp}&agent=claude-code`)).body.rows.find((row: any) => row.sessionId === sessionId)).toMatchObject({ projectId: target.projectId, agent: 'claude-code' });
    await ageRows(target, { table: 'sessions', column: 'started_at', byMs: 2 * DAY_MS, match: { project_id: target.projectId, session_id: sessionId } });
    const since = stamp - 60_000, until = Date.now() + 60_000;
    for (const path of ['/api/sessions', `/api/projects/${target.projectId}/sessions`]) expect((await read(`${path}?since=${since}&until=${until}&window=activity`)).body.rows.some((row: any) => row.sessionId === sessionId)).toBe(true);
    expect((await read(`/api/sessions?since=${since}&until=${until}`)).body.rows.some((row: any) => row.sessionId === sessionId)).toBe(false);
    const queued = await dispatch(target, 'vault-seed');
    const run = await takeRun(target, queued.runId);
    const spore = await runTool(target, run, 'myco_spores', { op: 'save', type: 'gotcha', content: 'parity today', agent_line: 'Keep the daily outcome.' });
    expect(await runTool(target, run, 'myco_run', { op: 'report', action: 'seed', summary: 'seeded the Project', audit: RUN_AUDIT })).toMatchObject({ recorded: true });
    expect(await worker(target, 'end', { projectId: target.projectId, runId: run.id, attemptId: run.attemptId, status: 'completed', usage: { inputTokens: 1200, outputTokens: 0, costUsd: 0.42 } })).toMatchObject({ ended: true, status: 'completed' });
    const spores = await read(`/api/spores?project=${target.projectId}`);
    expect(spores.status).toBe(200);
    expect(spores.body.spores.find((row: any) => row.id === spore.id)).toMatchObject({ projectId: target.projectId, author: run.id });
    expect(spores.body.facets.project[target.projectId]).toBeGreaterThanOrEqual(1);
    expect(Array.isArray((await read('/api/plans')).body.plans)).toBe(true);
    const utcDay = Math.floor(stamp / DAY_MS) * DAY_MS;
    const work = await read(`/api/work?project=${target.projectId}&since=${utcDay}&until=${utcDay + DAY_MS}`);
    expect(work.status).toBe(200);
    expect(work.body.summary).toEqual([expect.objectContaining({ projectId: target.projectId, kind: 'seed', runs: { completed: 1 }, outcome: { spores: 1, sessions: 0, maps: 0 }, tokens: 1200, costUsd: 0.42 })]);
    expect(work.body.timeline.map((row: any) => [row.id, row.result])).toEqual([[run.id, 'produced']]);
    expect(work.body.upkeep).toMatchObject({ task: 'embedding-reconcile' });
    const status = await read('/api/status'); expect(status.status).toBe(200);
    expect(status.body.capture.some((row: any) => row.projectId === target.projectId && row.agent === 'claude-code')).toBe(true);
    expect(await read('/api/attention')).toMatchObject({ status: 403, body: { error: 'not_admin' } });
    const needs = await owner(target, '/api/attention'); expect(needs.status).toBe(200);
    expect(Array.isArray(needs.body.items)).toBe(true);
    expect(needs.body.unavailable.filter((kind: string) => kind !== 'backup_overdue')).toEqual([]);
    expect(needs.body.items.filter((item: any) => item.kind === 'schema_mismatch')).toEqual([]);
    await dispatch(target, 'vault-seed', { fresh: true });
    expect((await read(`/api/work?project=${target.projectId}`)).body.summary.find((row: any) => row.kind === 'seed')).toMatchObject({ runs: { queued: 1 }, failure: null });
  },
};
