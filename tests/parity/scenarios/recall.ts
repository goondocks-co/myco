import { expect } from 'bun:test';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * Recall on both targets: a prompt carrying planning intent is served the nudge
 * and the session's unseen spores, the same prompt content is served nothing a
 * second time, the record of what the prompt was served reaches the session
 * explorer under that prompt, a starting session is served the Project's
 * instructions once and every delegation of it is served too, and a Project
 * withdrawn from `cortex` is served an empty block naming the gate.
 */
export const recall: ParityScenario = {
  name: 'recall: the nudge and the unseen spores on a prompt, once per session, gated by the capability',
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
    const admit = async (enabled: boolean) => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/capabilities/cortex`, {
        method: 'PUT',
        headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      expect(`cortex ${enabled}: ${res.status}`).toBe(`cortex ${enabled}: 200`);
    };

    interface Served { persisted?: boolean; context?: string; parts?: Array<{ kind: string; sporeIds?: string[] }>; skipped?: string[]; kind?: string }
    const served = async (sessionId: string, promptId: string, text: string): Promise<Served> => {
      const res = await fetch(`${target.url}/context/prompt`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, promptId, text }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Served;
    };
    const sessionBlock = async (payload: Record<string, unknown>): Promise<Served> => {
      const res = await fetch(`${target.url}/context/session`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Served;
    };
    const servedAtStart = (sessionId: string) => sessionBlock({ sessionId, kind: 'start' });
    const servedToSubagent = (sessionId: string, agentId: string, agentType: string) =>
      sessionBlock({ sessionId, kind: 'subagent', agentId, agentType });

    const stamp = Date.now();
    const session = `parity-recall-${stamp}`;
    const planning = `Let us write the implementation plan for ${stamp}`;
    const [p1, p2, p3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await post(session, 'session.start', { agent: 'claude-code', branch: 'recall', startedAt: stamp }, stamp);
    await post(session, 'prompt', { promptId: p1, text: planning, origin: 'user' }, stamp + 1);

    await admit(true);
    const spore = await mcp({ op: 'save', type: 'decision', content: `the hook answers before the drain ${stamp}`, session_id: session });
    const sporeId = String(spore.id);

    // The session's first prompt carrying planning intent: the nudge, then the spores.
    const first = await served(session, p1, planning);
    expect(first.persisted).toBe(true);
    expect(first.skipped).toEqual([]);
    expect(first.parts?.map((p) => p.kind)).toEqual(['plan-nudge', 'spores']);
    expect(first.parts?.[1]?.sporeIds).toContain(sporeId);
    expect(first.context?.startsWith('Myco is where plans live')).toBe(true);
    expect(first.context).toContain(`the hook answers before the drain ${stamp}`);
    expect(first.context!.length).toBeLessThanOrEqual(10_000);

    // The same prompt content again: nothing at all, and every silence is named
    // — the nudge's own record, and whichever spore gate the pool closed on.
    const second = await served(session, p2, planning);
    expect({ persisted: second.persisted, context: second.context, parts: second.parts })
      .toEqual({ persisted: true, context: '', parts: [] });
    expect(second.skipped).toContain('plan-nudge:repeat');
    expect(second.skipped?.some((name) => name.startsWith('spores:'))).toBe(true);

    // A different prompt of the same session still carrying intent: no second nudge.
    const later = await served(session, p3, `and the plan for ${stamp} once more`);
    expect(later.parts?.map((p) => p.kind)).not.toContain('plan-nudge');
    expect(later.skipped).toContain('plan-nudge:repeat');
    expect(await target.sql(`SELECT kind FROM session_injections WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(session)}`))
      .toEqual([{ kind: 'plan-nudge' }]);

    // The record of what the prompt was served reaches the turn body under that prompt.
    interface Turn { injection: { sporeIds: string[]; spores: { id: string }[] } | null }
    const turn = await owner<Turn>(`/api/projects/${target.projectId}/sessions/${session}/turns/${p1}`);
    expect(turn.status).toBe(200);
    expect(turn.body.injection?.sporeIds).toContain(sporeId);
    expect(turn.body.injection?.spores.map((s) => s.id)).toContain(sporeId);

    // A starting session is served the Project's instructions, trimmed and with
    // no heading, and is served nothing a second time.
    const guidance = `Keep the plan for ${stamp} current.`;
    await target.sql(`INSERT INTO cortex_instructions (project_id, id, agent_id, content, input_hash, source_run_id, generated_at)
      VALUES (${lit(target.projectId)}, ${lit(`ci-${stamp}`)}, 'user', ${lit(`  ${guidance}  `)}, ${lit(`h-${stamp}`)}, NULL, ${stamp})`);
    const startSession = `parity-recall-start-${stamp}`;
    const atStart = await servedAtStart(startSession);
    expect(atStart.persisted).toBe(true);
    expect(atStart.parts?.map((p) => p.kind)).toEqual(['instructions']);
    expect(atStart.context).toBe(guidance);
    expect(atStart.kind).toBe('cortex');
    expect(await servedAtStart(startSession))
      .toEqual({ persisted: true, context: '', parts: [], skipped: ['digest:off', 'repeat'], kind: 'cortex' });

    // Two delegations of one type are two subagents, and each is served.
    for (const agentId of ['a1', 'a2']) {
      const delegated = await servedToSubagent(startSession, agentId, 'code-reviewer');
      expect({ agentId, parts: delegated.parts?.map((p) => p.kind), kind: delegated.kind })
        .toEqual({ agentId, parts: ['instructions'], kind: `cortex:${agentId}` });
      expect(delegated.context?.endsWith(guidance)).toBe(true);
    }
    expect(await target.sql(`SELECT kind FROM session_injections WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(startSession)} ORDER BY kind`))
      .toEqual([{ kind: 'cortex' }, { kind: 'cortex:a1' }, { kind: 'cortex:a2' }]);

    // A Project withdrawn from `cortex` is served an empty block naming the gate, and records nothing.
    await admit(false);
    const withdrawn = `parity-recall-off-${stamp}`;
    expect(await served(withdrawn, crypto.randomUUID(), planning))
      .toEqual({ persisted: true, context: '', parts: [], skipped: ['capability'] });
    expect(await servedAtStart(withdrawn))
      .toEqual({ persisted: true, context: '', parts: [], skipped: ['capability'], kind: 'cortex' });
    expect(await target.sql(`SELECT COUNT(*) AS n FROM session_injections WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(withdrawn)}`))
      .toEqual([{ n: 0 }]);

    await admit(true);
  },
};
