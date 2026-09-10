/**
 * The gate #1147 opened and #1155 closes: one transcript, one writer.
 *
 * Under #1147 two arms wrote the same rows — the member's own derivation over
 * the transcript and the Deployment's parse of the same bytes — and this file
 * held them equal. Under #1155 the member derives nothing from a transcript the
 * Deployment parses: the retained hooks ship the bytes, and the parse is the
 * only writer. What this file holds now is that REPLAYING THE RETAINED HOOKS
 * over the A3 parity fixture reproduces the parity rows — the prompts (typed
 * and queued, on their derived ids), the plan under the key the parse derives,
 * the tool call and the reply — and that no second writer exists: every turn
 * row carries the parse's producer, and the member's side of the wire holds
 * only the session, the segments and the end.
 *
 * The hooks are the REAL ones, driven through the same runner a harness
 * invokes, against the in-process worker. A replayed list of envelopes would
 * prove the parse reads a transcription of the member rather than the member.
 * Cross-package imports belong in `tests/meta/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { KINDS } from '@myco-server-worker/ingest/kinds.js';
import { parseTranscripts, TRANSCRIPT_PRODUCER } from '@myco-server-worker/ingest/parse.js';
import { planKeyForTag, promptIdFor } from '@myco-server-worker/ingest/parsers/index.js';
import { memberRig, tempMycoHome, type MemberRig } from '../member/helpers/server.js';
import { registerTestMember, recordingFetch, runHook } from '../member/helpers/hooks.js';

const SESSION = 's-parity';

/** The A3 parity fixture: a typed prompt, a reply carrying a tagged plan and a tool call, the tool's result, a queued command, a closing reply. */
const transcriptText = [
  { type: 'user', promptId: '11111111-1111-4111-8111-111111111111', message: { content: 'add the retention window' }, uuid: 'u1', timestamp: '2026-09-01T10:00:01Z', sessionId: SESSION },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Working.\n\n<ultraplan>\n# Retention\n- [ ] leaf\n</ultraplan>' }, { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/repo/x.ts' } }] }, uuid: 'a1', timestamp: '2026-09-01T10:00:02Z', sessionId: SESSION },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok' }] }, uuid: 'r1', timestamp: '2026-09-01T10:00:03Z', sessionId: SESSION },
  { type: 'attachment', attachment: { type: 'queued_command', prompt: 'and run the tests' }, uuid: '22222222-2222-4222-8222-222222222222', timestamp: '2026-09-01T10:00:04Z', sessionId: SESSION },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Tests pass.' }] }, uuid: 'a2', timestamp: '2026-09-01T10:00:05Z', sessionId: SESSION },
].map((o) => `${JSON.stringify(o)}\n`).join('');

let mycoHome: string;
let rig: MemberRig;
let spy: ReturnType<typeof recordingFetch>;
const savedHome = process.env.MYCO_HOME;

beforeEach(async () => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  resetMachineIdCache();
  rig = await memberRig();
  registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt });
  spy = recordingFetch(rig.fetch);
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  resetMachineIdCache();
});

/** The transcript on disk, which is what the hooks read. */
function onDisk(text: string, sessionId = SESSION): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-parity-'));
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, text);
  return file;
}

/** The retained hooks over one session: start, the prompt hook for the typed prompt, the turn end, the session end. */
async function replay(file: string, sessionId = SESSION, prompt = 'add the retention window'): Promise<void> {
  const common = { session_id: sessionId, transcript_path: file, cwd: '/repo' };
  await runHook('session-start', { ...common, hook_event_name: 'SessionStart' }, { fetch: spy.fetch });
  await runHook('user-prompt-submit', { ...common, hook_event_name: 'UserPromptSubmit', prompt }, { fetch: spy.fetch });
  await runHook('stop', { ...common, hook_event_name: 'Stop', last_assistant_message: 'Tests pass.' }, { fetch: spy.fetch });
  await runHook('session-end', { ...common, hook_event_name: 'SessionEnd' }, { fetch: spy.fetch });
  for (let pass = 0; pass < 20; pass += 1) {
    if ((await parseTranscripts(rig.env.serverEnv, Date.now())) === 0) break;
  }
}

const rows = (table: string, columns: string[], order: string): Record<string, unknown>[] =>
  rig.env.sqlite.query(`SELECT ${columns.join(', ')} FROM ${table} WHERE project_id = 'proj_1' ORDER BY ${order}`).all() as Record<string, unknown>[];

