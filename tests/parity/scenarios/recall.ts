import { expect } from 'bun:test';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

/** Both unconfigured targets retain independent recall contributors and explicitly skip semantic spores. */
export const recall: ParityScenario = {
  name: 'recall: semantic configuration, independent guidance and capability admission',
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

    await target.sql(`DELETE FROM project_capabilities WHERE project_id = ${lit(target.projectId)}`);
    const defaults = await owner<{ capabilities: Record<string, boolean> }>(`/api/projects/${target.projectId}/capabilities`);
    expect(defaults.body.capabilities).toEqual({ cortex: true, canopy: true, vault_evolution: true });
    const spore = await mcp({ op: 'save', type: 'decision', content: `the hook answers before the drain ${stamp}`, session_id: session, project: target.projectId });
    expect(spore.id).toBeDefined();

    // The planning nudge remains available when semantic recall has no provider.
    const first = await served(session, p1, planning);
    expect(first.persisted).toBe(true);
    expect(first.skipped).toEqual(['spores:no_semantic']);
    expect(first.parts?.map((p) => p.kind)).toEqual(['plan-nudge']);
    expect(first.context?.startsWith('Myco is where plans live')).toBe(true);
    expect(first.context).not.toContain(`the hook answers before the drain ${stamp}`);
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
    const answers = await target.sql(`SELECT prompt_id, outcome, parts, skipped, failures, selection FROM prompt_context_answers
      WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(session)} ORDER BY created_at, prompt_id`) as Array<{ prompt_id: string; outcome: string; parts: string; skipped: string; failures: string; selection: string }>;
    expect(answers).toHaveLength(3);
    for (const answer of answers) expect(JSON.parse(answer.selection)).toEqual({
      sporeRawMatches: 0, sporeJoined: 0, sporeHits: 0, sporeCalibrated: 0, sporeScored: 0, sporeProbable: 0,
      sporeSeparated: 0, sporeRelevant: 0, sporeHydrated: 0,
      planRawMatches: 0, planJoined: 0, planHits: 0, planUnserved: 0, planEligible: 0,
      planCalibrationFailed: 0, planCalibrated: 0, planScored: 0, planProbable: 0, planSeparated: 0, planRelevant: 0, planHydrated: 0, budgetKept: 0,
    });
    expect(answers.find((answer) => answer.prompt_id === p1)).toMatchObject({ outcome: 'served', parts: '[{"kind":"plan-nudge"}]', skipped: '["spores:no_semantic"]', failures: '[]' });
    expect(answers.filter((answer) => answer.outcome === 'empty')).toHaveLength(2);
    expect(answers.filter((answer) => answer.outcome === 'empty').every((answer) => JSON.parse(answer.skipped).includes('plan-nudge:repeat'))).toBe(true);

    // The record of what the prompt was served reaches the turn body under that prompt.
    interface Turn { injection: { sporeIds: string[]; spores: { id: string }[] } | null }
    const turn = await owner<Turn>(`/api/projects/${target.projectId}/sessions/${session}/turns/${p1}`);
    expect(turn.status).toBe(200);
    expect(turn.body.injection).toBeNull();

    // A starting session is served the Project's instructions, trimmed and with
    // no heading, and is served nothing a second time.
    const guidance = `Keep the plan for ${stamp} current.`;
    await target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('instructions.template', ${lit(JSON.stringify(`  ${guidance}  `))}, ${stamp}, 'test')`);
    const startSession = `parity-recall-start-${stamp}`;
    const atStart = await servedAtStart(startSession);
    expect(atStart.persisted).toBe(true);
    expect(atStart.parts?.map((p) => p.kind)).toEqual(['project', 'instructions']);
    // The Project line stands first: it is the value a write is refused without.
    expect(atStart.context?.startsWith('Project:: ')).toBe(true);
    expect(atStart.context).toContain(target.projectId);
    expect(atStart.context?.endsWith(guidance)).toBe(true);
    expect(atStart.kind).toBe('cortex');
    expect(await servedAtStart(startSession))
      .toEqual({ persisted: true, context: '', parts: [], skipped: ['repeat'], kind: 'cortex' });
    // A member about to have sessions previews the same block, as often as it asks, and no session is recorded.
    const recorded = async () => (await target.sql(`SELECT COUNT(*) AS n FROM session_injections WHERE project_id = ${lit(target.projectId)}`)) as Array<{ n: number }>;
    const before = await recorded();
    for (let i = 0; i < 2; i++) {
      const preview = await sessionBlock({ kind: 'start', preview: true });
      expect({ persisted: preview.persisted, context: preview.context }).toEqual({ persisted: true, context: atStart.context });
    }
    expect(await recorded()).toEqual(before);

    // Two delegations of one type are two subagents, and each is served.
    for (const agentId of ['a1', 'a2']) {
      const delegated = await servedToSubagent(startSession, agentId, 'code-reviewer');
      expect({ agentId, parts: delegated.parts?.map((p) => p.kind), kind: delegated.kind })
        .toEqual({ agentId, parts: ['project', 'instructions'], kind: `cortex:${agentId}` });
      expect(delegated.context?.endsWith(guidance)).toBe(true);
    }
    expect(await target.sql(`SELECT kind FROM session_injections WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(startSession)} ORDER BY kind`))
      .toEqual([{ kind: 'cortex' }, { kind: 'cortex:a1' }, { kind: 'cortex:a2' }]);

    for (const compaction of [1, 2]) {
      const payload = { sessionId: startSession, kind: 'compact', compaction };
      const restored = await sessionBlock(payload);
      expect(restored.context?.endsWith(guidance)).toBe(true);
      expect(restored.kind).toBe(`cortex-compact:${compaction}`);
      expect((await sessionBlock(payload)).skipped).toContain('repeat');
    }
    expect((await servedAtStart(startSession)).context).toBe('');
    await post(startSession, 'session.start', { agent: 'claude-code', startedAt: stamp }, stamp);
    interface ContextPage { rows: Array<{ kind: string; createdAt: number }>; cursor: string | null }
    const contextPath = `/api/projects/${target.projectId}/sessions/${startSession}/context-injections`;
    const context = await owner<ContextPage>(`${contextPath}?limit=2`);
    expect(context.status).toBe(200);
    expect(context.body.rows).toHaveLength(2);
    expect(context.body.cursor).not.toBeNull();
    const rest = await owner<ContextPage>(`${contextPath}?cursor=${encodeURIComponent(context.body.cursor!)}&limit=100`);
    expect([...context.body.rows, ...rest.body.rows].map((r) => r.kind).sort())
      .toEqual(['cortex', 'cortex-compact:1', 'cortex-compact:2', 'cortex:a1', 'cortex:a2']);
    expect((await owner(`${contextPath.replace(startSession, 'missing-session')}`)).status).toBe(404);
    await target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('cortex.instructions.inject_on_session_start', 'false', ${stamp}, 'test')`);
    try {
      const off = await sessionBlock({ sessionId: startSession, kind: 'compact', compaction: 3 });
      // The Project line survives a Deployment that holds its own text back.
      expect(off.parts?.map((p) => p.kind)).toEqual(['project']);
      expect(off.skipped).toEqual(['instructions:off']);
    } finally {
      await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'cortex.instructions.inject_on_session_start'`);
      await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'instructions.template'`);
    }

    // A Project withdrawn from `cortex` is served nothing on a prompt, and at
    // session start is served its own Project id and nothing else: a write is
    // refused without the id, so the capability holds back the Deployment's
    // text rather than the name every write has to carry.
    await admit(false);
    const withdrawn = `parity-recall-off-${stamp}`;
    expect(await served(withdrawn, crypto.randomUUID(), planning))
      .toEqual({ persisted: true, context: '', parts: [], skipped: ['capability'] });
    const atStartOff = await servedAtStart(withdrawn);
    expect({ parts: atStartOff.parts?.map((p) => p.kind), skipped: atStartOff.skipped, kind: atStartOff.kind })
      .toEqual({ parts: ['project'], skipped: ['capability'], kind: 'cortex' });
    expect(atStartOff.context).toContain(target.projectId);

    for (const payload of [
      { sessionId: withdrawn, kind: 'subagent', agentId: 'off-child' },
      { sessionId: withdrawn, kind: 'compact', compaction: 1 },
      { kind: 'start', preview: true },
      { kind: 'subagent', preview: true },
    ]) {
      const block = await sessionBlock(payload);
      expect(block.parts).toEqual([{ kind: 'project' }]);
      expect(block.skipped).toEqual(['capability']);
      expect(block.context).toBe(`Project:: \`${target.projectId}\` — pass this as \`project\` on Myco tool calls; a write without it is refused.`);
    }
    expect(await target.sql(`SELECT enabled FROM project_capabilities WHERE project_id = ${lit(target.projectId)} AND capability = 'cortex'`))
      .toEqual([{ enabled: 0 }]);

    await admit(true);
    await target.sql(`UPDATE projects SET archived_at = ${stamp} WHERE project_id = ${lit(target.projectId)}`);
    try {
      const archived = await owner<{ capabilities: Record<string, boolean> }>(`/api/projects/${target.projectId}/capabilities`);
      expect(archived.body.capabilities).toEqual({ cortex: false, canopy: false, vault_evolution: false });
      expect(await served(`archived-${stamp}`, crypto.randomUUID(), planning))
        .toEqual({ persisted: true, context: '', parts: [], skipped: ['capability'] });
    } finally {
      await target.sql(`UPDATE projects SET archived_at = NULL WHERE project_id = ${lit(target.projectId)}`);
    }
  },
};
