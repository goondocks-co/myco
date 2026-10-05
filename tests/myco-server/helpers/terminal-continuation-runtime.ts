import type { BlobStore, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { handleBlob } from '@myco-server-worker/ingest/blobs.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { parseTranscripts, pendingTranscripts, rereadTranscripts } from '@myco-server-worker/ingest/parse.js';
import { sha256HexOf, uuidv5 } from '@myco-server-worker/hash.js';
import { continuityRecords } from './continuity-records.js';

const NOW = Date.parse('2027-01-01T00:00:00Z');
const IDLE_MS = 600_000;
const SETTLE_MS = 35_000;

/** Capture, terminal wake and late-result projection through each target's runtime. */
export async function terminalContinuationRuntime(db: RelationalStore, blobs: BlobStore) {
  const limiter = { limit: async () => ({ success: true }) };
  const env = serverEnvFromBindings({ MYCO_DB: db, BUCKET: blobs, SOURCE_LIMIT: limiter, TOKEN_LIMIT: limiter });
  await db.prepare("INSERT INTO members(id,label,created_at) VALUES ('mem_terminal','Terminal',?)").bind(NOW).run();
  const token = await issueMemberToken(db, { memberId: 'mem_terminal', machineId: 'terminal-machine' }, NOW);
  const answers = [];
  for (const agent of ['claude-code', 'codex', 'pi']) {
    for (const ending of ['idle', 'session_end', 'upgrade', 'race', 'rewind_race', 'turn_end']) {
      const projectId = `proj_terminal_${agent.replace('-', '_')}_${ending}`;
      const sessionId = `terminal-${agent}-${ending}`;
      const transcriptId = `tx_${(await sha256HexOf(new TextEncoder().encode(sessionId))).slice(0, 32)}`;
      await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES (?, ?, ?)').bind(projectId, projectId, NOW).run();
      const write = async (text: string, baseOffset: number, now: number, parse = true) => {
        const bytes = new TextEncoder().encode(text);
        const digest = await sha256HexOf(bytes);
        const uploaded = await handleBlob(env, new Request(`https://test/blobs/${digest}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: bytes }),
          { projectId, machineId: 'terminal-machine', tokenId: token.tokenId, now, clock: () => now, contentLength: bytes.length, params: { key: digest } });
        const upload = await uploaded.json() as { stored?: boolean };
        if (uploaded.status !== 200 || upload.stored !== true) throw new Error(`upload refused: ${JSON.stringify(upload)}`);
        const captured = await ingestEvent(db, { projectId, machineId: 'terminal-machine', tokenId: token.tokenId, now, bodyBytes: 0 }, {
          eventId: crypto.randomUUID(), sessionId, kind: 'transcript.segment', createdAt: now, channel: 'cli',
          producer: { adapter: agent, version: 'test' }, payload: { transcriptId, baseOffset, length: bytes.length, blob: digest, agent },
        });
        if (!captured.persisted) throw new Error(`capture refused: ${JSON.stringify(captured)}`);
        if (parse) await parseTranscripts(env, now);
        return bytes.length;
      };
      const records = continuityRecords[agent].map((record) => ({ ...record, timestamp: new Date(NOW).toISOString() }));
      if (ending === 'upgrade') {
        await write(records.map((record) => JSON.stringify(record) + '\n').join(''), 0, NOW, false);
        const toolCallId = await uuidv5('tool-call', sessionId, 't1');
        await ingestEvent(db, { projectId, machineId: 'terminal-machine', tokenId: token.tokenId, now: NOW, bodyBytes: 0 }, {
          eventId: crypto.randomUUID(), sessionId, kind: 'tool.failure', createdAt: NOW, channel: 'cli',
          producer: { adapter: agent, version: 'old' }, payload: { toolCallId, toolName: 'Read', input: { path: 'a' }, success: false, errorMessage: 'no result' },
        });
        await db.prepare(`UPDATE transcripts SET parsed_offset = size, parser_version = 3, parser_context = '{"source":"cli"}' WHERE project_id = ?`).bind(projectId).run();
        const first = await parseTranscripts(env, NOW, { budget: { calls: 2, wallMs: 1000 }, clock: () => 0 });
        const rewound = await db.prepare('SELECT parsed_offset FROM transcripts WHERE project_id = ?').bind(projectId).first<{ parsed_offset: number }>();
        if (rewound?.parsed_offset !== 0 || !first.more) throw new Error('upgrade did not resumably rewind the old flat-context cursor');
        for (let wake = 0; wake < 20 && (await pendingTranscripts(db, NOW)).transcripts > 0; wake += 1)
          await parseTranscripts(env, NOW, { budget: { calls: 4, wallMs: 1000 }, clock: () => 0 });
        const repaired = await db.prepare('SELECT success, output_preview FROM tool_calls WHERE project_id = ?').bind(projectId).all<{ success: number; output_preview: string }>();
        const plans = await db.prepare('SELECT title FROM plans WHERE project_id = ? ORDER BY title').bind(projectId).all<{ title: string }>();
        const replies = await db.prepare('SELECT text FROM responses WHERE project_id = ?').bind(projectId).all<{ text: string }>();
        if (repaired.results.length !== 1 || repaired.results[0].success !== 1 || repaired.results[0].output_preview !== 'ok'
          || plans.results.length !== (agent === 'pi' ? 0 : 2) || replies.results.length !== 1 || !replies.results[0].text.includes('\n\n'))
          throw new Error('upgrade reread failed to restore plans, joined replies and a stale failed call');
        const counts = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE project_id = ?').bind(projectId).first<{ n: number }>();
        await parseTranscripts(env, NOW);
        if ((await db.prepare('SELECT COUNT(*) AS n FROM events WHERE project_id = ?').bind(projectId).first<{ n: number }>())?.n !== counts?.n)
          throw new Error('completed upgrade repeated writes');
        answers.push({ agent, ending, upgraded: true });
        continue;
      }
      const callIndex = agent === 'codex' ? 2 : 1;
      const prefix = records.slice(0, callIndex + 1).map((record) => JSON.stringify(record) + '\n').join('');
      const cursor = await write(prefix, 0, NOW);
      const tools = () => db.prepare('SELECT tool_call_id, tool_name, input, success, output_preview, error_message FROM tool_calls WHERE project_id = ?').bind(projectId).all<Record<string, unknown>>();
      if ((await tools()).results.length !== 0) throw new Error('a live read prematurely closed an unanswered call');
      if (ending === 'turn_end') {
        const secondReply = { ...records[agent === 'codex' ? 4 : 3], timestamp: new Date(NOW + 10).toISOString() };
        const nextCursor = cursor + await write(JSON.stringify(secondReply) + '\n', cursor, NOW + 10);
        await ingestEvent(db, { projectId, machineId: 'terminal-machine', tokenId: token.tokenId, now: NOW, bodyBytes: 0 }, {
          eventId: crypto.randomUUID(), sessionId, kind: 'turn', createdAt: NOW, channel: 'cli',
          producer: { adapter: agent, version: 'test' }, payload: { phase: 'end' },
        });
        await parseTranscripts(env, NOW + 10);
        if ((await db.prepare('SELECT text FROM responses WHERE project_id = ?').bind(projectId).all()).results.length !== 0)
          throw new Error('an older Stop closed reply text written after its source instant');
        await ingestEvent(db, { projectId, machineId: 'terminal-machine', tokenId: token.tokenId, now: NOW + 10, bodyBytes: 0 }, {
          eventId: crypto.randomUUID(), sessionId, kind: 'turn', createdAt: NOW + 10, channel: 'cli',
          producer: { adapter: agent, version: 'test' }, payload: { phase: 'end' },
        });
        await parseTranscripts(env, NOW + 10);
        if ((await db.prepare('SELECT text FROM responses WHERE project_id = ?').bind(projectId).all()).results.length !== 0)
          throw new Error('an equal-timestamp Stop closed reply text without causal ordering');
        await ingestEvent(db, { projectId, machineId: 'terminal-machine', tokenId: token.tokenId, now: NOW + 11, bodyBytes: 0 }, {
          eventId: crypto.randomUUID(), sessionId, kind: 'turn', createdAt: NOW + 11, channel: 'cli',
          producer: { adapter: agent, version: 'test' }, payload: { phase: 'end' },
        });
        await parseTranscripts(env, NOW + 11);
        const replies = await db.prepare('SELECT text FROM responses WHERE project_id = ?').bind(projectId).all<{ text: string }>();
        if (replies.results.length !== 1 || !replies.results[0].text.includes('\n\n') || (await tools()).results.length !== 0)
          throw new Error('a member Stop did not join the reply while retaining its unanswered call');
        if ((await pendingTranscripts(db, NOW)).transcripts !== 0) throw new Error('a finalized reply kept the turn-end queue awake');
        await write(JSON.stringify(records[callIndex + 1]) + '\n', nextCursor, NOW + 12);
        if ((await tools()).results[0]?.success !== 1 || (await tools()).results[0]?.tool_name !== 'Read')
          throw new Error('a turn end discarded its call before the result');
        answers.push({ agent, ending, upgraded: true });
        continue;
      }
      if (ending === 'rewind_race') {
        const selected = await db.prepare('SELECT parser_context FROM transcripts WHERE project_id = ?').bind(projectId).first<{ parser_context: string }>();
        let armed = false;
        let replayed = false;
        let replayContext: string | undefined;
        const racingDb: RelationalStore = {
          ...db,
          prepare(sql) { if (sql.includes('terminal_checkpoint_stable')) armed = true; return db.prepare(sql); },
          async batch(statements) {
            if (armed && !replayed) {
              replayed = true;
              await rereadTranscripts(db, { projectId, sessionId });
              await parseTranscripts(env, NOW);
              const fresh = await db.prepare('SELECT parsed_offset, size, parser_context FROM transcripts WHERE project_id = ?')
                .bind(projectId).first<{ parsed_offset: number; size: number; parser_context: string }>();
              if (fresh?.parsed_offset !== cursor || fresh.size !== cursor || fresh.parser_context === selected?.parser_context)
                throw new Error('rewind race did not replay to the same cursor with a different continuation');
              replayContext = fresh.parser_context;
            }
            return db.batch(statements);
          },
        };
        await parseTranscripts({ ...env, db: racingDb }, NOW + IDLE_MS);
        const fresh = await db.prepare('SELECT parser_context FROM transcripts WHERE project_id = ?').bind(projectId).first<{ parser_context: string }>();
        const replies = await db.prepare('SELECT text FROM responses WHERE project_id = ?').bind(projectId).all();
        if (!replayed || (await tools()).results.length !== 0 || replies.results.length !== 0 || fresh?.parser_context !== replayContext)
          throw new Error('stale terminal batch overwrote a replayed continuation at the same cursor');
        await parseTranscripts(env, NOW + IDLE_MS);
        if ((await tools()).results.length !== 1 || (await tools()).results[0].success !== 0)
          throw new Error('replayed continuation did not resume its terminal failure');
        answers.push({ agent, ending, upgraded: true });
        continue;
      }
      if (ending === 'race') {
        let armed = false;
        let appended = false;
        const racingDb: RelationalStore = {
          ...db,
          prepare(sql) { if (sql.includes('terminal_checkpoint_stable')) armed = true; return db.prepare(sql); },
          async batch(statements) {
            if (armed && !appended) {
              appended = true;
              await write(records.slice(callIndex + 1).map((record) => JSON.stringify(record) + '\n').join(''), cursor, NOW + IDLE_MS, false);
            }
            return db.batch(statements);
          },
        };
        await parseTranscripts({ ...env, db: racingDb }, NOW + IDLE_MS);
        if (!appended || (await tools()).results.length !== 0) throw new Error('stale terminal batch recorded an unanswered call after an append');
        const closed = await db.prepare('SELECT text FROM responses WHERE project_id = ?').bind(projectId).all<{ text: string }>();
        if (closed.results.length !== 0) throw new Error('stale terminal batch closed the joined reply after an append');
        await parseTranscripts(env, NOW + IDLE_MS);
        const joined = await db.prepare('SELECT text FROM responses WHERE project_id = ?').bind(projectId).all<{ text: string }>();
        if (joined.results.length !== 1 || !joined.results[0].text.includes('\n\n') || (await tools()).results[0]?.success !== 1)
          throw new Error('append retry did not preserve the joined turn and successful call');
        answers.push({ agent, ending, upgraded: true });
        continue;
      }
      const terminalAt = NOW + (ending === 'idle' ? IDLE_MS : SETTLE_MS);
      if (ending === 'session_end') {
        const ended = await ingestEvent(db, { projectId, machineId: 'terminal-machine', tokenId: token.tokenId, now: NOW, bodyBytes: 0 }, {
          eventId: crypto.randomUUID(), sessionId, kind: 'session.end', createdAt: NOW, channel: 'cli',
          producer: { adapter: agent, version: 'test' }, payload: { endedAt: NOW },
        });
        if (!ended.persisted) throw new Error(`session end refused: ${JSON.stringify(ended)}`);
      }
      await parseTranscripts(env, terminalAt - 1);
      if ((await tools()).results.length !== 0) throw new Error('a call ended before the terminal bound');
      await parseTranscripts(env, terminalAt);
      const failed = (await tools()).results;
      if (failed.length !== 1 || failed[0].success !== 0) throw new Error('an unanswered call did not become a failure at the terminal bound');
      const checkpoint = await db.prepare('SELECT parser_context FROM transcripts WHERE project_id = ?').bind(projectId).first<{ parser_context: string }>();
      if (Object.keys(JSON.parse(checkpoint!.parser_context).mycoParserState.pending ?? {}).length !== 0) throw new Error('terminal checkpoint retained pending calls');
      await write(JSON.stringify(records[callIndex + 1]) + '\n', cursor, terminalAt + 1);
      const succeeded = (await tools()).results;
      if (succeeded.length !== 1 || succeeded[0].tool_call_id !== failed[0].tool_call_id || succeeded[0].success !== 1
        || succeeded[0].tool_name !== 'Read' || succeeded[0].input !== failed[0].input || succeeded[0].output_preview !== 'ok' || succeeded[0].error_message !== null)
        throw new Error('a late result did not upgrade its original failed tool row');
      await ingestEvent(db, { projectId, machineId: 'terminal-machine', tokenId: token.tokenId, now: terminalAt + 2, bodyBytes: 0 }, {
        eventId: crypto.randomUUID(), sessionId, kind: 'tool.failure', createdAt: terminalAt + 2, channel: 'cli', producer: { adapter: agent, version: 'test' },
        payload: { toolCallId: succeeded[0].tool_call_id, toolName: 'Read', input: { path: 'a' }, success: false, errorMessage: 'late failure' },
      });
      if ((await tools()).results[0].success !== 1) throw new Error('a later failure downgraded a successful tool call');
      if ((await pendingTranscripts(db, terminalAt + 1)).transcripts !== 0) throw new Error('settled continuation stayed queued');
      answers.push({ agent, ending, upgraded: true });
    }
  }
  return answers;
}
