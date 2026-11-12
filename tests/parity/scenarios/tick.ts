import { expect } from 'bun:test';
import { ageRows, type ParityScenario } from '../harness.ts';
import { allowWorkerClaims, owner, putSetting, wake } from '../clients/requests.ts';
import { askTitle, captureSession, failRun, runDetail, takeRun } from '../clients/runs.ts';

export const tick: ParityScenario = {
  name: 'the wake: current run retention converges through both front doors',
  dedicated: { timeoutMs: 180_000 },
  async run(target) {
    await allowWorkerClaims(target);
    expect((await putSetting(target, 'agent.scheduled_tasks_enabled', false)).status).toBe(200);
    expect((await putSetting(target, 'agent.run_retention_days', 30)).status).toBe(200);
    const session = `tick-${crypto.randomUUID()}`;
    await captureSession(target, session, 'retained task history');
    const old = { runId: await askTitle(target, session) };
    await failRun(target, await takeRun(target, old.runId));
    await ageRows(target, { table: 'agent_runs', column: 'started_at', byMs: 41 * 86_400_000, match: { project_id: target.projectId, id: old.runId } });
    await ageRows(target, { table: 'agent_runs', column: 'completed_at', byMs: 40 * 86_400_000, match: { project_id: target.projectId, id: old.runId } });
    await captureSession(target, session + '-live', 'live task history');
    const live = { runId: await askTitle(target, session + '-live') };
    await takeRun(target, live.runId);
    const first = await owner(target, '/api/wake', { method: 'POST' });
    expect(first.status).toBe(200);
    expect(first.body.jobs.every((job: any) => job.failed === null)).toBe(true);
    expect((await owner(target, `/api/projects/${target.projectId}/runs/${old.runId}`)).status).toBe(404);
    expect((await runDetail(target, live.runId)).run.status).toBe('running');
    await wake(target);
    expect((await owner(target, `/api/projects/${target.projectId}/runs/${old.runId}`)).status).toBe(404);
    expect((await runDetail(target, live.runId)).run.status).toBe('running');
  },
};
