import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { expectPersisted, type ParityScenario } from '../harness.ts';
import { event, owner, sessionDetail, untilPublished } from '../clients/requests.ts';

export const codexRecording: ParityScenario = {
  name: 'Codex recording: custom call and array result through segment upload and wake',
  async run(target) {
    const bytes = new Uint8Array(readFileSync(new URL('../../fixtures/codex-0.153.4-redacted.jsonl', import.meta.url)));
    const digest = await sha256HexOf(bytes);
    const sessionId = `codex-recording-${crypto.randomUUID()}`;
    const transcriptId = `tx_${crypto.randomUUID().replaceAll('-', '')}`;
    await expectPersisted(await fetch(`${target.url}/blobs/${digest}`, {
      method: 'POST', headers: target.memberHeaders({ 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }), body: bytes,
    }), 'recording blob');
    await event(target, sessionId, 'transcript.segment', { transcriptId, baseOffset: 0, length: bytes.byteLength, blob: digest, agent: 'codex', headHash: digest }, Date.now(), target.projectId, { producer: { adapter: 'codex', version: '0.153.4' } });
    await event(target, sessionId, 'session.end', { endedAt: Date.now() }); // A turn's tool count settles when the session's end closes it.
    const published = await untilPublished(target, async () => ({
      detail: await sessionDetail(target, sessionId),
      turns: await owner<{ rows: Array<{ promptId: string; toolCallCount: number }> }>(target, `/api/projects/${target.projectId}/sessions/${encodeURIComponent(sessionId)}/turns`),
    }), (read) => read.detail.status === 200 && read.detail.body.counts?.toolCalls === 1 && read.detail.body.counts?.failedTools === 0 && read.turns.status === 200 && read.turns.body.rows.some((row) => row.toolCallCount >= 1));
    expect(published.detail.body.counts).toMatchObject({ toolCalls: 1, failedTools: 0 });
    const turn = published.turns.body.rows.find((row) => row.toolCallCount >= 1);
    expect(turn?.promptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const tools = await owner<{ rows: Array<{ toolName: string; success: boolean }> }>(target, `/api/projects/${target.projectId}/sessions/${encodeURIComponent(sessionId)}/turns/${turn!.promptId}/tool-calls`);
    expect(tools.status).toBe(200);
    expect(tools.body.rows).toEqual([expect.objectContaining({ toolName: 'exec', success: true })]);
  },
};
