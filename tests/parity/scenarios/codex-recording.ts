import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { expectPersisted, type ParityScenario } from '../harness.ts';
import { event, sessionDetail, untilPublished } from '../clients/requests.ts';

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
    // The wake publishes the recording into the session's document: the custom call is one tool call, and it succeeded.
    const published = await untilPublished(target, () => sessionDetail(target, sessionId),
      (read) => read.status === 200 && read.body.counts?.toolCalls === 1 && read.body.counts?.failedTools === 0);
    expect(published.body.counts).toMatchObject({ toolCalls: 1, failedTools: 0 });
  },
};
