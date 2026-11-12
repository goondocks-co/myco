import { expect } from 'bun:test';
import { uuidv5 } from '@myco-server-worker/hash.js';
import type { ParityScenario } from '../harness.ts';
import { context, deliver, promptContext, publishedTurns, recallSettings, turn } from '../clients/capture.ts';
import { createProject, event, owner, putSetting, untilPublished } from '../clients/requests.ts';

/** Delivered context and subagent hints place only on prompts the session holds. */
export const hookPlacement: ParityScenario = {
  name: 'hook placement: session and Project hints, delivery, and unplaced hook records',
  async run(target) {
    await recallSettings(target);
    expect((await putSetting(target, 'cortex.plans.inject_intent_nudge_on_prompt_submit', true)).status).toBe(200);
    const session = `hook-placement-${crypto.randomUUID()}`, otherSession = session + '-other', foreign = `proj_${crypto.randomUUID()}`;
    const [previous, late, wrongSession, wrongProject] = Array.from({ length: 4 }, () => crypto.randomUUID());
    expect((await createProject(target, foreign, 'Other')).status).toBe(201);
    await event(target, session, 'session.start', { agent: 'claude-code', startedAt: Date.now() });
    const prompt = (id: string, ownSession = session, project = target.projectId) => event(target, ownSession, 'prompt', { promptId: id, text: 'same text', origin: 'user' }, Date.now(), project);
    await prompt(previous); await prompt(wrongSession, otherSession); await prompt(wrongProject, session, foreign);
    await publishedTurns(target, session, rows => rows.length === 1);
    const answer = await promptContext(target, session, late, 'Let us write the implementation plan for placement.');
    expect(answer.parts.map((part: any) => part.kind)).toContain('plan-nudge');
    await deliver(target, session, { answerId: answer.answerId }, { renderedIn: late });
    await context(target, 'session', { sessionId: session, kind: 'start' });
    await context(target, 'session', { sessionId: session, kind: 'subagent', agentId: 'reviewer', agentType: 'reviewer' });
    const subagent = await uuidv5('subagent', session, 'reviewer');
    await event(target, session, 'subagent.start', { subagentId: subagent, parentPromptId: wrongProject });
    await event(target, session, 'turn', { promptId: wrongSession, phase: 'end' });
    await event(target, session, 'subagent.stop', { subagentId: crypto.randomUUID() });
    const path = `/api/projects/${target.projectId}/sessions/${session}`;
    const read = async (query = '') => { const answer = await owner(target, path + '/unplaced' + query); expect(answer.status).toBe(200); return answer.body as { rows: { key: string; id: string }[]; cursor: string | null }; };
    const before = await read();
    expect(before.rows.map(row => row.id)).toContain(answer.answerId);
    expect(before.rows.map(row => row.id)).toContain('cortex:reviewer');
    expect((await turn(target, session, previous)).body.answers).toEqual([]);
    await prompt(late);
    await publishedTurns(target, session, rows => rows.length === 2);
    expect((await read()).rows.map(row => row.id)).not.toContain(answer.answerId);
    expect((await turn(target, session, late)).body.answers.map((row: any) => row.id)).toContain(answer.answerId);
    const full = await read(), paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await read('?limit=1' + (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor)));
      paged.push(...page.rows.map(row => row.key)); cursor = page.cursor;
    } while (cursor !== null);
    expect(paged).toEqual(full.rows.map(row => row.key));
    for (const adapter of ['codex', 'cursor']) {
      const hookSession = session + '-' + adapter, toolId = crypto.randomUUID();
      await event(target, hookSession, 'session.start', { agent: adapter, startedAt: Date.now() });
      await event(target, hookSession, 'tool.use', { toolCallId: toolId, toolName: 'Shell', input: { command: 'true' }, success: true });
      const unplaced = await untilPublished(target, () => owner(target, `/api/projects/${target.projectId}/sessions/${hookSession}/unplaced-records`), answer => answer.status === 200 && answer.body.rows?.some((row: any) => row.id === toolId));
      expect(unplaced.body.rows.map((row: any) => row.id)).toContain(toolId);
    }
    for (const agent of ['claude-code', 'codex']) {
      const captured = session + '-subagents-' + agent;
      await event(target, captured, 'session.start', { agent, startedAt: Date.now() });
      await context(target, 'session', { sessionId: captured, kind: 'subagent', agentId: 'reviewer', agentType: 'reviewer' });
      expect((await owner(target, `/api/projects/${target.projectId}/sessions/${captured}`)).body.turnContexts).toEqual({});
      expect((await owner(target, `/api/projects/${target.projectId}/sessions/${captured}/unplaced`)).body.rows.map((row: any) => row.id)).toEqual(['cortex:reviewer']);
    }
  },
};
