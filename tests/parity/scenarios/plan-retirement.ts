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
    for (const [kind, payload] of [['session.start', { agent: 'claude-code', startedAt: Date.now() }],
      ['plan', { planKey, title: 'Retiring plan', content: '- [ ] retire' }]] as const) {
      await expectPersisted(await fetch(`${target.url}/events`, { method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, payload, createdAt: Date.now(), channel: 'cli', producer: { adapter: 'parity', version: '1' } }),
      }), kind);
    }
    const board = `/api/plans?project=${target.projectId}`;
    const home = `/api/projects/${target.projectId}/activity`;
    const session = `/api/projects/${target.projectId}/sessions/${sessionId}`;
    expect((await get(board)).plans.map((plan: { planKey: string }) => plan.planKey)).toEqual([planKey]);
    expect((await post(`${session}/tombstone`, {})).status).toBe(202);
    const retiring = await get(board);
    expect(retiring).toMatchObject({ plans: [], counting: 'building' });
    expect(retiring.totals).toBeUndefined();
    expect(await get(home)).toMatchObject({ items: [], building: true });
    for (let wake = 0; wake < 30 && (await get(`${session}/deletion`)).deletion.state !== 'complete'; wake++) {
      expect((await post('/api/wake', {})).status).toBe(200);
    }
    expect(await get(`${session}/deletion`)).toMatchObject({ deletion: { state: 'complete' } });
    expect(await get(board)).toMatchObject({ plans: [], totals: {} });
    expect(await get(home)).toMatchObject({ items: [], building: false });
  },
};
