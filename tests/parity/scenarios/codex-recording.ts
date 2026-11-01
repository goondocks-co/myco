import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { documentsPublished, expectPersisted, lit, type ParityScenario } from '../harness.ts';

export const codexRecording: ParityScenario = {
  name: 'Codex recording: custom call and array result through segment upload and wake',
  async run(target) {
    const bytes = new Uint8Array(readFileSync(new URL('../../fixtures/codex-0.153.4-redacted.jsonl', import.meta.url)));
    const digest = await sha256HexOf(bytes);
    const sessionId = `codex-recording-${crypto.randomUUID()}`;
    const transcriptId = `tx_${crypto.randomUUID().replaceAll('-', '')}`;
    await target.sql(`INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES (${lit(target.projectId)},'Codex recording',${Date.now()})`);
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
    // The wake publishes the recording into the session's document: the custom call is one tool call, and it succeeded.
    await documentsPublished(target, sessionId);
    expect(await target.sql(`SELECT p.published_offset, p.state, d.tool_calls, d.failed_tools FROM transcript_publication p
      JOIN session_documents d ON d.project_id = p.project_id AND d.session_id = p.session_id AND d.generation = p.generation AND d.state = 'live'
      WHERE p.project_id=${lit(target.projectId)} AND p.transcript_id=${lit(transcriptId)}`))
      .toEqual([{ published_offset: bytes.byteLength, state: 'active', tool_calls: 1, failed_tools: 0 }]);
  },
};
