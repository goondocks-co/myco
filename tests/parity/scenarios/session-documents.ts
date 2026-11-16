import fs from 'node:fs';
import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { blob, publishedTurns, transcript, turn } from '../clients/capture.ts';
import { event, owner, sessionDetail } from '../clients/requests.ts';

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

/** Vendor transcript records are readable through the same session pages as hook records. */
export const harnessTranscripts: ParityScenario = {
  name: 'session documents: Copilot and Antigravity replies and terminal transcript status',
  async run(target) {
    for (const agent of ['copilot', 'antigravity']) {
      const session = `${agent}-${crypto.randomUUID()}`;
      const text = fs.readFileSync(new URL(`../../fixtures/${agent}-parse-basic.jsonl`, import.meta.url), 'utf8');
      const bytes = new TextEncoder().encode(text);
      const producer = { adapter: agent, version: '1' };
      await event(target, session, 'session.start', { agent }, Date.now(), target.projectId, { producer });
      await event(target, session, 'transcript.segment', { transcriptId: `tx_${crypto.randomUUID().replaceAll('-', '')}`, baseOffset: 0,
        length: bytes.byteLength, blob: await blob(target, bytes), agent }, Date.now(), target.projectId, { producer });
      await event(target, session, 'session.end', { endedAt: Date.now() }, Date.now(), target.projectId, { producer });
      const page = await publishedTurns(target, session, rows => rows[0]?.responseCount === 1);
      expect(page.body.rows.map((row: any) => row.preview)).toEqual(['Inspect the orchard.']);
      expect((await turn(target, session, page.body.rows[0].promptId)).body.responses.map((row: any) => row.text)).toEqual(['The orchard has pears.']);
      expect((await sessionDetail(target, session)).body.untitled).not.toBe('capture_pending');
    }
  },
};
