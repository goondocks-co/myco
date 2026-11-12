import { expect } from 'bun:test';
import { archived, event, mcp, owner, putCapability, putSetting, resetSetting, untilPublished } from '../clients/requests.ts';
import { type ParityScenario, type ParityTarget } from '../harness.ts';

const CAPABILITY_DEFAULTS = { cortex: true, canopy: true, vault_evolution: true, spore_curation: false, spore_curation_backfill: false } as const;

/** Both unconfigured targets retain independent recall contributors and explicitly skip semantic spores. */
export const recall: ParityScenario = {
  name: 'recall: semantic configuration, independent guidance and capability admission',
  async run(target: ParityTarget) {
    const post = (sessionId: string, kind: string, payload: Record<string, unknown>, createdAt = Date.now()) =>
      event(target, sessionId, kind, payload, createdAt);
    const admit = async (enabled: boolean) => {
      const saved = await putCapability(target, 'cortex', enabled);
      expect({ enabled, status: saved.status, body: saved.body }).toMatchObject({ status: 200 });
    };
    const capabilities = async () => {
      const read = await owner<{ capabilities: Record<string, boolean> }>(target, `/api/projects/${target.projectId}/capabilities`);
      expect(read.status).toBe(200);
      return read.body.capabilities;
    };

    interface Served { persisted?: boolean; context?: string; parts?: Array<{ kind: string; sporeIds?: string[] }>; skipped?: string[]; kind?: string; answerId?: string; machine?: unknown }
    const ask = async (path: string, payload: Record<string, unknown>): Promise<Served> => {
      const res = await fetch(`${target.url}${path}`, { method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      expect(res.status).toBe(200);
      return await res.json() as Served;
    };
    const served = (sessionId: string, promptId: string, text: string) => ask('/context/prompt', { sessionId, promptId, text });
    const sessionBlock = (payload: Record<string, unknown>) => ask('/context/session', payload);
    const servedAtStart = (sessionId: string) => sessionBlock({ sessionId, kind: 'start' });
    const servedToSubagent = (sessionId: string, agentId: string, agentType: string) =>
      sessionBlock({ sessionId, kind: 'subagent', agentId, agentType });
    interface ContextPage { rows: Array<{ kind: string; createdAt: number }>; cursor: string | null }
    const injectionKinds = async (sessionId: string): Promise<string[]> => {
      const page = await owner<ContextPage>(target, `/api/projects/${target.projectId}/sessions/${sessionId}/context-injections?limit=100`);
      expect(page.status).toBe(200);
      return page.body.rows.map((row) => row.kind).sort();
    };
    const sessionIds = async (): Promise<string[]> => {
      const listed = await owner<{ rows: Array<{ sessionId: string }> }>(target, `/api/projects/${target.projectId}/sessions?limit=100`);
      expect(listed.status).toBe(200);
      return listed.body.rows.map((row) => row.sessionId).sort();
    };

    const stamp = Date.now();
    const session = `parity-recall-${stamp}`;
    const planning = `Let us write the implementation plan for ${stamp}`;
    const [p1, p2, p3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await post(session, 'session.start', { agent: 'claude-code', branch: 'recall', startedAt: stamp }, stamp);
    await post(session, 'prompt', { promptId: p1, text: planning, origin: 'user' }, stamp + 1);

    for (const [capability, enabled] of Object.entries(CAPABILITY_DEFAULTS)) {
      const saved = await putCapability(target, capability, enabled);
      expect({ capability, status: saved.status, body: saved.body }).toMatchObject({ status: 200 });
    }
    expect(await capabilities()).toEqual(CAPABILITY_DEFAULTS);
    const spore = await mcp(target, 'myco_spores', { op: 'save', agent_line: 'When using this fixture, retain its evidence.', type: 'decision', content: `the hook answers before the drain ${stamp}`, session_id: session, project: target.projectId });
    expect(spore.id).toBeDefined();

    // The planning nudge remains available when semantic recall has no provider.
    const first = await served(session, p1, planning);
    expect([first.persisted, first.skipped, first.parts?.map((p) => p.kind)]).toEqual([true, ['spores:no_semantic'], ['plan-nudge']]);
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
    // A served answer whose prompt is not on a published turn is a session record, kind context:<answer id>, beside the nudge.
    expect(await injectionKinds(session)).toEqual([`context:${first.answerId}`, 'plan-nudge'].sort());

    const notice = `<task-notification>\n<task-id>${stamp}</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>`;
    const abstained = await served(session, crypto.randomUUID(), notice);
    expect({ context: abstained.context, parts: abstained.parts, skipped: abstained.skipped }).toEqual({ context: '', parts: [], skipped: ['notification'] });
    expect((await served(session, crypto.randomUUID(), `${notice}\nwhat did we settle about ${stamp}`)).skipped).not.toContain('notification');

    // The record of what the prompt was served reaches the turn body under that prompt.
    interface Turn { injection: { sporeIds: string[]; spores: { id: string }[] } | null }
    const turn = await untilPublished(target, () => owner<Turn>(target, `/api/projects/${target.projectId}/sessions/${session}/turns/${p1}`), (read) => read.status === 200);
    expect(turn.status).toBe(200);
    expect(turn.body.injection).toBeNull();

    // A starting session is served the Project's instructions, trimmed and with
    // no heading, and is served nothing a second time.
    const guidance = `Keep the plan for ${stamp} current.`;
    const template = await putSetting(target, 'instructions.template', `  ${guidance}  `);
    expect(template.status).toBe(200);
    try {
    const startSession = `parity-recall-start-${stamp}`;
    const atStart = await servedAtStart(startSession);
    expect([atStart.persisted, atStart.parts?.map((p) => p.kind), atStart.kind]).toEqual([true, ['project', 'instructions'], 'cortex']);
    // The Project line stands first: it is the value a write is refused without.
    expect([atStart.context?.startsWith('Project:: '), atStart.context?.includes(target.projectId), atStart.context?.endsWith(guidance)]).toEqual([true, true, true]);
    // A machine another scenario claimed adds its own settings block; this checks only what recall serves.
    const { machine: _machine, ...repeated } = await servedAtStart(startSession);
    expect(repeated).toEqual({ persisted: true, context: '', parts: [], skipped: ['repeat'], kind: 'cortex' });
    // The context list is a session read, so the session is captured here. The preview itself names no session.
    await post(startSession, 'session.start', { agent: 'claude-code', startedAt: stamp }, stamp);
    const beforeSessions = await sessionIds();
    const beforeKinds = await injectionKinds(startSession);
    for (let i = 0; i < 2; i++) {
      const preview = await sessionBlock({ kind: 'start', preview: true });
      expect({ persisted: preview.persisted, context: preview.context }).toEqual({ persisted: true, context: atStart.context });
    }
    expect(await sessionIds()).toEqual(beforeSessions);
    expect(await injectionKinds(startSession)).toEqual(beforeKinds);

    // Two delegations of one type are two subagents, and each is served.
    for (const agentId of ['a1', 'a2']) {
      const delegated = await servedToSubagent(startSession, agentId, 'code-reviewer');
      expect({ agentId, parts: delegated.parts?.map((p) => p.kind), kind: delegated.kind })
        .toEqual({ agentId, parts: ['project', 'instructions'], kind: `cortex:${agentId}` });
      expect(delegated.context?.endsWith(guidance)).toBe(true);
    }

    for (const compaction of [1, 2]) {
      const payload = { sessionId: startSession, kind: 'compact', compaction };
      const restored = await sessionBlock(payload);
      expect([restored.context?.endsWith(guidance), restored.kind]).toEqual([true, `cortex-compact:${compaction}`]);
      expect((await sessionBlock(payload)).skipped).toContain('repeat');
    }
    expect((await servedAtStart(startSession)).context).toBe('');
    const contextPath = `/api/projects/${target.projectId}/sessions/${startSession}/context-injections`;
    const context = await owner<ContextPage>(target, `${contextPath}?limit=2`);
    expect(context.status).toBe(200);
    expect(context.body.rows).toHaveLength(2);
    expect(context.body.cursor).not.toBeNull();
    const rest = await owner<ContextPage>(target, `${contextPath}?cursor=${encodeURIComponent(context.body.cursor!)}&limit=100`);
    expect([...context.body.rows, ...rest.body.rows].map((r) => r.kind).sort())
      .toEqual(['cortex', 'cortex-compact:1', 'cortex-compact:2', 'cortex:a1', 'cortex:a2']);
    expect((await owner(target, `${contextPath.replace(startSession, 'missing-session')}`)).status).toBe(404);
    const heldBack = await putSetting(target, 'cortex.instructions.inject_on_session_start', false);
    expect(heldBack.status).toBe(200);
    try {
      const off = await sessionBlock({ sessionId: startSession, kind: 'compact', compaction: 3 });
      // The Project line survives a Deployment that holds its own text back.
      expect(off.parts?.map((p) => p.kind)).toEqual(['project']);
      expect(off.skipped).toEqual(['instructions:off']);
    } finally {
      expect((await resetSetting(target, 'cortex.instructions.inject_on_session_start')).status).toBe(200);
    }
    } finally {
      expect((await resetSetting(target, 'instructions.template')).status).toBe(200);
    }

    // A Project withdrawn from `cortex` is served nothing on a prompt, and at
    // session start is served its own Project id and nothing else: a write is
    // refused without the id, so the capability holds back the Deployment's
    // text rather than the name every write has to carry.
    await admit(false);
    try {
    const withdrawn = `parity-recall-off-${stamp}`;
    // The answer is recorded, and names the row it wrote.
    const shut = await served(withdrawn, crypto.randomUUID(), planning);
    expect({ ...shut, answerId: typeof shut.answerId }).toEqual({ persisted: true, context: '', parts: [], skipped: ['capability'], answerId: 'string' });
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
      expect([block.parts, block.skipped, block.context]).toEqual([[{ kind: 'project' }], ['capability'], `Project:: \`${target.projectId}\` — pass this as \`project\` on Myco tool calls; a write without it is refused.`]);
    }
    expect((await capabilities()).cortex).toBe(false);

    await admit(true);
    await archived(target, target.projectId, async () => {
      expect(await capabilities()).toEqual({ cortex: false, canopy: false, vault_evolution: false, spore_curation: false, spore_curation_backfill: false });
      const archivedAnswer = await served(`archived-${stamp}`, crypto.randomUUID(), planning);
      expect({ ...archivedAnswer, answerId: typeof archivedAnswer.answerId })
        .toEqual({ persisted: true, context: '', parts: [], skipped: ['capability'], answerId: 'string' });
    });
    } finally {
      await admit(true);
    }
  },
};