describe('retained-hook replay reproduces the parity rows', () => {
  it('lands both prompts on the ids the parse derives, with their text and origin', async () => {
    await replay(onDisk(transcriptText));
    expect(rows('prompt_batches', ['prompt_id', 'text', 'origin', 'prompt_kind'], 'text')).toEqual([
      { prompt_id: await promptIdFor(SESSION, 'user_prompt', '11111111-1111-4111-8111-111111111111'), text: 'add the retention window', origin: 'user', prompt_kind: 'user_prompt' },
      { prompt_id: await promptIdFor(SESSION, 'queued_command', '22222222-2222-4222-8222-222222222222'), text: 'and run the tests', origin: 'user', prompt_kind: 'queued_command' },
    ]);
  });

  it('lands the tagged plan under the key the parse derives, with the channel it arrived through', async () => {
    await replay(onDisk(transcriptText));
    expect(rows('plans', ['plan_key', 'title', 'content', 'status', 'source', 'origin_path'], 'plan_key')).toEqual([
      { plan_key: await planKeyForTag(SESSION, 'ultraplan', 0), title: 'Retention', content: '# Retention\n- [ ] leaf', status: 'active', source: 'tag', origin_path: 'transcript:ultraplan' },
    ]);
  });

  it('lands the tool call with its result and the replies, keyed to the prompts that produced them', async () => {
    await replay(onDisk(transcriptText));
    const typed = await promptIdFor(SESSION, 'user_prompt', '11111111-1111-4111-8111-111111111111');
    const queued = await promptIdFor(SESSION, 'queued_command', '22222222-2222-4222-8222-222222222222');
    expect(rows('tool_calls', ['prompt_id', 'tool_name', 'output_preview', 'success'], 'tool_name')).toEqual([{ prompt_id: typed, tool_name: 'Read', output_preview: 'ok', success: 1 }]);
    expect(rows('responses', ['prompt_id', 'text'], 'text')).toEqual([
      { prompt_id: queued, text: 'Tests pass.' },
      { prompt_id: typed, text: 'Working.\n\n<ultraplan>\n# Retention\n- [ ] leaf\n</ultraplan>' },
    ]);
  });

  it('has one writer: every turn row carries the parse\'s producer, and the member\'s side holds only the session, the segment and the end', async () => {
    await replay(onDisk(transcriptText));
    const producers = (kind: string) => new Set((rig.env.sqlite.query(`SELECT DISTINCT producer_adapter a FROM events WHERE kind = ?`).all(kind) as { a: string }[]).map((r) => r.a));
    for (const kind of ['prompt', 'tool.use', 'response', 'plan']) expect({ kind, producers: [...producers(kind)] }).toEqual({ kind, producers: [TRANSCRIPT_PRODUCER.adapter] });
    const member = (rig.env.sqlite.query(`SELECT kind FROM events WHERE producer_adapter <> ? ORDER BY received_at, rowid`).all(TRANSCRIPT_PRODUCER.adapter) as { kind: string }[]).map((r) => r.kind);
    expect(member).toEqual(['session.start', 'transcript.segment', 'session.end']);
    // One events row per fact: a second writer would show here before it showed anywhere else.
    expect(rig.rows('events')).toBe(3 + 2 + 1 + 1 + 2);
    expect(rig.rows('prompt_batches')).toBe(2);
    expect(rig.rows('responses')).toBe(2);
  });

  it('covers every kind the member still ships and every kind the parse writes, from the catalogue rather than a list', () => {
    const names = KINDS.map((k) => k.name);
    for (const kind of ['session.start', 'session.end', 'transcript.segment', 'plan', 'tool.use', 'tool.failure']) expect(names).toContain(kind);
    for (const kind of ['prompt', 'response', 'tool.use', 'tool.failure', 'plan']) expect(names).toContain(kind);
  });
});

describe('retained-hook replay under a compaction continuation', () => {
  it('derives only the continued session\'s own prompts, each once', async () => {
    const continued = fs.readFileSync(path.join(import.meta.dir, '..', 'fixtures', 'claude-compact-continuation.jsonl'), 'utf8');
    const lines = continued.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    // The fixture names its own session; the hooks are driven against that id.
    const sessionId = (lines.find((l) => typeof l.sessionId === 'string' && l.type === 'user')?.sessionId as string | undefined)
      ?? (lines.at(-1)?.sessionId as string);
    await replay(onDisk(continued, sessionId), sessionId, 'x');
    const texts = (rig.env.sqlite.query(`SELECT text FROM prompt_batches WHERE session_id = ? ORDER BY text`).all(sessionId) as { text: string }[]).map((r) => r.text);
    expect(texts.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(texts.length);
    // The continued session is the one registered; the predecessor it names is carried as lineage, not re-derived.
    expect((rig.env.sqlite.query(`SELECT parent_session_id, parent_reason FROM sessions WHERE session_id = ?`).get(sessionId) as { parent_session_id: string | null; parent_reason: string | null }))
      .toEqual({ parent_session_id: 'old-session-id', parent_reason: 'compact continuation' });
  });
});
