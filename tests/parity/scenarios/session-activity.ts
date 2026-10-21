import { expect } from 'bun:test';
import { listSessionActivity, type SessionActivityRow } from '@myco-server-worker/read/session-activity.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { envelopeHash } from '@myco-server-worker/ingest/events.js';
import { parseEnvelope } from '@myco-server-worker/ingest/envelope.js';
import { TRANSCRIPT_IDLE_MS } from '@myco-server-worker/ingest/parse.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, type ParityTarget, type ParityScenario } from '../harness.ts';

/** The read's own statements and bound keys, captured without accessing a store. */
async function issued(projectId: string, sessionId: string, cursor?: string): Promise<Array<{ sql: string; binds: unknown[] }>> {
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string): PreparedStatement {
      const record = { sql, binds: [] as unknown[] };
      statements.push(record);
      const statement = {
        bind(...values: unknown[]) { record.binds = values; return statement; },
        all: async () => ({ results: [] }),
      } as unknown as PreparedStatement;
      return statement;
    },
  } as unknown as RelationalStore;
  await listSessionActivity(db, { projectId }, sessionId, { type: 'no_result', tool: 'Bash', failed: true, cursor });
  return statements;
}

/** Stored result reasons, scoped metadata filters and success upgrades through both front doors. */
export const sessionActivityParity: ParityScenario = {
  name: 'session activity: stored reasons, scoped keyset filters, prompt targets and success upgrade',
  async run(target) {
    const stamp = Date.now();
    const session = `parity-activity-${stamp}`;
    const prompt = crypto.randomUUID();
    const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
    const post = async (kind: string, at: number, payload: Record<string, unknown>) => {
      const response = await fetch(`${target.url}/events`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind, createdAt: at, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      });
      await expectPersisted(response, kind);
    };
    const read = async (query = '') => {
      const response = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${session}/activity${query}`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      return await response.json() as { rows: SessionActivityRow[]; cursor: string | null; tools: string[] };
    };
    await post('session.start', stamp, { agent: 'claude-code', startedAt: stamp });
    await post('prompt', stamp + 1, { promptId: prompt, origin: 'user', text: 'Inspect activity' });
    const reasons = ['reported', 'no_result:idle', 'pending_limit', 'no_result:complete_file', 'no_result:session_end'] as const;
    for (const [index, resultReason] of reasons.entries()) {
      await post('tool.use', stamp + index + 2, { toolCallId: ids[index], promptId: index === 0 ? prompt : undefined, toolName: index === 0 ? 'Read' : 'Bash', input: { secret: 'activity input secret' }, output: 'activity output secret', success: false, resultReason });
    }
    await target.sql(`INSERT INTO tool_calls(project_id,session_id,tool_call_id,event_id,tool_name,success,result_reason,error_message,created_at,token_id,received_at)
      VALUES (${lit(target.projectId)},${lit(session)},${lit(ids[5])},${lit(ids[5])},'Legacy',0,NULL,'activity error secret',${stamp + 10},'legacy',${stamp + 10})`);
    const full = await read();
    expect(full.rows.map(row => row.id)).toEqual([ids[5], ids[4], ids[3], ids[2], ids[1], ids[0]]);
    expect(full.rows.at(-1)?.promptId).toBe(prompt);
    expect(full.rows.slice(0, -1).every(row => row.promptId === null && row.detail.includes('Not tied to a prompt'))).toBe(true);
    expect(full.rows[0]).toMatchObject({ title: 'Tool call did not succeed', resultReason: null });
    expect(JSON.stringify(full)).not.toMatch(/activity input secret|activity output secret|activity error secret/);
    expect(await target.sql(`SELECT result_reason FROM tool_calls WHERE project_id=${lit(target.projectId)} AND tool_call_id=${lit(ids[1])}`)).toEqual([{ result_reason: 'no_result:idle' }]);
    expect((await read('?tool=Read&type=failure&failed=true&limit=1')).rows.map(row => row.id)).toEqual([ids[0]]);
    const first = await read('?type=no_result&limit=2');
    expect(first.tools).toEqual(['Bash', 'Legacy', 'Read']);
    const second = await read(`?type=no_result&limit=2&cursor=${encodeURIComponent(first.cursor!)}`);
    expect([...first.rows, ...second.rows].map(row => row.id)).toEqual([ids[4], ids[3], ids[2], ids[1]]);
    expect(second.cursor).toBeNull();
    for (const cursor of [undefined, first.cursor!]) {
      const statements = await issued(target.projectId, session, cursor);
      let next = 0;
      const sql = statements[0].sql.replace(/\?/g, () => {
        const value = statements[0].binds[next++];
        return typeof value === 'number' ? String(value) : lit(String(value));
      });
      const plan = (await target.sql(`EXPLAIN QUERY PLAN ${sql}`)).map(row => String(row.detail)).join('\n');
      expect(plan).toContain('idx_tool_calls_activity');
      expect(plan).not.toMatch(/SCAN t\b|TEMP B-TREE/);
      expect(plan).toMatch(/SEARCH p USING (?:COVERING )?INDEX/);
    }
    await post('tool.use', stamp + 20, { toolCallId: ids[1], toolName: 'Bash', input: {}, output: 'success', success: true });
    expect(await target.sql(`SELECT success,result_reason,created_at FROM tool_calls WHERE project_id=${lit(target.projectId)} AND tool_call_id=${lit(ids[1])}`)).toEqual([{ success: 1, result_reason: null, created_at: stamp + 3 }]);
    expect((await read()).rows.map(row => row.id)).not.toContain(ids[1]);
    await verifyParserResultReplay(target);
  },
};


/** A retained transcript supplies result metadata again under its original record identities. */
async function verifyParserResultReplay(target: ParityTarget): Promise<void> {
  const sessionId = `activity-parser-${crypto.randomUUID()}`;
  const transcriptId = `tx_${crypto.randomUUID().replaceAll('-', '')}`;
  const timestamp = new Date().toISOString();
  const where = `project_id=${lit(target.projectId)} AND session_id=${lit(sessionId)}`;
  const transcriptWhere = `project_id=${lit(target.projectId)} AND transcript_id=${lit(transcriptId)}`;
  const records = [
    { type: 'user', uuid: crypto.randomUUID(), promptId: crypto.randomUUID(), message: { role: 'user', content: 'Inspect parser result metadata' }, timestamp },
    { type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'reported-call', name: 'Read', input: {} },
      { type: 'tool_use', id: 'unfinished-call', name: 'Bash', input: {} },
    ] }, timestamp },
    { type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'reported-call', is_error: true, content: 'reported fixture failure' },
    ] }, timestamp },
  ];
  const ship = async (values: unknown[], baseOffset: number) => {
    const bytes = new TextEncoder().encode(values.map(value => JSON.stringify(value)).join('\n') + '\n');
    const digest = await sha256HexOf(bytes);
    await expectPersisted(await fetch(`${target.url}/blobs/${digest}`, {
      method: 'POST', headers: target.memberHeaders({ 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }), body: bytes,
    }), 'activity transcript bytes');
    await expectPersisted(await fetch(`${target.url}/events`, {
      method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind: 'transcript.segment', createdAt: Date.now(), channel: 'cli',
        producer: { adapter: 'claude-code', version: 'activity-parity' },
        payload: { transcriptId, agent: 'claude-code', blob: digest, baseOffset, length: bytes.byteLength } }),
    }), 'activity transcript segment');
    return baseOffset + bytes.byteLength;
  };
  const settle = async () => {
    for (let pass = 0; pass < 8; pass++) {
      const response = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(response.status).toBe(200);
      const state = (await target.sql(`SELECT parsed_offset,size,parse_error FROM transcripts WHERE ${transcriptWhere}`))[0];
      expect(state.parse_error).toBeNull();
      if (state.parsed_offset === state.size) return;
    }
    throw new Error('activity transcript did not reach its captured size');
  };
  const calls = () => target.sql(`SELECT tool_call_id,tool_name,event_id,result_reason FROM tool_calls WHERE ${where} ORDER BY tool_name`);
  const rawEvent = async (eventId: string) => (await target.sql(`SELECT * FROM events WHERE project_id=${lit(target.projectId)} AND event_id=${lit(eventId)}`))[0];
  const size = await ship(records, 0);
  await settle();
  expect((await calls()).map(row => [row.tool_name, row.result_reason])).toEqual([['Read', 'reported']]);
  const idleAt = Date.now() - TRANSCRIPT_IDLE_MS - 1;
  await target.sql(`UPDATE transcripts SET last_received_at=${idleAt} WHERE ${transcriptWhere}`);
  await target.sql(`UPDATE sessions SET last_received_at=${idleAt} WHERE ${where}`);
  await settle();
  const closed = await calls();
  expect(closed.map(row => [row.tool_name, row.result_reason])).toEqual([['Bash', 'no_result:idle'], ['Read', 'reported']]);
  const synthetic = closed[0];
  const syntheticRaw = await rawEvent(String(synthetic.event_id));
  await ship([{ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'unfinished-call', is_error: true, content: 'late fixture failure' },
  ] }, timestamp: new Date().toISOString() }], size);
  await settle();
  expect((await calls()).map(row => [row.tool_name, row.result_reason])).toEqual([['Bash', 'reported'], ['Read', 'reported']]);
  expect(await rawEvent(String(synthetic.event_id))).toEqual(syntheticRaw);

  const reported = (await calls()).find(row => row.tool_name === 'Read')!;
  const original = await rawEvent(String(reported.event_id));
  const payload = JSON.parse(String(original.payload)) as Record<string, unknown>;
  delete payload.resultReason;
  const parsed = parseEnvelope({ eventId: original.event_id, sessionId: original.session_id, kind: original.kind, createdAt: original.created_at,
    channel: original.channel, producer: { adapter: original.producer_adapter, version: original.producer_version }, payload }, Date.now());
  if (!parsed.ok) throw new Error('legacy activity envelope fixture is invalid');
  const digest = await envelopeHash(parsed.value);
  await target.sql(`UPDATE events SET payload=${lit(parsed.value.payloadJson)},envelope_hash=${lit(digest)},payload_bytes=${parsed.value.payloadBytes.byteLength}
    WHERE project_id=${lit(target.projectId)} AND event_id=${lit(String(reported.event_id))}`);
  await target.sql(`UPDATE tool_calls SET result_reason=NULL WHERE project_id=${lit(target.projectId)} AND tool_call_id=${lit(String(reported.tool_call_id))}`);
  const legacyRaw = await rawEvent(String(reported.event_id));
  expect(legacyRaw.envelope_hash).toBe(digest);
  expect(JSON.parse(String(legacyRaw.payload))).not.toHaveProperty('resultReason');
  const reread = await fetch(`${target.url}/api/transcripts/reread`, {
    method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: target.projectId, sessionId }),
  });
  expect(reread.status).toBe(200);
  await settle();
  expect((await calls()).map(row => [row.tool_name, row.result_reason])).toEqual([['Bash', 'reported'], ['Read', 'reported']]);
  expect(await rawEvent(String(reported.event_id))).toEqual(legacyRaw);
  expect(await rawEvent(String(synthetic.event_id))).toEqual(syntheticRaw);
}
