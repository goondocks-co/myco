import type { BlobStore, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { handleBlob } from '@myco-server-worker/ingest/blobs.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { parseTranscripts, rereadTranscripts, TRANSCRIPT_IDLE_MS } from '@myco-server-worker/ingest/parse.js';
import { legacyReplies } from '@myco-server-worker/ingest/legacy-replies.js';
import { MAX_PAYLOAD_BYTES } from '@myco-server-worker/ingest/envelope.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { continuityRecords } from './continuity-records.js';
import { processedBody } from '@myco-server-worker/read/processed.js';

const NOW = Date.parse('2027-01-01T00:00:00Z');
const TIME = '2026-09-01T10:00:00Z';

/** Real upload, event admission and parser passes over each target's shipped store. */
export async function ingestContinuityRuntime(db: RelationalStore, blobs: BlobStore) {
  const limiter = { limit: async () => ({ success: true }) };
  const env = serverEnvFromBindings({ MYCO_DB: db, BUCKET: blobs, SOURCE_LIMIT: limiter, TOKEN_LIMIT: limiter });
  await db.prepare("INSERT INTO members(id,label,created_at) VALUES ('mem_continuity','Continuity',?)").bind(NOW).run();
  const token = await issueMemberToken(db, { memberId: 'mem_continuity', machineId: 'continuity-machine' }, NOW);
  for (const projectId of ['proj_continuity_whole', 'proj_continuity_split', 'proj_continuity_large', 'proj_continuity_pending', 'proj_continuity_legacy'])
    await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES (?, ?, ?)').bind(projectId, projectId, NOW).run();

  const outcomes = [];
  for (const [agent, raw] of Object.entries(continuityRecords)) {
    const sessionId = `continuity-${agent}`;
    const transcriptId = `tx_${(await sha256HexOf(new TextEncoder().encode(agent))).slice(0, 32)}`;
    const records = raw.map((record, n) => ({ ...record, timestamp: new Date(Date.parse(TIME) + n).toISOString(), at: new Date(Date.parse(TIME) + n).toISOString() }));
    const ship = async (projectId: string, text: string, baseOffset: number) => {
      const bytes = new TextEncoder().encode(text);
      const digest = await sha256HexOf(bytes);
      const uploaded = await handleBlob(env, new Request(`https://test/blobs/${digest}`, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: bytes,
      }), { projectId, machineId: 'continuity-machine', tokenId: token.tokenId, now: NOW, clock: () => NOW,
        contentLength: bytes.length, params: { key: digest } });
      const answer = await uploaded.json() as { stored: boolean };
      if (!answer.stored) throw new Error(`upload refused: ${JSON.stringify(answer)}`);
      const captured = await ingestEvent(db, { projectId, machineId: 'continuity-machine', tokenId: token.tokenId, now: NOW, bodyBytes: 0 }, {
        eventId: crypto.randomUUID(), sessionId, kind: 'transcript.segment', createdAt: NOW - 1000, channel: 'cli',
        producer: { adapter: agent, version: 'test' }, payload: { transcriptId, baseOffset, length: bytes.length, blob: digest, agent },
      });
      if (!captured.persisted) throw new Error(`segment refused: ${JSON.stringify(captured)}`);
      for (let pass = 0; pass < 20; pass += 1) {
        await parseTranscripts(env, NOW);
        const state = await db.prepare('SELECT parsed_offset, size, parse_error FROM transcripts WHERE project_id = ? AND transcript_id = ?').bind(projectId, transcriptId).first<{ parsed_offset: number; size: number; parse_error: string | null }>();
        if (state?.parse_error !== null) throw new Error(`parse failure: ${JSON.stringify(state)}`);
        if (state.parsed_offset === state.size) return bytes.length;
      }
      throw new Error('parse did not complete');
    };
    const snapshot = async (projectId: string) => {
      const result: Record<string, unknown> = {};
      for (const table of ['prompt_batches', 'responses', 'tool_calls', 'plans', 'tags']) {
        const rows = (await db.prepare(`SELECT * FROM ${table} WHERE project_id = ? ORDER BY rowid`).bind(projectId).all<Record<string, unknown>>()).results;
        result[table] = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !['project_id', 'token_id', 'received_at', 'first_received_at', 'last_received_at'].includes(key))))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      return result;
    };
    await ship('proj_continuity_whole', records.map((record) => JSON.stringify(record) + '\n').join(''), 0);
    let offset = 0;
    for (const record of records) offset += await ship('proj_continuity_split', JSON.stringify(record) + '\n', offset);
    if (agent === 'claude-code') {
      const largeProject = 'proj_continuity_pending';
      const calls = Array.from({ length: 14 }, (_, n) => ({ type: 'tool_use', id: `pending-${n}`, name: 'Read',
        input: { content: ('🌱'.repeat(25_000) + 'x'.repeat(80_000)), path: `file-${n}` } }));
      const prefix = JSON.stringify({ type: 'assistant', timestamp: TIME, message: { content: calls } }) + '\n';
      const prefixBytes = await ship(largeProject, prefix, 0);
      const state = await db.prepare('SELECT parser_context FROM transcripts WHERE project_id = ? AND transcript_id = ?').bind(largeProject, transcriptId).first<{ parser_context: string }>();
      if (JSON.parse(state!.parser_context).mycoParserState.chunked !== true) throw new Error('large pending map was not chunked');
      const chunks = (await db.prepare('SELECT length(CAST(payload AS BLOB)) AS bytes FROM transcript_parser_state_chunks WHERE project_id = ? AND transcript_id = ?').bind(largeProject, transcriptId).all<{ bytes: number }>()).results;
      if (chunks.length < 2 || chunks.some((chunk) => chunk.bytes > MAX_PAYLOAD_BYTES)) throw new Error('checkpoint chunk exceeds storage bound');
      const results = calls.map((call) => ({ type: 'tool_result', tool_use_id: call.id, content: 'ok' }));
      await ship(largeProject, JSON.stringify({ type: 'user', timestamp: TIME, message: { content: results } }) + '\n', prefixBytes);
      const tools = (await db.prepare('SELECT tool_call_id, input, success FROM tool_calls WHERE project_id = ? AND session_id = ?').bind(largeProject, sessionId).all<{ tool_call_id: string; input: string; success: number }>()).results;
      if (tools.length !== calls.length) throw new Error('large pending state lost tool calls');
      for (const tool of tools) {
        const input = await processedBody(env, { projectId: largeProject }, 'tool-input', tool.tool_call_id);
        if (tool.success !== 1 || new TextEncoder().encode(tool.input).byteLength > 2048 || input === null || JSON.parse(input).content !== calls[0].input.content) throw new Error('large pending state lost tool inputs or results');
      }
      if ((await db.prepare('SELECT COUNT(*) AS n FROM transcript_parser_state_chunks WHERE project_id = ? AND transcript_id = ?').bind(largeProject, transcriptId).first<{ n: number }>())!.n !== 0) throw new Error('closed pending state retained its chunks');
    }
    if (agent === 'claude-code') {
      const project = 'proj_continuity_legacy';
      const texts = ['first legacy reply ', ' second legacy reply'];
      const legacyRecords = [records[0], ...texts.map((text) => ({ type: 'assistant', timestamp: TIME, message: { content: [{ type: 'text', text }] } })), records[4]];
      const legacyText = legacyRecords.map((record) => JSON.stringify(record) + '\n').join('');
      const bytes = await ship(project, legacyText, 0);
      const oldText = texts.join('\n\n').trim();
      const oldRows = (await db.prepare('SELECT response_id, text FROM responses WHERE project_id = ? ORDER BY rowid').bind(project).all<{ response_id: string; text: string }>()).results;
      if (oldRows.length !== 1 || oldRows[0].text !== oldText) throw new Error('legacy fixture did not close its joined reply');
      await db.prepare('UPDATE transcripts SET parser_version = 3 WHERE project_id = ?').bind(project).run();
      const foreign = await legacyReplies(db, project, 'another-transcript', [{
        kind: 'response', offset: 0, createdAt: NOW, payload: { responseId: oldRows[0].response_id, text: texts[0].trim() },
      }], { legacyReplies: { until: bytes } }, () => {});
      if (foreign.size !== 0) throw new Error('legacy coverage crossed transcript ownership');
      await rereadTranscripts(db, { projectId: project, sessionId });
      await ship(project, JSON.stringify({ type: 'assistant', timestamp: TIME, message: { content: [{ type: 'text', text: 'later reply' }] } }) + '\n', bytes);
      await parseTranscripts(env, NOW + TRANSCRIPT_IDLE_MS);
      await rereadTranscripts(db, { projectId: project, sessionId });
      await parseTranscripts(env, NOW + TRANSCRIPT_IDLE_MS);
      const held = (await db.prepare('SELECT text FROM responses WHERE project_id = ? ORDER BY rowid').bind(project).all<{ text: string }>()).results;
      if (JSON.stringify(held) !== JSON.stringify([{ text: oldText }, { text: 'later reply' }])) throw new Error('legacy reread duplicated reply text');
    }
    const whole = await snapshot('proj_continuity_whole');
    const split = await snapshot('proj_continuity_split');
    // Each agent has its own session; compare this agent's rows from accumulated projects.
    const onlySession = (snapshot: Record<string, unknown>) => Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table,
      (rows as Record<string, unknown>[]).filter((row) => row.session_id === sessionId || table === 'tags')]));
    const a = onlySession(whole);
    const b = onlySession(split);
    const equal = JSON.stringify(a) === JSON.stringify(b);
    if (!equal) throw new Error(`${agent} whole/split differs: ${JSON.stringify({ a, b })}`);

    const huge = '🌱\\"\n'.repeat(100_000);
    const large = records.map((record) => JSON.parse(JSON.stringify(record, (key, value) => {
      if (typeof value === 'string' && ['text', 'content'].includes(key) && ['start', 'first'].includes(value)) return huge;
      return value;
    })) as Record<string, unknown>);
    await ship('proj_continuity_large', large.map((record) => JSON.stringify(record) + '\n').join(''), 0);
    const later = await db.prepare("SELECT text FROM prompt_batches WHERE project_id = 'proj_continuity_large' AND session_id = ? AND text = 'later'").bind(sessionId).first();
    if (later === null) throw new Error(`${agent} lost later turn`);
    outcomes.push({ agent, equal, later: true });
  }
  return outcomes;
}
