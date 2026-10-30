import { expect } from 'bun:test';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

const cursorLine = (role: string, text: string): string => `${JSON.stringify({ role, message: { content: [{ type: 'text', text }] } })}\n`;

/**
 * Session documents on both targets: a live transcript shipped after the step is published by the wake into chunks
 * the catalog names, with its turns, counters and publisher frontier, beside the rows today's readers serve.
 */
export const sessionDocuments: ParityScenario = {
  name: 'session documents: a wake publishes a new transcript into registered chunks with its turn catalog',
  async run(target: ParityTarget) {
    const stamp = crypto.randomUUID().replaceAll('-', '');
    const sessionId = `documents-${stamp}`;
    const transcriptId = `tx_${stamp}`;
    const text = cursorLine('user', '<user_query>\nfirst question\n</user_query>') + cursorLine('assistant', 'first answer')
      + cursorLine('user', '<user_query>\nsecond question\n</user_query>') + cursorLine('assistant', 'second answer');
    const bytes = new TextEncoder().encode(text);
    const digest = await sha256HexOf(bytes);
    await expectPersisted(await fetch(`${target.url}/blobs/${digest}`, {
      method: 'POST', headers: target.memberHeaders({ 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }), body: bytes,
    }), 'segment blob');
    await expectPersisted(await fetch(`${target.url}/events`, {
      method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        eventId: crypto.randomUUID(), sessionId, kind: 'transcript.segment', createdAt: Date.now() - 60_000, channel: 'cli',
        producer: { adapter: 'cursor', version: '2026.09' },
        payload: { transcriptId, baseOffset: 0, length: bytes.byteLength, blob: digest, agent: 'cursor' },
      }),
    }), 'segment');

    const published = async () => (await target.sql(`SELECT p.published_offset, d.prompts, d.replies, d.due_at FROM session_documents d
      JOIN transcript_publication p ON p.project_id=d.project_id AND p.transcript_id=${lit(transcriptId)} AND p.generation=d.generation
      WHERE d.project_id=${lit(target.projectId)} AND d.session_id=${lit(sessionId)} AND d.state='live'`))[0];
    for (let wake = 0; wake < 8; wake += 1) {
      await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      if (Number((await published())?.published_offset) === bytes.byteLength) break;
    }
    expect(await published()).toMatchObject({ published_offset: bytes.byteLength, prompts: 2 });
    const turns = await target.sql(`SELECT preview, replies FROM session_prompts WHERE project_id=${lit(target.projectId)}
      AND session_id=${lit(sessionId)} AND turn_key=prompt_id ORDER BY ord`);
    expect(turns.map((row) => row.preview)).toEqual(['first question', 'second question']);
    expect(Number(turns[0]!.replies)).toBe(1);
    const chunks = await target.sql(`SELECT c.kind, b.key FROM session_chunks c LEFT JOIN blobs b ON b.project_id=c.project_id AND b.key=c.blob_key
      WHERE c.project_id=${lit(target.projectId)} AND c.session_id=${lit(sessionId)}`);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((row) => row.kind === 'page' && typeof row.key === 'string')).toBe(true);
    const pages = await target.sql(`SELECT owner FROM session_pages WHERE project_id=${lit(target.projectId)} AND session_id=${lit(sessionId)}`);
    expect(pages.length).toBe(2);
  },
};
