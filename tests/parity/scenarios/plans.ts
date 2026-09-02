import { expect } from 'bun:test';
import { uuidv5 } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * Plans on both targets: a plan captured with the prompt it came from, an
 * identical re-emission that moves nothing, a changed one that keeps the row's
 * status and prompt, an MCP save converging on the member's key, a status edit
 * through the owner route naming its member, the turn body carrying the plan,
 * and a later capture clearing the administrator.
 */
export const plans: ParityScenario = {
  name: 'plans: prompt linkage, convergence guards, MCP save on the member key, owner status edit, turn body',
  async run(target: ParityTarget) {
    const post = async (sessionId: string, kind: string, payload: Record<string, unknown>, createdAt = Date.now()) => {
      const res = await fetch(`${target.url}/events`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      });
      await expectPersisted(res, kind);
    };
    const owner = async <T,>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
      const res = await fetch(`${target.url}${path}`, { ...init, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json', ...(init.headers ?? {}) } });
      return { status: res.status, body: (await res.json()) as T };
    };
    const mcp = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const res = await fetch(`${target.url}/mcp`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_plans', arguments: args } }),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { result: { structuredContent: { result: Record<string, unknown> } } }).result.structuredContent.result;
    };
    const row = async (key: string) => (await target.sql(`SELECT prompt_id, status, content, event_id, updated_at, updated_by FROM plans WHERE plan_key=${lit(key)}`))[0]!;

    const stamp = Date.now();
    const session = `parity-plans-${stamp}`;
    const [p1, p2] = [crypto.randomUUID(), crypto.randomUUID()];
    await post(session, 'session.start', { agent: 'claude-code', branch: 'plans', startedAt: stamp }, stamp);
    await post(session, 'prompt', { promptId: p1, text: `Write the plan ${stamp}`, origin: 'user' }, stamp + 1);
    await post(session, 'prompt', { promptId: p2, text: 'and carry on', origin: 'user' }, stamp + 2);

    const path = `docs/plans/parity-${stamp}.md`;
    const key = await uuidv5('plan', target.projectId, path);
    await post(session, 'plan', { planKey: key, promptId: p1, title: 'Parity', content: '- [ ] one', originPath: path, status: 'active' }, stamp + 10);
    const first = await row(key);
    expect([first.prompt_id, first.status, first.content, first.updated_at]).toEqual([p1, 'active', '- [ ] one', stamp + 10]);

    // Identical content and title, no status: nothing moves.
    await post(session, 'plan', { planKey: key, title: 'Parity', content: '- [ ] one', originPath: path }, stamp + 20);
    expect(await row(key)).toEqual(first);

    // New content from the same file, no status: the row moves and keeps its status and prompt.
    await post(session, 'plan', { planKey: key, title: 'Parity', content: '- [x] one', originPath: path }, stamp + 30);
    const changed = await row(key);
    expect([changed.prompt_id, changed.status, changed.content, changed.updated_at]).toEqual([p1, 'active', '- [x] one', stamp + 30]);

    // An MCP save by the same path converges on the member's key and, updating, leaves the prompt the row names.
    const saved = await mcp({ op: 'save', session_id: session, source_path: path, content: '- [x] one\n- [ ] two' });
    expect([saved.ok, saved.id, saved.prompt_id]).toEqual([true, key, p1]);
    // A fresh plan names the session's latest prompt.
    const fresh = await mcp({ op: 'save', session_id: session, plan_key: `parity-${stamp}`, content: 'fresh' });
    expect([fresh.ok, fresh.prompt_id]).toEqual([true, p2]);

    // The owner's status edit names its member and stamps after the row.
    const base = `/api/projects/${target.projectId}/sessions/${session}`;
    const edit = await owner<{ plan: { status: string; updatedBy: string | null; progress: string; updatedAt: number } }>(`${base}/plans/${key}/status`, { method: 'POST', body: JSON.stringify({ status: 'completed' }) });
    expect(edit.status).toBe(200);
    expect([edit.body.plan.status, edit.body.plan.updatedBy, edit.body.plan.progress, edit.body.plan.updatedAt > (changed.updated_at as number)]).toEqual(['completed', MEMBER_ID, '1/2', true]);
    expect((await owner(`${base}/plans/${key}/status`, { method: 'POST', body: JSON.stringify({ status: 'all' }) })).status).toBe(400);

    // The turn body carries the plan under the prompt it came from; the list reads it by session.
    const detail = await owner<{ plans: { planKey: string; status: string; progress: string; promptId: string | null }[] }>(`${base}/turns/${p1}`);
    expect(detail.body.plans.map((p) => [p.planKey, p.status, p.progress, p.promptId])).toEqual([[key, 'completed', '1/2', p1]]);
    const listed = (await mcp({ op: 'list', session, status: 'all' })) as unknown as { id: string; prompt_id: string | null; progress: string }[];
    expect(listed.filter((p) => p.id === key).map((p) => [p.prompt_id, p.progress])).toEqual([[p1, '1/2']]);

    // A later capture with new content clears the administrator and keeps the status the member set.
    await post(session, 'plan', { planKey: key, title: 'Parity', content: '- [x] one\n- [x] two', originPath: path }, Date.now() + 1_000);
    const after = await row(key);
    expect([after.status, after.updated_by, after.content]).toEqual(['completed', null, '- [x] one\n- [x] two']);
  },
};
