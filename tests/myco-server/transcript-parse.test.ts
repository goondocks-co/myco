/**
 * Reading a held transcript into its rows, and pruning the bytes afterwards.
 *
 * Three properties carry this feature and each is asserted against the store
 * rather than against the parser in isolation:
 *
 *   - a pass spends a BOUNDED number of store calls, whatever the shape of the
 *     transcript. The bound is what keeps a pass inside a hosted runtime's
 *     per-invocation cap, and a byte bound would not have provided it: a turn
 *     of many small events and one of few large events cost very different
 *     numbers of calls for the same bytes.
 *   - the cursor never advances past an event that did not land. This is the
 *     one defect that would lose rows silently and in bulk.
 *   - many passes and one pass produce the same rows.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  parseOnce, parseTranscripts, pendingTranscriptBytes,
  TRANSCRIPT_PARSE_CALLS_PER_PASS, TRANSCRIPT_PARSE_EVENTS_PER_BATCH, TRANSCRIPT_PARSE_MALFORMED_LIMIT,
  TRANSCRIPT_PARSE_BYTES_PER_READ, TRANSCRIPT_PARSE_SEGMENTS_PER_READ, TRANSCRIPT_PARSE_RECORD_BYTES,
} from '@myco-server-worker/ingest/parse.js';
import { freeOrphanedBlobs, TOMBSTONE_SWEEP_GRACE_MS, transcriptRetention, transcriptRetentionDays } from '@myco-server-worker/ingest/retention.js';
import { listTranscripts } from '@myco-server-worker/read/transcript.js';
import { listSessions, listSessionSummaries } from '@myco-server-worker/read/sessions.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import { sessionMaterial, titleReadySessions } from '@myco-server-worker/core/titling.js';
import { listUnprocessedPrompts } from '@myco-server-worker/read/prompts.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqliteEnv, count, uuid } from './helpers/fixtures.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';

const NOW = Date.parse('2027-01-01T00:00:00Z');
const PROJECT = 'proj_1';
const SESSION = 's1';
const TRANSCRIPT = 'tx_0123456789abcdef0123456789abcdef';
const MACHINE = 'machine_1';

const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

/** A transcript body with `turns` prompt-and-reply pairs, each also making a tool call. */
function body(turns: number): string {
  // Distinct instants per line, as a real transcript carries: the rows a turn
  // produces are ordered by them.
  const at = (n: number) => new Date(Date.parse('2026-09-01T10:00:00Z') + n * 1000).toISOString();
  let out = '';
  for (let i = 0; i < turns; i += 1) {
    out += line({ type: 'user', promptId: `${uuid(i + 1)}`, message: { content: `prompt ${i}` }, timestamp: at(i * 3) });
    out += line({ type: 'assistant', message: { content: [{ type: 'text', text: `reply ${i}` }, { type: 'tool_use', id: `t${i}`, name: 'Read', input: { i } }] }, timestamp: at(i * 3 + 1) });
    out += line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] }, timestamp: at(i * 3 + 2) });
  }
  return out;
}

/** A store holding one transcript whose bytes are split into `sliceBytes` segments. */
async function rig(text: string, sliceBytes = 1 << 20, opts: { agent?: string } = {}) {
  const { sqlite, serverEnv } = sqliteEnv();
  const issued = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: MACHINE }, NOW);
  const bytes = new TextEncoder().encode(text);

  sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
              VALUES (?, ?, ?, ?, ?, ?)`, [PROJECT, SESSION, MACHINE, issued.tokenId, NOW, NOW]);
  sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
             [PROJECT, TRANSCRIPT, SESSION, MACHINE, opts.agent ?? 'claude-code', bytes.length, 1, NOW, NOW, issued.tokenId]);

  for (let at = 0; at < bytes.length; at += sliceBytes) {
    const slice = bytes.subarray(at, Math.min(at + sliceBytes, bytes.length));
    const key = await sha256HexOf(slice);
    await serverEnv.blobs.put(`${PROJECT}/${key}`, new Blob([slice]).stream());
    sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (project_id, key) DO NOTHING`, [PROJECT, key, slice.length, 'text/plain', issued.tokenId, NOW]);
    sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [PROJECT, TRANSCRIPT, at, slice.length, key, `e${at}`, NOW, NOW, issued.tokenId]);
  }
  return { sqlite, env: { db: serverEnv.db, blobs: serverEnv.blobs }, serverEnv, tokenId: issued.tokenId };
}

const target = (sqlite: Database) => {
  const row = sqlite.query(`SELECT parsed_offset, size, parse_error, fidelity FROM transcripts`).get() as
    { parsed_offset: number; size: number; parse_error: string | null; fidelity: string | null };
  return row;
};

/** Drives passes to completion, counting database calls so the bound can be asserted. */
async function drain(env: { db: unknown; blobs: unknown }, sqlite: Database, max = 50): Promise<number> {
  let passes = 0;
  while (passes < max && target(sqlite).parsed_offset < target(sqlite).size && target(sqlite).parse_error === null) {
    const t = sqlite.query(`SELECT project_id, transcript_id, session_id, machine_id, token_id, agent, size, parsed_offset, fidelity, open_prompt_id, parser_context FROM transcripts`).get() as Record<string, unknown>;
    const before = target(sqlite).parsed_offset;
    await parseOnce(env as never, {
      projectId: t.project_id as string, transcriptId: t.transcript_id as string, sessionId: t.session_id as string,
      machineId: t.machine_id as string, tokenId: t.token_id as string, agent: t.agent as string,
      size: t.size as number, parsedOffset: t.parsed_offset as number, fidelity: null,
      openPromptId: (t.open_prompt_id as string | null) ?? null,
      parserContext: typeof t.parser_context === 'string' ? JSON.parse(t.parser_context) : null,
    }, NOW);
    passes += 1;
    if (target(sqlite).parsed_offset === before) break;
  }
  return passes;
}

