import { expect } from 'bun:test';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * A Project's plan list at the size a real Project reaches: more plans than one statement may bind as parameters,
 * each tagged, read a full page at a time and then page by page to the end, on both targets.
 */
export const plansAtScale: ParityScenario = {
  name: 'plans at scale: a full page past the parameter ceiling, tags on every row, and every plan by pages',
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const session = `parity-plans-scale-${stamp}`;
    const count = 230;
    // The session that makes the Project exist; the plans are then written as rows, at a size capture takes days to reach.
    await expectPersisted(await fetch(`${target.url}/events`, {
      method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind: 'session.start', createdAt: stamp, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload: { agent: 'claude-code', startedAt: stamp } }),
    }), 'session.start');
    const key = (i: number) => `scale-${stamp}-${String(i).padStart(3, '0')}`;
    // Stamped past every other scenario's rows, so the newest pages are this scenario's own.
    // Five plans to each edit instant, so the list's tie-break by key is read as well as its order by time.
    const at = (i: number) => 4_000_000_000_000 + stamp % 1_000_000 * 1_000 + Math.floor(i / 5);
    const values = Array.from({ length: count }, (_, i) =>
      `(${lit(target.projectId)}, ${lit(key(i))}, ${lit(session)}, ${lit(`evt-${stamp}-${i}`)}, 'parity', ${lit(`Plan ${i}`)}, '- [x] one', ${lit(`h-${i}`)}, 'active', ${at(i)}, ${at(i)}, 'tok', ${stamp})`);
    for (let i = 0; i < values.length; i += 50) {
      await target.sql(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, content_hash, status, created_at, updated_at, token_id, received_at) VALUES ${values.slice(i, i + 50).join(', ')}`);
    }
    const tags = Array.from({ length: count }, (_, i) => `(${lit(target.projectId)}, 'plan', ${lit(key(i))}, ${lit(`t${i % 3}`)})`);
    for (let i = 0; i < tags.length; i += 50) await target.sql(`INSERT INTO tags (project_id, entity_kind, entity_id, tag) VALUES ${tags.slice(i, i + 50).join(', ')}`);
    try {
      const read = async (query: string) => {
        const res = await fetch(`${target.url}/api/projects/${target.projectId}/plans?${query}`, { headers: { ...target.ownerHeaders(), origin: target.url } });
        return { status: res.status, body: await res.json() as { plans: { planKey: string; tags: string[] }[]; cursor?: string | null } };
      };
      for (const limit of [100, 200]) {
        const answer = await read(`limit=${limit}`);
        expect({ limit, status: answer.status }).toEqual({ limit, status: 200 });
        const ours = answer.body.plans.filter((p) => p.planKey.startsWith(`scale-${stamp}-`));
        expect(ours.length).toBe(limit);
        expect(ours.every((p) => p.tags.length === 1)).toBe(true);
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
      expect(seen.filter((k) => k.startsWith(`scale-${stamp}-`))).toEqual(Array.from({ length: count }, (_, i) => key(count - 1 - i)));
    } finally {
      await target.sql(`DELETE FROM tags WHERE project_id = ${lit(target.projectId)} AND entity_kind = 'plan' AND entity_id LIKE ${lit(`scale-${stamp}-%`)}`);
      await target.sql(`DELETE FROM plans WHERE project_id = ${lit(target.projectId)} AND plan_key LIKE ${lit(`scale-${stamp}-%`)}`);
    }
  },
};
