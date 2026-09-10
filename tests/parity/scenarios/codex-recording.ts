import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, type ParityScenario } from '../harness.ts';

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
    const read = () => target.sql(`SELECT parsed_offset, size, parse_error FROM transcripts WHERE project_id=${lit(target.projectId)} AND transcript_id=${lit(transcriptId)}`);
    const maxWakes = 8;
    for (let wake = 0; wake < maxWakes; wake += 1) {
      const response = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(response.status).toBe(200);
      const [row] = await read();
      if (Number(row.parsed_offset) === Number(row.size)) break;
    }
    expect(await read()).toEqual([{ parsed_offset: bytes.byteLength, size: bytes.byteLength, parse_error: null }]);
    expect(await target.sql(`SELECT tool_name, input, output_preview, success FROM tool_calls WHERE project_id=${lit(target.projectId)} AND session_id=${lit(sessionId)}`)).toEqual([
      { tool_name: 'exec', input: JSON.stringify('[redacted input]'), output_preview: '[redacted text]\n\n[redacted text]', success: 1 },
    ]);
  },
};