describe('parsing a held transcript', () => {
  const codexMessage = (role: string, text: string) => line({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } });

  it('finishes a large record across segments before reading the following human turn', async () => {
    const text = line({ type: 'session_meta', payload: { source: 'cli' } })
      + line({ type: 'event_msg', payload: { type: 'item_completed', padding: 'x'.repeat(2 * TRANSCRIPT_PARSE_BYTES_PER_READ) } })
      + codexMessage('user', 'Allow ad-hoc work regardless of the automatic cap')
      + codexMessage('assistant', 'Ad-hoc work remains available');
    const { sqlite, env } = await rig(text, TRANSCRIPT_PARSE_BYTES_PER_READ * 1.5, { agent: 'codex' });
    await drain(env, sqlite);
    expect(target(sqlite)).toMatchObject({ parsed_offset: Buffer.byteLength(text), parse_error: null });
    expect(sqlite.query('SELECT text FROM prompt_batches').all()).toEqual([{ text: 'Allow ad-hoc work regardless of the automatic cap' }]);
    expect(sqlite.query('SELECT r.text FROM responses r JOIN prompt_batches p ON p.prompt_id = r.prompt_id').all()).toEqual([{ text: 'Ad-hoc work remains available' }]);
  });

  it('keeps a genuinely unfinished native record pending', async () => {
    const text = codexMessage('user', 'Still being written').trimEnd();
    const { sqlite, env } = await rig(text, TRANSCRIPT_PARSE_BYTES_PER_READ, { agent: 'codex' });
    await drain(env, sqlite);
    expect(target(sqlite)).toMatchObject({ parsed_offset: 0, parse_error: null });
    expect(count(sqlite, 'prompt_batches')).toBe(0);
  });

  it('surfaces a record that exceeds the bounded segment lookahead', async () => {
    const segmentBytes = 128;
    const text = codexMessage('user', 'x'.repeat(segmentBytes * (TRANSCRIPT_PARSE_SEGMENTS_PER_READ + 1)));
    const { sqlite, env } = await rig(text, segmentBytes, { agent: 'codex' });
    await drain(env, sqlite);
    expect(target(sqlite)).toMatchObject({ parsed_offset: 0, parse_error: 'parse' });
    expect(count(sqlite, 'prompt_batches')).toBe(0);
  });

  it('refuses an oversized first record before combining its segments', async () => {
    const text = codexMessage('user', 'x'.repeat(TRANSCRIPT_PARSE_RECORD_BYTES));
    const { sqlite, env } = await rig(text, TRANSCRIPT_PARSE_RECORD_BYTES / 2, { agent: 'codex' });
    await drain(env, sqlite);
    expect(target(sqlite)).toMatchObject({ parsed_offset: 0, parse_error: 'parse' });
    expect(count(sqlite, 'prompt_batches')).toBe(0);
  });

  it('keeps Codex replies and tools on the human turn across appended context and parse windows', async () => {
    const opening = line({ type: 'session_meta', payload: { source: 'cli' } })
      + codexMessage('user', 'Continue checking capture');
    const context = codexMessage('user', '<environment_context>Current date: 2026-09-11</environment_context>');
    const ending = line({ type: 'response_item', payload: { type: 'function_call', call_id: 'check', name: 'shell', arguments: '{}' } })
      + line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'check', output: 'capture checked' } })
      + codexMessage('assistant', 'The capture check is complete');
    const staged = await rig(opening, 2048, { agent: 'codex' });
    await drain(staged.env, staged.sqlite);
    let size = Buffer.byteLength(opening);
    for (const text of [context, ending]) {
      const bytes = new TextEncoder().encode(text);
      const key = await sha256HexOf(bytes);
      await staged.serverEnv.blobs.put(`${PROJECT}/${key}`, new Blob([bytes]).stream());
      staged.sqlite.run('INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, ?, ?, ?, ?)',
        [PROJECT, key, bytes.length, 'text/plain', staged.tokenId, NOW]);
      staged.sqlite.run('INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [PROJECT, TRANSCRIPT, size, bytes.length, key, `e${size}`, NOW, NOW, staged.tokenId]);
      size += bytes.length;
      staged.sqlite.run('UPDATE transcripts SET size = ?', [size]);
      await drain(staged.env, staged.sqlite);
    }
    const whole = await rig(opening + context + ending, 2048, { agent: 'codex' });
    await drain(whole.env, whole.sqlite);
    for (const { sqlite, serverEnv } of [whole, staged]) {
      expect(target(sqlite).parse_error).toBeNull();
      expect(target(sqlite).parsed_offset).toBe(size);
      expect(sqlite.query('SELECT text, origin FROM prompt_batches ORDER BY text').all()).toEqual([
        { text: '<environment_context>Current date: 2026-09-11</environment_context>', origin: 'system' },
        { text: 'Continue checking capture', origin: 'user' },
      ]);
      expect(sqlite.query('SELECT p.text AS prompt, r.text AS response FROM responses r JOIN prompt_batches p ON p.prompt_id = r.prompt_id').all()).toEqual([
        { prompt: 'Continue checking capture', response: 'The capture check is complete' },
      ]);
      expect(sqlite.query('SELECT p.text AS prompt, t.output_preview AS output FROM tool_calls t JOIN prompt_batches p ON p.prompt_id = t.prompt_id').all()).toEqual([
        { prompt: 'Continue checking capture', output: 'capture checked' },
      ]);
      expect((await sessionMaterial(serverEnv.db, PROJECT, SESSION))[0].response).toContain('The capture check is complete');
    }
  });

  it('dispatches an ended Codex conversation after parsing without changing its format fidelity', async () => {
    const text = line({ type: 'session_meta', payload: { source: 'cli' } })
      + codexMessage('user', 'Read the project rules heading')
      + codexMessage('assistant', 'Project Rules')
      + codexMessage('user', 'Wait for the second turn before summarizing')
      + codexMessage('assistant', 'Both turns must finish parsing first');
    const { sqlite, env, serverEnv } = await rig(text, 2048, { agent: 'codex' });
    sqlite.run('UPDATE sessions SET ended_at = ?, titling_requested_at = ?', [NOW, NOW]);
    const titledEnv = { ...serverEnv, origin: 'https://deployment.example' };
    expect(await titleReadySessions(titledEnv, NOW)).toBe(0);
    await drain(env, sqlite);
    expect(target(sqlite)).toEqual({ parsed_offset: Buffer.byteLength(text), size: Buffer.byteLength(text), parse_error: null, fidelity: 'no_tool_results' });
    expect(await titleReadySessions(titledEnv, NOW + 1)).toBe(1);
    expect((await sessionMaterial(serverEnv.db, PROJECT, SESSION)).map((row) => row.prompt)).toEqual([
      'Read the project rules heading', 'Wait for the second turn before summarizing',
    ]);
    expect((await listUnprocessedPrompts(serverEnv.db, { projectId: PROJECT })).rows).toHaveLength(2);
    expect(await titleReadySessions(titledEnv, NOW + 2)).toBe(0);
    expect(count(sqlite, 'agent_runs')).toBe(1);
    expect(target(sqlite).fidelity).toBe('no_tool_results');
  });

  it('persists interactive user text and classified context without a developer response', async () => {
    const text = line({ type: 'session_meta', payload: { source: 'cli' } })
      + codexMessage('developer', 'Injected developer instructions')
      + codexMessage('user', '# AGENTS.md instructions for /repo\nRules')
      + codexMessage('user', '<skills_instructions>Use project skills</skills_instructions>')
      + codexMessage('user', 'Editor context\n## My request for Codex:\nFix capture')
      + codexMessage('assistant', 'Capture fixed');
    const { sqlite, env } = await rig(text, 2048, { agent: 'codex' });
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    expect(sqlite.query('SELECT text, origin FROM prompt_batches ORDER BY text').all()).toEqual([
      { text: '<skills_instructions>Use project skills</skills_instructions>', origin: 'system' },
      { text: 'Fix capture', origin: 'user' },
    ]);
    expect(sqlite.query('SELECT text FROM responses').all()).toEqual([{ text: 'Capture fixed' }]);
  });

  it.each(['exec', { subagent: { thread_spawn: { parent_thread_id: 'parent' } } }])('retains the source rule across Codex read windows: %j', async (source) => {
    const header = line({ type: 'session_meta', payload: { source } });
    const text = header + Array.from({ length: 40 }, (_, i) => codexMessage('user', `request ${i} ${'x'.repeat(600)}`)).join('');
    const { sqlite, env } = await rig(text, 2048, { agent: 'codex' });
    expect(await drain(env, sqlite)).toBeGreaterThan(1);
    expect(target(sqlite).parsed_offset).toBe(Buffer.byteLength(text));
    expect(count(sqlite, 'prompt_batches')).toBe(0);
    expect(JSON.parse((sqlite.query('SELECT parser_context FROM transcripts').get() as { parser_context: string }).parser_context)).toEqual({ source });
  });

  it('recovers a header before continuing an existing cursor without rewriting prior rows', async () => {
    const header = line({ type: 'session_meta', payload: { source: 'exec' } });
    const prior = codexMessage('user', 'already parsed');
    const text = header + prior + codexMessage('user', 'new exec request');
    const { sqlite, serverEnv } = await rig(text, 2048, { agent: 'codex' });
    const cursor = Buffer.byteLength(header + prior);
    sqlite.run('UPDATE transcripts SET parsed_offset = ?, parser_version = 1', [cursor]);
    await parseTranscripts(serverEnv, NOW);
    expect(target(sqlite).parsed_offset).toBe(cursor);
    expect(count(sqlite, 'events')).toBe(0);
    await parseTranscripts(serverEnv, NOW);
    expect(target(sqlite).parsed_offset).toBe(Buffer.byteLength(text));
    expect(count(sqlite, 'prompt_batches')).toBe(0);
    expect((await listTranscripts(serverEnv.db, { projectId: PROJECT }, SESSION))[0]).not.toHaveProperty('parserContext');
  });

  it('clears an older parse failure on successful progress so later windows remain eligible', async () => {
    const { sqlite, serverEnv } = await rig(body(100), 2048);
    sqlite.run("UPDATE transcripts SET parse_error = 'parse', parse_failed_at = 1, parser_version = 1");
    await parseTranscripts(serverEnv, NOW);
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBeGreaterThan(0);
    expect(target(sqlite).parsed_offset).toBeLessThan(target(sqlite).size);
    await drain(serverEnv, sqlite);
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'prompt_batches')).toBe(100);
  });

  it('stores the custom tool call and array output in the recorded Codex rollout', async () => {
    const text = fs.readFileSync(path.join(FIXTURES, 'codex-0.153.4-redacted.jsonl'), 'utf8');
    const { sqlite, env } = await rig(text, 1 << 20, { agent: 'codex' });
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(sqlite.query('SELECT tool_name, input, output_preview, success FROM tool_calls').all()).toEqual([
      { tool_name: 'exec', input: JSON.stringify('[redacted input]'), output_preview: '[redacted text]\n\n[redacted text]', success: 1 },
    ]);
  });

  it('derives the rows the transcript holds and advances the cursor to its end', async () => {
    const { sqlite, env } = await rig(body(2));
    await drain(env, sqlite);
    expect(count(sqlite, 'prompt_batches')).toBe(2);
    expect(count(sqlite, 'responses')).toBe(2);
    expect(count(sqlite, 'tool_calls')).toBe(2);
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
  });

  it('stamps the fidelity its parser declares, so a reader can tell what the file could support', async () => {
    const { sqlite, env } = await rig(body(1));
    await drain(env, sqlite);
    expect(target(sqlite).fidelity).toBe('full');
    const [row] = await listTranscripts(env.db as never, { projectId: PROJECT }, SESSION);
    expect(row.fidelity).toBe('full');
    expect(row.parsedOffset).toBe(row.size);
  });

  it('spends a bounded number of store calls per pass whatever the transcript holds', async () => {
    const { sqlite, env } = await rig(body(40));
    const t = sqlite.query(`SELECT * FROM transcripts`).get() as Record<string, unknown>;
    const report = await parseOnce(env as never, {
      projectId: PROJECT, transcriptId: TRANSCRIPT, sessionId: SESSION, machineId: MACHINE,
      tokenId: t.token_id as string, agent: 'claude-code', size: t.size as number, parsedOffset: 0, fidelity: null, openPromptId: null,
    }, NOW);
    expect(report.calls).toBeLessThanOrEqual(TRANSCRIPT_PARSE_CALLS_PER_PASS + 2);
    expect(report.derived).toBeGreaterThan(TRANSCRIPT_PARSE_EVENTS_PER_BATCH);
  });

  /** One prompt and many tool calls: an agentic turn with no second prompt to stop at. */
  function singleTurn(calls: number): string {
    let out = line({ type: 'user', promptId: uuid(1), message: { content: 'do a lot' }, timestamp: '2026-09-01T10:00:00Z' });
    for (let i = 0; i < calls; i += 1) {
      out += line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `s${i}`, name: 'Read', input: { i } }] }, timestamp: '2026-09-01T10:00:01Z' });
      out += line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `s${i}`, content: 'ok' }] }, timestamp: '2026-09-01T10:00:02Z' });
    }
    return out;
  }

  it('holds the call bound on a window with no prompt to stop at, which a turn-only boundary could not', async () => {
    const { sqlite, env } = await rig(singleTurn(600));
    const t = sqlite.query(`SELECT * FROM transcripts`).get() as Record<string, unknown>;
    const report = await parseOnce(env as never, {
      projectId: PROJECT, transcriptId: TRANSCRIPT, sessionId: SESSION, machineId: MACHINE,
      tokenId: t.token_id as string, agent: 'claude-code', size: t.size as number, parsedOffset: 0, fidelity: null, openPromptId: null,
    }, NOW);
    expect(report.calls).toBeLessThanOrEqual(TRANSCRIPT_PARSE_CALLS_PER_PASS + 2);
  });

  it('finishes a single agentic turn across passes, attributing every call to the one prompt', async () => {
    const { sqlite, env } = await rig(singleTurn(600));
    await drain(env, sqlite, 400);
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'tool_calls')).toBe(600);
    // The prompt opening the turn is carried across every pass, so no call is
    // orphaned by the boundary a budget happened to fall on.
    const orphans = sqlite.query(`SELECT COUNT(*) c FROM tool_calls WHERE prompt_id IS NULL`).get() as { c: number };
    expect(orphans.c).toBe(0);
  });

  it('carries the turn across a window that ended on its READ bound, not only on the call budget', async () => {
    // Small segments, so a pass ends on the window's own bound rather than on
    // the call budget. The member slices at 8 MiB and a pass takes the first
    // segment whole, so in production every slice boundary falling mid-turn
    // takes this path — and the default 1 MiB rig never does.
    const { sqlite, env } = await rig(singleTurn(30), 96);
    await drain(env, sqlite, 400);
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'tool_calls')).toBe(30);
    const orphans = sqlite.query(`SELECT COUNT(*) c FROM tool_calls WHERE prompt_id IS NULL`).get() as { c: number };
    expect(orphans.c).toBe(0);
  });

  it('retains the turn at the current upload boundary for later appended bytes', async () => {
    const { sqlite, env } = await rig(singleTurn(30), 96);
    const t = sqlite.query(`SELECT * FROM transcripts`).get() as Record<string, unknown>;
    await parseOnce(env as never, {
      projectId: PROJECT, transcriptId: TRANSCRIPT, sessionId: SESSION, machineId: MACHINE,
      tokenId: t.token_id as string, agent: 'claude-code', size: t.size as number, parsedOffset: 0, fidelity: null, openPromptId: null,
    }, NOW);
    const mid = sqlite.query(`SELECT parsed_offset, size, open_prompt_id FROM transcripts`).get() as { parsed_offset: number; size: number; open_prompt_id: string | null };
    expect(mid.parsed_offset).toBeLessThan(mid.size);
    expect(mid.open_prompt_id).not.toBeNull();

    await drain(env, sqlite, 400);
    const done = sqlite.query(`SELECT parsed_offset, size, open_prompt_id FROM transcripts`).get() as { parsed_offset: number; size: number; open_prompt_id: string | null };
    expect(done.parsed_offset).toBe(done.size);
    expect(done.open_prompt_id).toBe(mid.open_prompt_id);
  });

  it('reaches the same rows whether the bytes arrived as one segment or as many', async () => {
    const text = body(6);
    const whole = await rig(text);
    await drain(whole.env, whole.sqlite);

    // 64-byte segments cut records apart at arbitrary bytes; a record spanning
    // several of them must still derive exactly once.
    const split = await rig(text, 64);
    await drain(split.env, split.sqlite);

    // Many small segments cost one read each; a pass that spent its whole
    // budget fetching them and landed nothing would never move the cursor.
    expect(count(split.sqlite, 'transcript_segments')).toBeGreaterThan(10);
    expect(target(split.sqlite).parsed_offset).toBe(target(split.sqlite).size);
    for (const table of ['prompt_batches', 'responses', 'tool_calls']) {
      expect({ table, split: count(split.sqlite, table) }).toEqual({ table, split: count(whole.sqlite, table) });
    }
  });

  it('lands every tool call of one assistant message, which one id per byte offset could not', async () => {
    const parallel = fs.readFileSync(path.join(FIXTURES, 'claude-parse-parallel.jsonl'), 'utf8');
    const { sqlite, env } = await rig(parallel);
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'tool_calls')).toBe(2);
    expect(count(sqlite, 'plans')).toBe(2);
    const names = (sqlite.query(`SELECT input FROM tool_calls ORDER BY input`).all() as { input: string }[]).map((r) => r.input);
    expect(names).toEqual(['{"file_path":"/repo/a.ts"}', '{"file_path":"/repo/b.ts"}']);
  });

  it('stops the cursor where an event failed to land rather than advancing past it', async () => {
    const { sqlite, env } = await rig(body(2));
    // An archived Project refuses every write, so no derived event lands. The
    // cursor stays where it stood and the transcript records the failure.
    sqlite.run(`UPDATE projects SET archived_at = ? WHERE project_id = ?`, [NOW, PROJECT]);
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBe('parse');
    expect(target(sqlite).parsed_offset).toBe(0);
    expect(count(sqlite, 'prompt_batches')).toBe(0);
  });

  it('treats a row it already derived as landed, so a wider earlier window does not stop the transcript', async () => {
    const { sqlite, env } = await rig(body(2));
    await drain(env, sqlite);
    const rows = count(sqlite, 'prompt_batches') + count(sqlite, 'tool_calls');
    // Re-reading from zero re-derives every row under the same identity; each
    // is already stored, and none of that is a failure.
    sqlite.run(`UPDATE transcripts SET parsed_offset = 0`);
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    expect(count(sqlite, 'prompt_batches') + count(sqlite, 'tool_calls')).toBe(rows);
  });

  it('resumes across passes when one transcript holds more events than a pass may land', async () => {
    const { sqlite, env } = await rig(body(300));
    const passes = await drain(env, sqlite);
    expect(passes).toBeGreaterThan(1);
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'prompt_batches')).toBe(300);
    expect(count(sqlite, 'responses')).toBe(300);
    expect(count(sqlite, 'tool_calls')).toBe(300);
  });

  it('resumes against the turn it stopped in, not whatever prompt is newest in the session', async () => {
    // A single turn, so every tool call belongs to the one prompt that opened
    // it, and the pass must stop inside that turn.
    const { sqlite, env, tokenId } = await rig(singleTurn(600));
    const t = sqlite.query(`SELECT * FROM transcripts`).get() as Record<string, unknown>;
    const first = await parseOnce(env as never, {
      projectId: PROJECT, transcriptId: TRANSCRIPT, sessionId: SESSION, machineId: MACHINE,
      tokenId: t.token_id as string, agent: 'claude-code', size: t.size as number, parsedOffset: 0, fidelity: null, openPromptId: null,
    }, NOW);
    expect(first.nextOffset).toBeGreaterThan(0);
    expect(first.nextOffset).toBeLessThan(t.size as number);

    // The turn the pass stopped inside is recorded, not inferred.
    const carried = (sqlite.query(`SELECT open_prompt_id FROM transcripts`).get() as { open_prompt_id: string | null }).open_prompt_id;
    expect(carried).not.toBeNull();

    // A hook ships a NEWER prompt for the same session while the parse lags —
    // a second agent on the machine, or a subagent sibling. A lookup for the
    // session's newest prompt would take this one and attribute the resumed
    // tail to it.
    sqlite.run(`INSERT INTO prompt_batches (project_id, prompt_id, session_id, event_id, origin, text, content_hash, created_at, updated_at, token_id, received_at)
                VALUES (?, ?, ?, 'hook-event', 'user', 'a later prompt', 'h', ?, ?, ?, ?)`,
               [PROJECT, uuid(999), SESSION, NOW + 10_000, NOW + 10_000, tokenId, NOW + 10_000]);

    await drain(env, sqlite, 400);
    expect(target(sqlite).parse_error).toBeNull();
    expect(count(sqlite, 'tool_calls')).toBe(600);
    const wrong = sqlite.query(`SELECT COUNT(*) c FROM tool_calls WHERE prompt_id IS NOT ?`).get(carried) as { c: number };
    expect(wrong.c).toBe(0);
  });

  it('replaces the carried turn when a new human prompt arrives', async () => {
    const { sqlite, env } = await rig(body(2));
    await drain(env, sqlite);
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    const row = sqlite.query(`SELECT open_prompt_id FROM transcripts`).get() as { open_prompt_id: string | null };
    expect(sqlite.query('SELECT text FROM prompt_batches WHERE prompt_id = ?').get(row.open_prompt_id)).toEqual({ text: 'prompt 1' });
  });

  it('re-derives a resumed turn identically, so no row is refused as a conflict against itself', async () => {
    // A pass that stopped mid-turn would begin the next one without the prompt
    // that turn carries, deriving the same rows with a different payload; each
    // would then be refused against the row already written and the transcript
    // would stop. Every event of a resumed transcript must land.
    const { sqlite, env } = await rig(body(300));
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    const orphans = sqlite.query(`SELECT COUNT(*) c FROM tool_calls WHERE prompt_id IS NULL`).get() as { c: number };
    expect(orphans.c).toBe(0);
    const responses = sqlite.query(`SELECT COUNT(*) c FROM responses WHERE prompt_id IS NULL`).get() as { c: number };
    expect(responses.c).toBe(0);
  });

  it('is idempotent: re-running a completed parse from zero changes no row', async () => {
    const { sqlite, env } = await rig(body(3));
    await drain(env, sqlite);
    const before = count(sqlite, 'prompt_batches') + count(sqlite, 'responses') + count(sqlite, 'tool_calls');
    sqlite.run(`UPDATE transcripts SET parsed_offset = 0`);
    await drain(env, sqlite);
    expect(count(sqlite, 'prompt_batches') + count(sqlite, 'responses') + count(sqlite, 'tool_calls')).toBe(before);
  });

  it('skips an unreadable line rather than abandoning every row the rest of the file holds', async () => {
    // The junk sits between two turns, so the rows either side of it prove the
    // pass carried on rather than stopping at the bad line.
    const two = body(2).split('\n');
    const withJunk = [...two.slice(0, 3), 'not json at all', ...two.slice(3)].join('\n');
    const { sqlite, env } = await rig(withJunk);
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'prompt_batches')).toBe(2);
  });

  it('stops the transcript once unreadable lines pass the threshold: past it the file is not this format', async () => {
    const junk = Array.from({ length: TRANSCRIPT_PARSE_MALFORMED_LIMIT + 1 }, () => 'not json at all\n').join('');
    const { sqlite, env } = await rig(body(1) + junk);
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBe('parse');
  });

  it('offers a stopped transcript again once the parser moves, so no line silences a file forever', async () => {
    const junk = Array.from({ length: TRANSCRIPT_PARSE_MALFORMED_LIMIT + 1 }, () => 'not json\n').join('');
    const { sqlite, serverEnv } = await rig(body(1) + junk);
    await parseTranscripts(serverEnv, NOW);
    expect(target(sqlite).parse_error).toBe('parse');
    // A failure is recorded against the parser that hit it; a later parser is
    // offered the transcript again rather than inheriting its silence.
    expect(await pendingTranscriptBytes(serverEnv.db)).toBe(0);
    sqlite.run(`UPDATE transcripts SET parser_version = parser_version - 1`);
    expect(await pendingTranscriptBytes(serverEnv.db)).toBe(1);
  });

  it('stops when the store no longer holds a segment, rather than reading past the hole', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    const key = (sqlite.query(`SELECT blob_key FROM transcript_segments`).get() as { blob_key: string }).blob_key;
    await serverEnv.blobs.delete(`${PROJECT}/${key}`);
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBe('blob_absent');
  });

  it('offers a transcript no parser reads no further, without failing it', async () => {
    const { sqlite, env } = await rig(body(1), 1 << 20, { agent: 'windsurf' });
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'prompt_batches')).toBe(0);
  });

  it('skips a transcript belonging to a deleted session', async () => {
    const { sqlite, env, serverEnv } = await rig(body(1));
    sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES (?, ?, NULL, ?, 'm')`, [PROJECT, SESSION, NOW]);
    expect(await parseTranscripts(serverEnv, NOW)).toBe(0);
    expect(count(sqlite, 'prompt_batches')).toBe(0);
    void env;
  });

  it('reports unread bytes so a Deployment with a backlog stays awake', async () => {
    const { sqlite, env } = await rig(body(1));
    expect(await pendingTranscriptBytes(env.db as never)).toBe(1);
    await drain(env, sqlite);
    expect(await pendingTranscriptBytes(env.db as never)).toBe(0);
  });
});

describe('both jobs on a Deployment holding no transcripts', () => {
  /**
   * A tick runs these jobs everywhere, including on a Deployment that has never
   * received a transcript. Reporting anything but zero there would mean the job
   * had found work in an empty store, and every scenario that pins a wake's
   * report would move whenever an unrelated lane added a job.
   */
  /** A recent receipt, so the tick resolves to a depth that runs these jobs at all. */
  const awake = async () => {
    const { sqlite, serverEnv } = sqliteEnv();
    const issued = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: MACHINE }, NOW);
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                VALUES (?, 'awake', ?, ?, ?, ?)`, [PROJECT, MACHINE, issued.tokenId, NOW - 60_000, NOW - 60_000]);
    return { sqlite, serverEnv };
  };

  it('reports no work and derives nothing, so a wake elsewhere reads the same as before', async () => {
    const { sqlite, serverEnv } = await awake();
    const report = await runTick(serverEnv, NOW);
    const mine = report.jobs.filter((j) => j.name.startsWith('transcript-'));
    expect(mine).toEqual([
      { name: 'transcript-parse', changed: 0, failed: null },
      { name: 'transcript-retention', changed: 0, failed: null },
    ]);
    expect(count(sqlite, 'prompt_batches')).toBe(0);
  });

  it('leaves the power state alone: no unread bytes asserts nothing about depth', async () => {
    const { serverEnv } = await awake();
    const report = await runTick(serverEnv, NOW);
    expect(report.heldBy).not.toBe('transcript:pending');
  });
});

