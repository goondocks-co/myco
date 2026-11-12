import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { blob, publishedTurns, transcript, turn } from '../clients/capture.ts';
import { event, owner } from '../clients/requests.ts';

const cursorLine = (role: string, text: string): string => `${JSON.stringify({ role, message: { content: [{ type: 'text', text }] } })}\n`;

/** Captured transcript and spilled tool input remain readable through the session's turns. */
export const sessionDocuments: ParityScenario = {
  name: 'session documents: a wake publishes a transcript and spilled tool input readable through its turns',
  async run(target) {
    const session = `documents-${crypto.randomUUID()}`;
    await transcript(target, session, cursorLine('user', '<user_query>\nfirst question\n</user_query>') + cursorLine('assistant', 'first answer')
      + cursorLine('user', '<user_query>\nsecond question\n</user_query>') + cursorLine('assistant', 'second answer'));
    const page = await publishedTurns(target, session, rows => rows.length === 2 && rows[0]?.responseCount === 1);
    expect(page.body.rows.map((row: any) => row.preview)).toEqual(['first question', 'second question']);
    expect((await turn(target, session, page.body.rows[0].promptId)).body.responses.map((row: any) => row.text)).toEqual(['first answer']);
    const hookSession = session + '-hook', promptId = crypto.randomUUID(), input = `tool input ${session}`;
    await event(target, hookSession, 'prompt', { promptId, text: 'read it', origin: 'user' });
    await event(target, hookSession, 'tool.use', { toolCallId: crypto.randomUUID(), promptId, toolName: 'Read', blob: await blob(target, new TextEncoder().encode(input)), success: true });
    await publishedTurns(target, hookSession, rows => rows[0]?.toolCallCount === 1);
    const calls = await owner(target, `/api/projects/${target.projectId}/sessions/${hookSession}/turns/${promptId}/tool-calls`);
    expect(calls.status).toBe(200); expect(calls.body.rows).toMatchObject([{ toolName: 'Read', inputPreview: input, success: true }]);
  },
};
