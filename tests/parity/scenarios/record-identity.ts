import { expect } from 'bun:test';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, type ParityScenario } from '../harness.ts';

const LEGACY = 'legacy-session-v1';
const SOURCE = 'source-record-v1';

export const recordIdentity: ParityScenario = {
  name: 'Record identity: transcript pins, distinct positional replies, reread and whole-artifact restore refusals',
  async run(target) {
    const sessionId = `record-pins-${crypto.randomUUID()}`;
    const ids = [0, 1].map(() => `tx_${crypto.randomUUID().replaceAll('-', '')}`);
    const ownerPost = (path: string, body: unknown) => fetch(`${target.url}${path}`, {
      method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const ship = async (transcriptId: string, agent: string, records: unknown[]) => {
      const bytes = new TextEncoder().encode(records.map(value => JSON.stringify(value)).join('\n') + '\n');
      const digest = await sha256HexOf(bytes);
      await expectPersisted(await fetch(`${target.url}/blobs/${digest}`, {
        method: 'POST', headers: target.memberHeaders({ 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }), body: bytes,
      }), 'record blob');
      await expectPersisted(await fetch(`${target.url}/events`, {
        method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({
          eventId: crypto.randomUUID(), sessionId, kind: 'transcript.segment', channel: 'cli', createdAt: Date.now(),
          producer: { adapter: agent, version: 'record-parity' },
          payload: { transcriptId, baseOffset: 0, length: bytes.byteLength, blob: digest, agent },
        }),
      }), 'record segment');
    };
    for (const [index, transcriptId] of ids.entries()) {
      await ship(transcriptId, 'cursor', [
        { role: 'assistant', message: { content: [{ type: 'text', text: `record reply ${index}` }] } },
        { type: 'turn_ended' },
      ]);
    }
    const where = `project_id=${lit(target.projectId)} AND session_id=${lit(sessionId)}`;
    const settle = async () => {
      for (let pass = 0; pass < 20; pass += 1) {
        expect((await ownerPost('/api/wake', {})).status).toBe(200);
        const remaining = await target.sql(`SELECT COUNT(*) AS n FROM transcripts WHERE ${where} AND (parsed_offset < size OR parse_error IS NOT NULL OR json_extract(parser_context,'$.mycoParserUnfinished')=1)`);
        if (Number(remaining[0].n) === 0) return;
      }
      expect(await target.sql(`SELECT parsed_offset, size, parse_error FROM transcripts WHERE ${where}`)).toEqual([]);
    };
    const replies = () => target.sql(`SELECT response_id, event_id, text FROM responses WHERE ${where} ORDER BY response_id`);
    const pins = () => target.sql(`SELECT transcript_id, record_identity_scheme FROM transcripts WHERE ${where} ORDER BY transcript_id`);
    await settle();
    const initial = await replies();
    expect(initial.length).toBe(2);
    expect(new Set(initial.map(row => row.response_id)).size).toBe(2);
    expect((await pins()).every(row => row.record_identity_scheme === SOURCE)).toBe(true);
    expect((await ownerPost('/api/transcripts/reread', { projectId: target.projectId, sessionId })).status).toBe(200);
    await settle();
    expect(await replies()).toEqual(initial);

    const held = (await target.sql(`SELECT * FROM transcripts WHERE ${where} ORDER BY transcript_id`))[0];
    const legacyId = `tx_${crypto.randomUUID().replaceAll('-', '')}`;
    const oldRow: Record<string, unknown> = { ...held, transcript_id: legacyId, size: 0, segment_count: 0, parsed_offset: 0, parser_context: null, parser_version: 0, parsed_at: null };
    delete oldRow.record_identity_scheme;
    const artifact = (rows: Record<string, unknown>[], extra = false) => [
      { format: 'myco-backup/1', deploymentId: target.deploymentId, schemaVersion: SERVER_SCHEMA_VERSION, createdAt: 1, producer: 'record parity',
        counts: { transcripts: rows.length, ...(extra ? { projects: 1 } : {}) } },
      ...(extra ? [{ t: 'projects', r: { project_id: `proj_refused_${legacyId.slice(3)}`, name: 'must not land', created_at: 1 } }] : []),
      ...rows.map(r => ({ t: 'transcripts', r })),
    ].map(value => JSON.stringify(value)).join('\n');
    expect((await ownerPost('/api/backups/restore-upload', { artifact: artifact([held, oldRow]) })).status).toBe(200);
    expect(await target.sql(`SELECT record_identity_scheme FROM transcripts WHERE project_id=${lit(target.projectId)} AND transcript_id=${lit(legacyId)}`)).toEqual([{ record_identity_scheme: LEGACY }]);
    await ship(legacyId, 'cursor', [
      { role: 'assistant', message: { content: [{ type: 'text', text: 'legacy reply' }] } }, { type: 'turn_ended' },
    ]);
    const keyed = (recordKey: string, callKey: string, text: string) => [
      { type: 'assistant', uuid: recordKey, message: { content: [
        { type: 'text', text: `<ultraplan>\n# ${text}\n- [ ] parity\n</ultraplan>` },
        { type: 'tool_use', id: callKey, name: 'Read', input: { file_path: '/parity/read.ts' } },
      ] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: callKey, content: 'read' }] } },
      { type: 'system', subtype: 'turn_end' },
    ];
    const keyedIds = [0, 1, 2].map(() => `tx_${crypto.randomUUID().replaceAll('-', '')}`);
    await ship(keyedIds[0], 'claude-code', keyed('record-a', 'call-a', 'first keyed plan'));
    await ship(keyedIds[1], 'claude-code', keyed('record-b', 'call-b', 'second keyed plan'));
    await ship(keyedIds[2], 'claude-code', keyed('record-a', 'call-a', 'first keyed plan'));
    await expectPersisted(await fetch(`${target.url}/events`, {
      method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({
        eventId: crypto.randomUUID(), sessionId, kind: 'session.end', channel: 'cli', createdAt: Date.now(),
        producer: { adapter: 'cursor', version: 'record-parity' }, payload: { endedAt: Date.now() },
      }),
    }), 'record session end');
    await settle();
    const logical = async () => Promise.all([
      replies(),
      target.sql(`SELECT tool_call_id, event_id, tool_name FROM tool_calls WHERE ${where} ORDER BY tool_call_id`),
      target.sql(`SELECT plan_key, event_id, content FROM plans WHERE ${where} ORDER BY plan_key`),
      target.sql(`SELECT event_id, kind, json_extract(payload,'$.responseId') AS response_id, json_extract(payload,'$.toolCallId') AS tool_call_id, json_extract(payload,'$.planKey') AS plan_key FROM events WHERE ${where} AND kind IN ('response','tool.use','plan') ORDER BY event_id`),
    ]);
    const frozen = await logical();
    expect(frozen[0].length).toBe(5);
    expect(frozen[1].length).toBe(2);
    expect(frozen[2].length).toBe(2);
    expect(frozen[3].filter(row => row.kind === 'response').length).toBe(6);
    expect((await pins()).filter(row => row.record_identity_scheme === LEGACY).length).toBe(1);
    expect((await pins()).filter(row => row.record_identity_scheme === SOURCE).length).toBe(5);
    const tables = ['transcripts', 'transcript_segments', 'transcript_parser_state_chunks', 'events', 'responses', 'tool_calls', 'plans', 'processed_resources', 'tags'];
    const carried = (await Promise.all(tables.map(async table => ({ table, rows: await target.sql(
      table === 'transcript_parser_state_chunks' || table === 'transcript_segments'
        ? `SELECT * FROM ${table} WHERE project_id=${lit(target.projectId)} AND transcript_id IN (SELECT transcript_id FROM transcripts WHERE ${where})`
        : table === 'processed_resources' ? `SELECT * FROM ${table} WHERE project_id=${lit(target.projectId)} AND event_id IN (SELECT event_id FROM events WHERE ${where})`
          : table === 'tags' ? `SELECT * FROM tags WHERE project_id=${lit(target.projectId)} AND entity_kind='plan' AND entity_id IN (SELECT plan_key FROM plans WHERE ${where})`
            : `SELECT * FROM ${table} WHERE ${where}`,
    ) })))).flatMap(({ table, rows }) => rows.map(r => ({ t: table, r })));
    const counts: Record<string, number> = {};
    for (const row of carried) counts[row.t] = (counts[row.t] ?? 0) + 1;
    const roundTrip = [
      { format: 'myco-backup/1', deploymentId: target.deploymentId, schemaVersion: SERVER_SCHEMA_VERSION, createdAt: 1, producer: 'record parity', counts },
      ...carried,
    ].map(value => JSON.stringify(value)).join('\n');
    expect((await ownerPost('/api/backups/restore-upload', { artifact: roundTrip })).status).toBe(200);
    expect(await logical()).toEqual(frozen);
    const sensitive = async () => Promise.all([
      pins(), replies(), target.sql('SELECT * FROM backup_restore_progress ORDER BY table_name'), target.sql('SELECT * FROM raw_provenance_state'),
      target.sql('SELECT * FROM raw_restore_revisions ORDER BY artifact_hash'),
      target.sql(`SELECT project_id FROM projects WHERE project_id=${lit(`proj_refused_${legacyId.slice(3)}`)}`),
    ]);
    for (const [pin, code] of [[LEGACY, 'record_identity_scheme_conflict'], ['future-v1', 'record_identity_scheme_unsupported']] as const) {
      const before = await sensitive();
      const refused = await ownerPost('/api/backups/restore-upload', { artifact: artifact([{ ...held, record_identity_scheme: pin }], true) });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: code });
      expect(await sensitive()).toEqual(before);
    }
    expect((await ownerPost('/api/transcripts/reread', { projectId: target.projectId, sessionId })).status).toBe(200);
    await settle();
    expect(await logical()).toEqual(frozen);
    const unresolved = await target.sql(`SELECT COUNT(*) AS n FROM events e LEFT JOIN responses r ON r.project_id=e.project_id AND r.response_id=json_extract(e.payload,'$.responseId')
      WHERE e.project_id=${lit(target.projectId)} AND e.session_id=${lit(sessionId)} AND e.kind='response' AND (r.response_id IS NULL OR r.session_id<>e.session_id)`);
    expect(Number(unresolved[0].n)).toBe(0);
    const unresolvedCalls = await target.sql(`SELECT COUNT(*) AS n FROM events e LEFT JOIN tool_calls c ON c.project_id=e.project_id AND c.tool_call_id=json_extract(e.payload,'$.toolCallId')
      WHERE e.project_id=${lit(target.projectId)} AND e.session_id=${lit(sessionId)} AND e.kind='tool.use' AND (c.tool_call_id IS NULL OR c.session_id<>e.session_id)`);
    expect(Number(unresolvedCalls[0].n)).toBe(0);
    expect(Number((await target.sql(`SELECT COUNT(*) AS n FROM tags t LEFT JOIN plans p ON p.project_id=t.project_id AND p.plan_key=t.entity_id
      WHERE t.project_id=${lit(target.projectId)} AND t.entity_kind='plan' AND t.entity_id IN (SELECT plan_key FROM plans WHERE ${where}) AND p.plan_key IS NULL`))[0].n)).toBe(0);
  },
};
