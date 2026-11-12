import { expect } from 'bun:test';
import { ageRows, type ParityScenario } from '../harness.ts';
import { allowWorkerClaims, claimRun, createProject, event, owner, putCapability, putSetting, wake } from '../clients/requests.ts';
import { cancelRun, captureSession, dispatch, finishRun, repository, runList, takeRun } from '../clients/runs.ts';

/** The schedule queues live map work once and keeps cold history out. */
export const scheduledTasks: ParityScenario = {
  name: 'the clock: map work queued once, held by its interval, capped by its ceiling, withheld from a cold Project',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    await allowWorkerClaims(target);
    const tasks = (map: Record<string, unknown>) => putSetting(target, 'agent.tasks', { 'title-summary': { schedule: { maxRunsPerDay: 0 } }, 'canopy-map': { schedule: map } });
    expect((await tasks({ enabled: false })).status).toBe(200);
    expect((await putSetting(target, 'agent.scheduled_tasks_enabled', true)).status).toBe(200);
    const cold = { ...target, projectId: 'proj_cold' };
    expect((await createProject(target, cold.projectId, 'cold')).status).toBe(201);
    for (const project of [target, cold]) {
      expect((await putCapability(project, 'canopy', true)).status).toBe(200);
      await repository(project);
      await captureSession(project, 'clock-session', 'Map the captured project', { channel: 'import', ended: true });
    }
    const coldAge = 21 * 86_400_000;
    await ageRows(target, { table: 'projects', column: 'created_at', byMs: coldAge, match: { project_id: cold.projectId } });
    await ageRows(target, { table: 'sessions', column: 'last_received_at', byMs: coldAge, match: { project_id: cold.projectId, session_id: 'clock-session' } });
    const maps = (project = target) => runList(project, 'task=canopy-map');
    await wake(target);
    expect(await maps()).toEqual([]);
    const schedule = { enabled: true, preCondition: 'has-capture-since-map', runIn: ['active', 'idle', 'sleep'], reservedRunsPerDay: { count: 0, preCondition: 'has-capture-since-map' } };
    expect((await tasks(schedule)).status).toBe(200);
    // A claim reports this worker's repository capabilities before the schedule decides availability.
    expect(await claimRun(target)).toMatchObject({ claimed: false });
    await wake(target);
    const [queued] = await maps();
    expect(queued).toMatchObject({ status: 'queued', harness: null, startedBy: 'clock' });
    expect(await maps(cold)).toEqual([]);
    await wake(target);
    expect(await maps()).toHaveLength(1);
    const run = await takeRun(target, queued.id);
    expect(await finishRun(target, run)).toMatchObject({ ended: true });
    await event(target, 'clock-session', 'prompt', { promptId: crypto.randomUUID(), text: 'Map the next change', origin: 'user' });
    expect((await tasks({ ...schedule, intervalSeconds: 0, maxRunsPerDay: 1 })).status).toBe(200);
    await wake(target);
    const atCeiling = await maps();
    expect(atCeiling.map(row => row.status).sort()).toEqual(['failed', 'skipped']);
    expect(atCeiling.find(row => row.status === 'skipped')).toMatchObject({ skipReasonCode: 'max_runs_per_day' });
    await wake(target);
    expect((await maps()).map(row => row.id).sort()).toEqual(atCeiling.map(row => row.id).sort());
    const manual = await dispatch(target, 'canopy-map');
    expect(await maps()).toHaveLength(3);
    await cancelRun(target, manual.runId);
    expect((await putSetting(target, 'agent.scheduled_tasks_enabled', false)).status).toBe(200);
    const off = await owner(target, '/api/wake', { method: 'POST' });
    expect(off.status).toBe(200); expect(off.body.scheduled).toEqual({ dispatched: 0, skipped: 0 });
  },
};