describe('fidelity decides what extraction may read', () => {
  /** A session whose transcript the parser read at reduced fidelity. */
  async function degraded() {
    const { sqlite, env } = await rig(body(1), 1 << 20, { agent: 'cursor' });
    await drain(env, sqlite);
    return { sqlite, env };
  }

  it('stamps the fidelity the format supports rather than the file', async () => {
    const { sqlite } = await degraded();
    expect(target(sqlite).fidelity).toBe('no_tool_results');
  });

  it('omits the session from listSessions with NO filter argument, which is what extraction reads', async () => {
    const { sqlite, env } = await degraded();
    void sqlite;
    expect((await listSessions(env.db as never, { projectId: PROJECT })).rows).toEqual([]);
  });

  it('shows the session to a person or an agent browsing history, labelled', async () => {
    const { env } = await degraded();
    const page = await listSessionSummaries(env.db as never, { projectId: PROJECT }, {}, NOW);
    expect(page.rows.map((r) => r.sessionId)).toEqual([SESSION]);
  });

  it('admits a full-fidelity session to both reads', async () => {
    const { sqlite, env } = await rig(body(1));
    await drain(env, sqlite);
    expect((await listSessions(env.db as never, { projectId: PROJECT })).rows).toHaveLength(1);
    expect((await listSessionSummaries(env.db as never, { projectId: PROJECT }, {}, NOW)).rows).toHaveLength(1);
  });

  it('lets either caller override the default in either direction', async () => {
    const { env } = await degraded();
    expect((await listSessions(env.db as never, { projectId: PROJECT }, { fidelity: 'any' })).rows).toHaveLength(1);
    expect((await listSessionSummaries(env.db as never, { projectId: PROJECT }, { fidelity: 'full' }, NOW)).rows).toEqual([]);
  });

  it('disqualifies a session whose PRIMARY transcript is full but whose subagent sibling is not', async () => {
    const { sqlite, env, tokenId } = await rig(body(1));
    await drain(env, sqlite);
    sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, role, fidelity, size, segment_count, parsed_offset, first_received_at, last_received_at, token_id)
                VALUES (?, 'tx_sibling', ?, ?, 'cursor', 'subagent', 'no_tool_results', 0, 0, 0, ?, ?, ?)`,
               [PROJECT, SESSION, MACHINE, NOW, NOW, tokenId]);
    expect((await listSessions(env.db as never, { projectId: PROJECT })).rows).toEqual([]);
  });
});

describe('transcript retention', () => {
  it('reads a window, treats absent and zero as indefinite, and refuses anything unreadable', () => {
    expect(transcriptRetentionDays(undefined)).toBeNull();
    expect(transcriptRetentionDays('0')).toBeNull();
    expect(transcriptRetentionDays('30')).toBe(30);
    for (const bad of ['"30"', 'null', '-1', '1.5', '4000', 'not json']) {
      expect({ bad, read: transcriptRetentionDays(bad) }).toEqual({ bad, read: 'unreadable' });
    }
  });

  it('prunes nothing when no window is set', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    await drain(env, sqlite);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
    expect(count(sqlite, 'transcript_segments')).toBeGreaterThan(0);
  });

  it('prunes nothing and says so when the window is unreadable, rather than pruning on a rule nobody wrote', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    await drain(env, sqlite);
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '"thirty"', ?, 'm')`, [NOW]);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
    expect(count(sqlite, 'transcript_segments')).toBeGreaterThan(0);
  });

  it('prunes segments past the window that the parse has already read, and keeps every derived row', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    await drain(env, sqlite);
    const derived = count(sqlite, 'prompt_batches');
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, [NOW]);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 5 * 86_400_000]);

    expect(await transcriptRetention(serverEnv, NOW)).toBeGreaterThan(0);
    expect(count(sqlite, 'transcript_segments')).toBe(0);
    expect(count(sqlite, 'prompt_batches')).toBe(derived);
    expect(count(sqlite, 'transcripts')).toBe(1);
  });

  it('keeps a segment the parse has not read, whatever its age', async () => {
    const { sqlite, serverEnv } = await rig(body(2));
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, [NOW]);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 5 * 86_400_000]);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
    expect(count(sqlite, 'transcript_segments')).toBeGreaterThan(0);
  });

  it('never deletes a segment whose blob it has not accounted for, so nothing is left unreachable', async () => {
    // Many small segments, each its own blob: more than one pass can free.
    const { sqlite, serverEnv, env } = await rig(body(20), 96);
    await drain(env, sqlite);
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, [NOW]);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 5 * 86_400_000]);
    const before = count(sqlite, 'transcript_segments');

    await transcriptRetention(serverEnv, NOW);
    // A segment gone is a blob accounted for: what remains in `blobs` is either
    // still referenced or still has its segment.
    const stranded = sqlite.query(`SELECT COUNT(*) c FROM blobs b
      WHERE NOT EXISTS (SELECT 1 FROM transcript_segments WHERE project_id = b.project_id AND blob_key = b.key)
        AND NOT EXISTS (SELECT 1 FROM prompt_batches WHERE project_id = b.project_id AND blob_key = b.key)
        AND NOT EXISTS (SELECT 1 FROM responses WHERE project_id = b.project_id AND blob_key = b.key)
        AND NOT EXISTS (SELECT 1 FROM plans WHERE project_id = b.project_id AND blob_key = b.key)
        AND NOT EXISTS (SELECT 1 FROM attachments WHERE project_id = b.project_id AND blob_key = b.key)`).get() as { c: number };
    expect(stranded.c).toBe(0);
    expect(count(sqlite, 'transcript_segments')).toBeLessThan(before);
  });

  it('drains a large backlog across ticks rather than in one', async () => {
    const { sqlite, serverEnv, env } = await rig(body(20), 96);
    await drain(env, sqlite);
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, [NOW]);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 5 * 86_400_000]);
    let ticks = 0;
    while (count(sqlite, 'transcript_segments') > 0 && ticks < 200) { await transcriptRetention(serverEnv, NOW); ticks += 1; }
    expect(ticks).toBeGreaterThan(1);
    expect(count(sqlite, 'transcript_segments')).toBe(0);
    expect(count(sqlite, 'blobs')).toBe(0);
  });

  it('collects a blob a deletion left behind, which nothing else can reach', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    // A blob no row names: what a deletion leaves once its page fills.
    sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, 1, 'text/plain', 't', ?)`, [PROJECT, 'f'.repeat(64), NOW]);
    expect(await freeOrphanedBlobs(serverEnv)).toBe(1);
    expect((sqlite.query(`SELECT COUNT(*) c FROM blobs WHERE key = ?`).get('f'.repeat(64)) as { c: number }).c).toBe(0);
  });

  /** A deletion, which is the only thing that leaves a blob behind. */
  const deleted = (sqlite: Database, at = NOW) =>
    sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES (?, 'gone', NULL, ?, 'm')`, [PROJECT, at]);

  it('collects orphans whether or not a retention window is set', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, 1, 'text/plain', 't', ?)`, [PROJECT, 'e'.repeat(64), NOW]);
    deleted(sqlite);
    // No window: raw segments are kept forever, and bytes nothing references
    // are still not kept.
    expect(await transcriptRetention(serverEnv, NOW)).toBe(1);
    expect(count(sqlite, 'transcript_segments')).toBeGreaterThan(0);
  });

  it('does not go looking for orphans on a Deployment where nothing was deleted', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, 1, 'text/plain', 't', ?)`, [PROJECT, 'd'.repeat(64), NOW]);
    // The steady state: the scan is the expensive half and nothing could have
    // made an orphan, so it is not run and the row stands until one is.
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
    expect((sqlite.query(`SELECT COUNT(*) c FROM blobs WHERE key = ?`).get('d'.repeat(64)) as { c: number }).c).toBe(1);
  });

  it('stops looking once a deletion is old enough to have drained', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, 1, 'text/plain', 't', ?)`, [PROJECT, 'c'.repeat(64), NOW]);
    deleted(sqlite, NOW - TOMBSTONE_SWEEP_GRACE_MS - 1);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
  });

  it('leaves a blob a surviving row still names', async () => {
    const { sqlite, serverEnv, env } = await rig(body(1));
    await drain(env, sqlite);
    const before = count(sqlite, 'blobs');
    expect(await freeOrphanedBlobs(serverEnv)).toBe(0);
    expect(count(sqlite, 'blobs')).toBe(before);
  });

  it('is idempotent: a second run finds nothing left to prune', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    await drain(env, sqlite);
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, [NOW]);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 5 * 86_400_000]);
    await transcriptRetention(serverEnv, NOW);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
  });
});
