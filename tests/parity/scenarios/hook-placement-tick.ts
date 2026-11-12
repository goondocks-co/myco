import { hookPlacement } from './hook-placement.ts';
import { owner } from '../clients/requests.ts';
import type { ParityScenario } from '../harness.ts';
import { expect } from 'bun:test';

export const hookPlacementTick: ParityScenario = {
  name: 'hook placement then wake: retention excludes fresh context answers',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    await hookPlacement.run(target);
    const read = () => owner(target, `/api/projects/${target.projectId}/sessions?limit=100`);
    const sessions = (await read()).body.rows;
    const contexts = async () => Promise.all(sessions.map(async (session: any) => (await owner(target, `/api/projects/${target.projectId}/sessions/${session.sessionId}/context-injections`)).body));
    const before = await contexts();
    const wake = await owner(target, '/api/wake', { method: 'POST', body: '{}' });
    expect(wake.status).toBe(200);
    expect(wake.body.jobs.filter((job: { failed: string | null }) => job.failed !== null)).toEqual([]);
    expect(await contexts()).toEqual(before);
  },
};
