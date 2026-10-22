import { expect } from 'bun:test';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * Spores on both targets: a member's save naming its session carries that
 * session, a supersede reads as lineage in both
 * directions through the tool and through the owner route, and the record of
 * what a prompt was served reaches the session explorer under the prompt that
 * carried it, and a session's spores page by cursor past writes between pages.
 */
export const spores: ParityScenario = {
  name: 'spores: session citation on a save, lineage both ways, the injection under its turn',
  async run(target: ParityTarget) {
    const post = async (sessionId: string, kind: string, payload: Record<string, unknown>, createdAt = Date.now()) => {
      const res = await fetch(`${target.url}/events`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      });
      await expectPersisted(res, kind);
    };
    const owner = async <T,>(path: string): Promise<{ status: number; body: T }> => {
      const res = await fetch(`${target.url}${path}`, { headers: { ...target.ownerHeaders(), origin: target.url } });
      return { status: res.status, body: (await res.json()) as T };
    };
    const mcp = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const res = await fetch(`${target.url}/mcp`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_spores', arguments: args } }),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { result: { structuredContent: { result: Record<string, unknown> } } }).result.structuredContent.result;
    };

    const stamp = Date.now();
    const session = `parity-spores-${stamp}`;
    const [p1, p2] = [crypto.randomUUID(), crypto.randomUUID()];
    await post(session, 'session.start', { agent: 'claude-code', branch: 'spores', startedAt: stamp }, stamp);
    await post(session, 'prompt', { promptId: p1, text: `What did we settle on ${stamp}`, origin: 'user' }, stamp + 1);
    await post(session, 'prompt', { promptId: p2, text: 'and carry on with it', origin: 'user' }, stamp + 2);

    // A save cites its session and stores no prompt.
    const first = await mcp({ op: 'save', type: 'decision', content: `recency is the selector ${stamp}`, session_id: session, prompt_id: p1, project: target.projectId });
    const oldId = String(first.id);
    const saved = (await target.sql(`SELECT session_id, prompt_id, status FROM spores WHERE id = ${lit(oldId)}`))[0]!;
    expect([saved.session_id, saved.prompt_id, saved.status]).toEqual([session, null, 'active']);

    // A session the caller's machine does not hold is one refusal, whatever the cause.
    const refused = await mcp({ op: 'save', type: 'decision', content: 'nowhere', session_id: `no-such-${stamp}`, project: target.projectId });
    expect(refused.error).toBe('session_id not found');

    // A supersede reads as lineage from both ends, through the tool and the owner route.
    const second = await mcp({ op: 'save', type: 'decision', content: `recency with a cap ${stamp}`, session_id: session, project: target.projectId });
    const newId = String(second.id);
    expect((await target.sql(`SELECT prompt_id FROM spores WHERE id = ${lit(newId)}`))[0]!.prompt_id).toBeNull();
    expect(await mcp({ op: 'supersede', old_spore_id: oldId, new_spore_id: newId, reason: 'narrowed', session_id: session, project: target.projectId }))
      .toEqual({ old_spore: oldId, new_spore: newId, status: 'superseded' });

    const older = await mcp({ op: 'get', id: oldId });
    expect([older.status, older.superseded_by, older.predecessors]).toEqual(['superseded', [newId], []]);
    const newer = await mcp({ op: 'get', id: newId });
    expect([newer.status, newer.superseded_by, newer.predecessors]).toEqual(['active', [], [oldId]]);

    const detail = await owner<{ spore: { id: string; status: string }; supersededBy: string[]; supersedes: string[] }>(`/api/projects/${target.projectId}/spores/${oldId}`);
    expect(detail.status).toBe(200);
    expect([detail.body.spore.status, detail.body.supersededBy, detail.body.supersedes]).toEqual(['superseded', [newId], []]);
    const replacement = await owner<{ supersededBy: string[]; supersedes: string[] }>(`/api/projects/${target.projectId}/spores/${newId}`);
    expect([replacement.body.supersededBy, replacement.body.supersedes]).toEqual([[], [oldId]]);

    // The record of what a prompt's text selected reaches the turn body under the prompt that carried it.
    await target.sql(`INSERT INTO spore_injections (id, project_id, session_id, prompt_id, prompt_hash, spore_ids, ask_protocol, asked_at, delivered_at, delivered_prompt_id, created_at)
      VALUES (${lit(crypto.randomUUID())}, ${lit(target.projectId)}, ${lit(session)}, ${lit(p1)}, ${lit(`ph-${stamp}`)}, ${lit(JSON.stringify([newId]))}, 'v1', ${stamp + 3}, ${stamp + 4}, ${lit(p2)}, ${stamp + 3})`);

    interface Turn { injection: { sporeIds: string[]; createdAt: number; spores: { id: string; observationType: string; preview: string }[] } | null }
    const base = `/api/projects/${target.projectId}/sessions/${session}`;
    const served = await owner<Turn>(`${base}/turns/${p2}`);
    expect(served.status).toBe(200);
    expect(served.body.injection?.sporeIds).toEqual([newId]);
    expect(served.body.injection?.createdAt).toBe(stamp + 3);
    expect(served.body.injection?.spores).toEqual([{ id: newId, observationType: 'decision', preview: `recency with a cap ${stamp}` }]);

    // The selecting prompt, delivered nothing, answers null rather than an empty shape.
    expect((await owner<Turn>(`${base}/turns/${p1}`)).body.injection).toBeNull();

    // The session's spores page by cursor: a spore written between pages is not repeated, and one backfilled older than
    // the cursor is reached later. Three more share one instant, so the id breaks the tie at a page boundary.
    const agent = (await target.sql(`SELECT agent_id FROM spores WHERE id = ${lit(newId)}`))[0]!.agent_id as string;
    const seed = async (id: string, at: number) => target.sql(`INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, created_at)
      VALUES (${lit(target.projectId)}, ${lit(id)}, ${lit(agent)}, ${lit(session)}, 'gotcha', 'active', ${lit(`seeded ${id}`)}, ${at})`);
    for (const id of [`tie-a-${stamp}`, `tie-b-${stamp}`, `tie-c-${stamp}`]) await seed(id, stamp - 10);
    const ordered = (await target.sql(`SELECT id FROM spores WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(session)} ORDER BY created_at DESC, id DESC`)).map((r) => r.id as string);
    type SporePage = { spores: { id: string }[]; cursor: string | null; total: number };
    const list = `/api/projects/${target.projectId}/spores?session=${encodeURIComponent(session)}&limit=2`;
    const opening = await owner<SporePage>(list);
    expect([opening.status, opening.body.spores.map((s) => s.id), opening.body.total]).toEqual([200, ordered.slice(0, 2), ordered.length]);
    await seed(`arrived-${stamp}`, Date.now() + 60_000);
    await seed(`backfilled-${stamp}`, stamp - 1_000);
    const walked = opening.body.spores.map((s) => s.id);
    let cursor = opening.body.cursor;
    while (cursor !== null) {
      const next = await owner<SporePage>(`${list}&cursor=${encodeURIComponent(cursor)}`);
      expect(next.status).toBe(200);
      walked.push(...next.body.spores.map((s) => s.id));
      cursor = next.body.cursor;
    }
    expect(walked).toEqual([...ordered, `backfilled-${stamp}`]);
    expect((await owner(`${list}&cursor=nope`)).status).toBe(400);
    expect((await owner(`${list}&offset=2&cursor=${encodeURIComponent(opening.body.cursor!)}`)).status).toBe(400);
  },
};
