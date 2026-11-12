import { expect } from 'bun:test';
import { expectPersisted, type ParityScenario, type ParityTarget } from '../harness.ts';
import { createProject, event, owner } from '../clients/requests.ts';

/**
 * A Project's plan list at the size a real Project reaches: more plans than one statement may bind as parameters,
 * each tagged, read a full page at a time and then page by page to the end, on both targets.
 */
export const plansAtScale: ParityScenario = {
  name: 'plans at scale: a full page past the parameter ceiling, tags on every row, and every plan by pages',
  async run(target: ParityTarget) {
    const targetHeaders = target.memberHeaders;
    const stamp = Date.now();
    const session = `parity-plans-scale-${stamp}`;
    const count = 230;
    const projectId = `proj_scale_${stamp}`;
    expect((await createProject(target, projectId, 'Plan pagination')).status).toBe(201);
    target = { ...target, projectId, memberHeaders: (extra = {}) => targetHeaders({ 'x-myco-project': projectId, ...extra }) };
    await expectPersisted(await fetch(`${target.url}/events`, { method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind: 'session.start', createdAt: stamp, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload: { agent: 'claude-code', startedAt: stamp } }) }), 'session.start');
    const saved: Array<{ id: string; updated: number }> = [];
    for (let i = 0; i < count; i++) {
      const id = crypto.randomUUID(), updated = stamp + Math.floor(i / 5);
      await event(target, session, 'plan', { planKey: id, title: `Plan ${i}`, content: '- [x] one', tags: [`t${i % 3}`] }, updated);
      saved.push({ id, updated });
    }
    try {
      const read = async (query: string) => {
        const res = await fetch(`${target.url}/api/projects/${target.projectId}/plans?${query}`, { headers: { ...target.ownerHeaders(), origin: target.url } });
        return { status: res.status, body: await res.json() as { plans: { planKey: string; tags: string[]; updatedAt: number }[]; cursor?: string | null } };
      };
      for (const limit of [100, 200]) {
        const answer = await read(`limit=${limit}`);
        expect({ limit, status: answer.status }).toEqual({ limit, status: 200 });
        const ours = answer.body.plans.filter((p) => saved.some(row => row.id === p.planKey));
        expect(ours.length).toBe(limit);
        expect(ours.every((p) => p.tags.length === 1)).toBe(true);
        expect(ours.map(p => [p.planKey, p.updatedAt])).toEqual(saved.toSorted((a,b) => b.updated - a.updated || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, limit).map(row => [row.id, row.updated]));
      }
      // Page by page to the end, every plan once, in the order the list keeps.
      const seen: string[] = [];
      let cursor: string | null | undefined = null;
      for (let pages = 0; pages < 40; pages += 1) {
        const answer = await read(`limit=37${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor!)}`}`);
        expect(answer.status).toBe(200);
        seen.push(...answer.body.plans.map((p) => p.planKey));
        cursor = answer.body.cursor;
        if (cursor === null || cursor === undefined) break;
      }
      expect(cursor).toBeNull();
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(saved.sort((a,b) => b.updated - a.updated || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).map(row => row.id));
    } finally {
      expect((await owner(target, `/api/projects/${projectId}/archive`, { method: 'POST' })).status).toBe(200);
    }
  },
};
