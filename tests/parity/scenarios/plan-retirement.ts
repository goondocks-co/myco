import { expect } from 'bun:test';
import { expectPersisted, type ParityScenario } from '../harness.ts';

export const planRetirement: ParityScenario = {
  name: 'plan retirement: hides activity and withholds totals until cleanup',
  dedicated: { timeoutMs: 90_000 },
  async run(target) {
    const sessionId = `retiring-${Date.now()}`;
    const planKey = crypto.randomUUID();
    const post = (path: string, body: unknown) => fetch(`${target.url}${path}`, { method: 'POST',
      headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const get = async (path: string): Promise<any> => {
      const response = await fetch(`${target.url}${path}`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      return response.json();
    };
    const otherProject = `retirement_other_${Date.now()}`;
    expect((await post('/api/projects', { projectId: otherProject, name: 'Other Project' })).status).toBe(201);
    const keptSession = `${sessionId}-kept`;
    const keptPlan = crypto.randomUUID();
    const emit = async (session: string, project: string, key: string) => {
      for (const [kind, payload] of [['session.start', { agent: 'claude-code', startedAt: Date.now() }],
        ['plan', { planKey: key, title: 'Plan', content: '- [ ] work' }]] as const) {
        await expectPersisted(await fetch(`${target.url}/events`, { method: 'POST',
          headers: { ...target.memberHeaders({ 'x-myco-project': project }), 'content-type': 'application/json' },
          body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind, payload, createdAt: Date.now(), channel: 'cli', producer: { adapter: 'parity', version: '1' } }),
        }), kind);
      }
    };
    await emit(sessionId, target.projectId, planKey);
    await emit(keptSession, target.projectId, keptPlan);
    await emit(`${sessionId}-other`, otherProject, crypto.randomUUID());
    const board = `/api/plans?project=${target.projectId}`;
    const home = `/api/projects/${target.projectId}/activity`;
    const session = `/api/projects/${target.projectId}/sessions/${sessionId}`;
    expect((await get(board)).plans.map((plan: { planKey: string }) => plan.planKey)).toEqual(expect.arrayContaining([planKey, keptPlan]));
    expect((await post(`${session}/tombstone`, {})).status).toBe(202);
    const retiring = await get(board);
    expect(retiring).toMatchObject({ counting: 'building' });
    expect(retiring.plans.map((plan: { planKey: string }) => plan.planKey)).toEqual([keptPlan]);
    expect(await get('/api/plans')).toMatchObject({ totals: { active: 1 } });
    expect(retiring.totals).toBeUndefined();
    const during = await get(home);
    expect(during).toMatchObject({ building: false, stats: { state: 'ready', sessions: 1, plans: null } });
    expect(during.items.map((item: { id: string }) => item.id).sort()).toEqual([keptSession, keptPlan].sort());
    for (let wake = 0; wake < 30 && (await get(`${session}/deletion`)).deletion.state !== 'complete'; wake++) {
      expect((await post('/api/wake', {})).status).toBe(200);
    }
    expect(await get(`${session}/deletion`)).toMatchObject({ deletion: { state: 'complete' } });
    expect(await get(board)).toMatchObject({ totals: { active: 1 } });
    expect(await get('/api/plans')).toMatchObject({ totals: { active: 2 } });
    expect(await get(home)).toMatchObject({ building: false, stats: { state: 'ready', plans: 1 } });
  },
};
