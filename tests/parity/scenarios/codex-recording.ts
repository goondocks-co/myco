import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { expectPersisted, type ParityScenario } from '../harness.ts';
import { owner, sessionDetail, untilPublished, wake } from '../clients/requests.ts';

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
    await expectPersisted(await fetch(`${target.url}/events`, {
      method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        eventId: crypto.randomUUID(), sessionId, kind: 'transcript.segment', createdAt: Date.now(), channel: 'cli',
        producer: { adapter: 'codex', version: '0.153.4' },
        payload: { transcriptId, baseOffset: 0, length: bytes.byteLength, blob: digest, agent: 'codex', headHash: digest },
      }),
    }), 'recording segment');
    // The wake publishes the recording into the session the reader opens: one custom call, and it succeeded.
    const published = await untilPublished(target, async () => {
      await wake(target);
      return sessionDetail(target, sessionId);
    }, (read) => read.status === 200 && read.body.counts?.toolCalls === 1 && read.body.counts?.failedTools === 0);
    expect(published.body.counts).toMatchObject({ toolCalls: 1, failedTools: 0 });
    const turns = await owner<{ rows: Array<{ promptId: string; toolCallCount: number }> }>(target, `/api/projects/${target.projectId}/sessions/${encodeURIComponent(sessionId)}/turns`);
    expect(turns.status).toBe(200);
    const turn = turns.body.rows.find((row) => row.toolCallCount >= 1);
    expect(turn?.promptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const tools = await owner<{ rows: Array<{ toolName: string; success: boolean }> }>(target, `/api/projects/${target.projectId}/sessions/${encodeURIComponent(sessionId)}/turns/${turn!.promptId}/tool-calls`);
    expect(tools.status).toBe(200);
    expect(tools.body.rows).toEqual([expect.objectContaining({ toolName: 'exec', success: true })]);
  },
};
