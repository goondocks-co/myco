import { expect } from 'bun:test';
import { envelopeHash } from '@myco-server-worker/ingest/events.js';
import { parseEnvelope } from '@myco-server-worker/ingest/envelope.js';
import { declaredScheme } from '@myco-server-worker/ingest/prompt-scheme.js';
import { PARSER_VERSION, TRANSCRIPT_IDLE_MS, TRANSCRIPT_REPAIRS_PER_WAKE } from '@myco-server-worker/ingest/parse.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, type ParityScenario } from '../harness.ts';

export const transcriptGenerationRepair: ParityScenario = {
  name: 'Transcript generation repair: archived failures and growing generation 6 cursors under both record schemes',
  dedicated: { timeoutMs: 240_000 },
  async run(target) {
    const project = lit(target.projectId);
    const wake = async () => {
      const response = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(response.status).toBe(200);
      const body = await response.json() as { jobs: Array<{ name: string; failed: string | null }> };
      for (const job of body.jobs.filter(job => ['transcript-parse', 'storage-content-cleanup'].includes(job.name))) {
        expect(job.failed, job.name).toBeNull();
      }
    };
    await target.sql(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('retention.raw_days','1',${Date.now()},'parity')
      ON CONFLICT(leaf) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`);
    for (const recordScheme of ['legacy-session-v1', 'source-record-v1']) {
      const sessionId = `generation-repair-${crypto.randomUUID()}`;
      const transcriptId = `tx_${crypto.randomUUID().replaceAll('-', '')}`;
      const where = `project_id=${project} AND session_id=${lit(sessionId)}`;
      const transcriptWhere = `project_id=${project} AND transcript_id=${lit(transcriptId)}`;
      const at = new Date().toISOString();
      const ship = async (records: unknown[], baseOffset: number) => {
        const bytes = new TextEncoder().encode(records.map(record => JSON.stringify(record)).join('\n') + '\n');
        const digest = await sha256HexOf(bytes);
        await expectPersisted(await fetch(`${target.url}/blobs/${digest}`, {
          method: 'POST', headers: target.memberHeaders({ 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }), body: bytes,
        }), 'generation bytes');
        await expectPersisted(await fetch(`${target.url}/events`, {
          method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind: 'transcript.segment', createdAt: Date.now(), channel: 'cli',
            producer: { adapter: 'claude-code', version: 'generation-parity' },
            payload: { transcriptId, agent: 'claude-code', baseOffset, length: bytes.byteLength, blob: digest } }),
        }), 'generation segment');
        return baseOffset + bytes.byteLength;
      };
      const calls = () => target.sql(`SELECT * FROM tool_calls WHERE ${where} ORDER BY tool_name`);
      const raw = () => target.sql(`SELECT * FROM events WHERE ${where} AND kind='tool.failure' ORDER BY event_id`);
      const settle = async () => {
        for (let pass = 0; pass < 12; pass++) {
          await wake();
          const state = (await target.sql(`SELECT parsed_offset,size,parse_error FROM transcripts WHERE ${transcriptWhere}`))[0];
          expect(state.parse_error).toBeNull();
          if (state.parsed_offset === state.size) return;
        }
        throw new Error('generation repair did not reach the transcript size');
      };
      await expectPersisted(await fetch(`${target.url}/events`, {
        method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind: 'session.start', createdAt: Date.now(), channel: 'cli',
          producer: { adapter: 'claude-code', version: 'generation-parity' }, payload: { agent: 'claude-code', startedAt: Date.now() } }),
      }), 'generation session');
      await target.sql(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,segment_count,
        first_received_at,last_received_at,token_id,prompt_identity_scheme,record_identity_scheme)
        SELECT project_id,${lit(transcriptId)},session_id,machine_id,'claude-code',0,0,first_received_at,last_received_at,
          created_by_token_id,${lit(declaredScheme('claude-code')!)},${lit(recordScheme)} FROM sessions WHERE ${where}`);
      const size = await ship([
        { type: 'assistant', uuid: 'generation-assistant', timestamp: at, message: { content: [
          { type: 'tool_use', id: 'reported', name: 'Read', input: {} },
          { type: 'tool_use', id: 'unfinished', name: 'Bash', input: {} },
        ] } },
        { type: 'user', timestamp: at, message: { content: [
          { type: 'tool_result', tool_use_id: 'reported', is_error: true, content: 'Exit code 2' },
        ] } },
      ], 0);
      await settle();
      await target.sql(`UPDATE transcripts SET last_received_at=${Date.now() - TRANSCRIPT_IDLE_MS - 1} WHERE ${transcriptWhere}`);
      await settle();
      expect((await calls()).map(row => [row.tool_name, row.result_reason])).toEqual([['Bash', 'no_result'], ['Read', 'reported']]);
      const original = (await raw()).find(row => JSON.parse(String(row.payload)).resultReason === 'reported')!;
      const payload = JSON.parse(String(original.payload));
      delete payload.resultReason;
      const parsed = parseEnvelope({ eventId: original.event_id, sessionId, kind: original.kind, channel: original.channel,
        createdAt: original.created_at, producer: { adapter: original.producer_adapter, version: original.producer_version }, payload }, Date.now());
      if (!parsed.ok) throw new Error('generation fixture envelope is invalid');
      await target.sql(`UPDATE events SET payload=${lit(parsed.value.payloadJson)},envelope_hash=${lit(await envelopeHash(parsed.value))},payload_bytes=${parsed.value.payloadBytes.byteLength}
        WHERE project_id=${project} AND event_id=${lit(String(original.event_id))}`);
      await target.sql(`UPDATE tool_calls SET result_reason=NULL WHERE ${where} AND tool_name='Read'`);
      await target.sql(`UPDATE events SET received_at=${Date.now() - 2 * 86_400_000} WHERE ${where} AND kind='tool.failure'`);
      for (let pass = 0; pass < 12; pass++) {
        await wake();
        if ((await raw()).every(row => row.payload_format === 'archived')) break;
      }
      expect((await raw()).map(row => [row.payload_format, row.payload])).toEqual([['archived', '{}'], ['archived', '{}']]);
      const heldRaw = await raw();
      const heldCalls = await calls();
      await target.sql(`UPDATE transcripts SET parser_version=6 WHERE ${transcriptWhere}`);
      // Older cursors fill the preparation page before this live cursor is selected.
      for (let index = 0; index < TRANSCRIPT_REPAIRS_PER_WAKE; index++) {
        await target.sql(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,segment_count,
          first_received_at,last_received_at,token_id,prompt_identity_scheme,record_identity_scheme,parsed_offset,parser_version)
          SELECT project_id,${lit(`tx_${(recordScheme === 'legacy-session-v1' ? '0' : '1') + String(index).padStart(31, '0')}`)},session_id,machine_id,agent,size,0,
            first_received_at,last_received_at,token_id,prompt_identity_scheme,record_identity_scheme,size,5
          FROM transcripts WHERE ${transcriptWhere}`);
      }
      await ship([{ type: 'user', timestamp: new Date().toISOString(), message: { content: [
        { type: 'tool_result', tool_use_id: 'unfinished', is_error: true, content: 'late Exit code 2' },
      ] } }], size);
      await settle();
      expect(await target.sql(`SELECT parser_version, json_extract(parser_context,'$.mycoParserRepair.version') AS version,
        json_extract(parser_context,'$.mycoParserRepair.fromVersion') AS previous FROM transcripts WHERE ${transcriptWhere}`))
        .toEqual([{ parser_version: PARSER_VERSION, version: PARSER_VERSION, previous: 6 }]);
      expect(await calls()).toEqual(heldCalls.map(row => ({ ...row, result_reason: 'reported' })));
      expect(await raw()).toEqual(heldRaw);
      expect(PARSER_VERSION).toBeGreaterThan(6);
      await target.sql(`UPDATE transcripts SET parser_version=${PARSER_VERSION} WHERE ${where}`);
    }
  },
};
