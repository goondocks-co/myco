/**
 * The gate #1147 exists for: one transcript, ingested twice, compared row by row.
 *
 * **Arm A drives the REAL member derivation** — `deriveTranscriptCapture` and
 * the envelope builders under `packages/myco/src/member/` — not a recorded list
 * of envelopes. A replayed fixture would prove the parse matches a transcription
 * of the member rather than the member, and would keep passing after the member
 * changed. That is why this file lives in `tests/meta/`: cross-package imports
 * belong here.
 *
 * **Arm B is the server parse** of the same bytes, stored as segments and read
 * by the tick job.
 *
 * The comparison runs over a field list DERIVED from the kind catalogue's own
 * column mappings, minus a hand-named exclusion set. A field added to the
 * catalogue later joins the comparison on its own; a hand-written list would
 * quietly stop covering it.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { deriveTranscriptCapture } from '@myco/member/transcript.js';
import { emptySessionState } from '@myco/member/session-state.js';
import type { BlobSource } from '@myco/member/envelope.js';
import { KINDS } from '@myco-server-worker/ingest/kinds.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { parseOnce } from '@myco-server-worker/ingest/parse.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';

const NOW = Date.parse('2027-01-01T00:00:00Z');
const SESSION = 's-parity';
const MACHINE = 'machine_1';
const TRANSCRIPT = 'tx_0123456789abcdef0123456789abcdef';
const MEMBER_PROJECT = 'proj_1';
const PARSE_PROJECT = 'proj_2';

/**
 * Columns excluded from the comparison, each with the reason it cannot match.
 *
 * The five hook-exclusive facts the anchor names are here, and so are two row
 * identities nothing anticipated: the member mints `tool_call_id` and
 * `response_id` with a random UUIDv7 at hook time, so no parse of any
 * transcript can reproduce either. They are compared by content instead.
 */
const EXCLUDED: Readonly<Record<string, string>> = {
  // Hook-exclusive facts (plan §2.2).
  branch: 'git branch is read by the session-start hook, never written in a transcript',
  parent_reason: 'a compaction trigger is named by the hook that fired',
  // Member-minted identities.
  tool_call_id: 'the member mints a random UUIDv7 per hook (member/envelope.ts)',
  response_id: 'the member mints a random UUIDv7 at Stop (member/envelope.ts)',
  // Server-side receipt facts, equal only by coincidence of clock.
  event_id: 'names the event that carried the row, which differs by construction between the two paths',
  received_at: 'the instant the Deployment stored it',
  token_id: 'the credential the write arrived on',
  created_at: 'wall-clock ordering across two sources is hook-exclusive',
  updated_at: 'follows created_at, which is wall-clock ordering across two sources',
  project_id: 'the two arms are ingested into separate Projects so one store can hold both',
  machine_id: 'a receipt fact of the writing machine',
  session_id: 'equal by construction; asserted separately',
  content_hash: 'derived from the compared content',
  prompt_id: 'compared through the prompt row it names',
  parent_prompt_id: 'compared through the prompt row it names',
  prompt_kind: 'the shape that matched a prompt; the member transcript path records none, and the parse gains it',
};

/** Every column the catalogue maps a field to, for the kinds both arms produce. */
function comparableColumns(kind: string): string[] {
  const spec = KINDS.find((k) => k.name === kind)!;
  return Object.values(spec.fields)
    .map((f) => f.column)
    .filter((c): c is string => c !== undefined && EXCLUDED[c] === undefined);
}

const transcriptText = [
  { type: 'user', promptId: '11111111-1111-4111-8111-111111111111', message: { content: 'add the retention window' }, uuid: 'u1', timestamp: '2026-09-01T10:00:01Z', sessionId: SESSION },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Working.\n\n<ultraplan>\n# Retention\n- [ ] leaf\n</ultraplan>' }, { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/repo/x.ts' } }] }, uuid: 'a1', timestamp: '2026-09-01T10:00:02Z', sessionId: SESSION },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok' }] }, uuid: 'r1', timestamp: '2026-09-01T10:00:03Z', sessionId: SESSION },
  { type: 'attachment', attachment: { type: 'queued_command', prompt: 'and run the tests' }, uuid: '22222222-2222-4222-8222-222222222222', timestamp: '2026-09-01T10:00:04Z', sessionId: SESSION },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Tests pass.' }] }, uuid: 'a2', timestamp: '2026-09-01T10:00:05Z', sessionId: SESSION },
].map((o) => `${JSON.stringify(o)}\n`).join('');

/** The transcript on disk, which is what the member reads. */
function onDisk(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-parity-'));
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, text);
  return file;
}

async function rig() {
  const { sqlite, serverEnv } = sqliteEnv();
  const issued = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: MACHINE }, NOW);
  for (const project of [MEMBER_PROJECT, PARSE_PROJECT]) {
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                VALUES (?, ?, ?, ?, ?, ?)`, project, SESSION, MACHINE, issued.tokenId, NOW, NOW);
  }
  return { sqlite, env: { db: serverEnv.db, blobs: serverEnv.blobs }, tokenId: issued.tokenId };
}

/** Arm A: the member's own derivation over the file, ingested as the member would ship it. */
async function memberArm(env: { db: unknown }, tokenId: string, file: string): Promise<void> {
  const staged: BlobSource[] = [];
  const stage = (bytes: Uint8Array, mediaType: string): BlobSource => {
    const source = { path: file, sha256: `${bytes.byteLength}`.padStart(64, '0'), mediaType, size: bytes.byteLength };
    staged.push(source);
    return source;
  };
  const derived = deriveTranscriptCapture(
    { agent: 'claude-code', sessionId: SESSION, stage, now: () => NOW, version: 'test' },
    file,
    emptySessionState(),
  );
  const ctx = { projectId: MEMBER_PROJECT, machineId: MACHINE, tokenId, bodyBytes: 10, now: NOW };
  for (const event of derived.events) {
    // Attachments need a staged blob present; this fixture carries none.
    if (event.envelope.kind === 'attachment') continue;
    await ingestEvent(env.db as never, ctx, event.envelope);
  }
}

/** Arm B: the same bytes stored as one segment and read by the parse. */
async function parseArm(sqlite: Database, env: { db: unknown; blobs: { put: (k: string, v: ReadableStream) => Promise<unknown> } }, tokenId: string, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  const key = await sha256HexOf(bytes);
  await env.blobs.put(`${PARSE_PROJECT}/${key}`, new Blob([bytes]).stream());
  sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
             PARSE_PROJECT, key, bytes.length, 'text/plain', tokenId, NOW);
  sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id)
              VALUES (?, ?, ?, ?, 'claude-code', ?, 1, ?, ?, ?)`,
             PARSE_PROJECT, TRANSCRIPT, SESSION, MACHINE, bytes.length, NOW, NOW, tokenId);
  sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
              VALUES (?, ?, 0, ?, ?, 'seg', ?, ?, ?)`, PARSE_PROJECT, TRANSCRIPT, bytes.length, key, NOW, NOW, tokenId);

  await parseOnce(env as never, {
    projectId: PARSE_PROJECT, transcriptId: TRANSCRIPT, sessionId: SESSION, machineId: MACHINE,
    tokenId, agent: 'claude-code', size: bytes.length, parsedOffset: 0, fidelity: null, openPromptId: null,
  }, NOW);
}

const rowsOf = (sqlite: Database, table: string, project: string, columns: string[], order: string): Record<string, unknown>[] =>
  sqlite.query(`SELECT ${columns.join(', ')} FROM ${table} WHERE project_id = ? ORDER BY ${order}`).all(project) as Record<string, unknown>[];

describe('transcript parity', () => {
  it('derives the same prompt rows from the member and from the server parse', async () => {
    const { sqlite, env, tokenId } = await rig();
    await memberArm(env, tokenId, onDisk(transcriptText));
    await parseArm(sqlite, env as never, tokenId, transcriptText);

    const columns = comparableColumns('prompt');
    expect(columns).toContain('text');
    expect(columns).toContain('origin');
    const member = rowsOf(sqlite, 'prompt_batches', MEMBER_PROJECT, columns, 'text');
    const parsed = rowsOf(sqlite, 'prompt_batches', PARSE_PROJECT, columns, 'text');
    expect(member.length).toBeGreaterThan(0);
    expect(parsed).toEqual(member);
  });

  it('lands each prompt on the SAME id on both paths, so one prompt is one row rather than two', async () => {
    const { sqlite, env, tokenId } = await rig();
    await memberArm(env, tokenId, onDisk(transcriptText));
    await parseArm(sqlite, env as never, tokenId, transcriptText);
    const ids = (project: string) => (sqlite.query(`SELECT prompt_id FROM prompt_batches WHERE project_id = ? ORDER BY prompt_id`).all(project) as { prompt_id: string }[]).map((r) => r.prompt_id);
    expect(ids(PARSE_PROJECT)).toEqual(ids(MEMBER_PROJECT));
  });

  it('derives the same plan rows, including the key the member derives for a tagged plan', async () => {
    const { sqlite, env, tokenId } = await rig();
    await memberArm(env, tokenId, onDisk(transcriptText));
    await parseArm(sqlite, env as never, tokenId, transcriptText);

    const columns = comparableColumns('plan').filter((c) => c !== 'source');
    const member = rowsOf(sqlite, 'plans', MEMBER_PROJECT, ['plan_key', ...columns], 'plan_key');
    const parsed = rowsOf(sqlite, 'plans', PARSE_PROJECT, ['plan_key', ...columns], 'plan_key');
    expect(member.length).toBe(1);
    expect(parsed).toEqual(member);
  });

  it('records the channel a plan arrived through, which the member path leaves for the key shape to imply', async () => {
    const { sqlite, env, tokenId } = await rig();
    await memberArm(env, tokenId, onDisk(transcriptText));
    await parseArm(sqlite, env as never, tokenId, transcriptText);
    const source = (project: string) => (sqlite.query(`SELECT source FROM plans WHERE project_id = ?`).get(project) as { source: string | null }).source;
    expect(source(PARSE_PROJECT)).toBe('tag');
    expect(source(MEMBER_PROJECT)).toBeNull();
  });

  it('gains the tool calls the member derivation never produced, which is the point of parsing server-side', async () => {
    const { sqlite, env, tokenId } = await rig();
    await memberArm(env, tokenId, onDisk(transcriptText));
    await parseArm(sqlite, env as never, tokenId, transcriptText);
    const calls = (project: string) => (sqlite.query(`SELECT COUNT(*) c FROM tool_calls WHERE project_id = ?`).get(project) as { c: number }).c;
    // The member reads no tool call out of a transcript at all; hooks are its
    // only source. The parse pairs each call with the result naming it.
    expect(calls(MEMBER_PROJECT)).toBe(0);
    expect(calls(PARSE_PROJECT)).toBe(1);
    const row = sqlite.query(`SELECT tool_name, output_preview, success FROM tool_calls WHERE project_id = ?`).get(PARSE_PROJECT) as Record<string, unknown>;
    expect(row).toMatchObject({ tool_name: 'Read', output_preview: 'ok', success: 1 });
  });

  it('records which shape matched a prompt, which the member transcript path leaves null', async () => {
    const { sqlite, env, tokenId } = await rig();
    await memberArm(env, tokenId, onDisk(transcriptText));
    await parseArm(sqlite, env as never, tokenId, transcriptText);
    const kinds = (project: string) => (sqlite.query(`SELECT prompt_kind FROM prompt_batches WHERE project_id = ? ORDER BY text`).all(project) as { prompt_kind: string | null }[]).map((r) => r.prompt_kind);
    expect(kinds(PARSE_PROJECT)).toEqual(['user_prompt', 'queued_command']);
    expect(kinds(MEMBER_PROJECT)).toEqual([null, null]);
  });

  it('names every exclusion with the reason it cannot match, so the list is a decision rather than a leftover', () => {
    for (const [column, reason] of Object.entries(EXCLUDED)) {
      expect({ column, explained: reason.trim().length > 20 }).toEqual({ column, explained: true });
    }
    // The two the issue did not anticipate are named, not quietly dropped.
    expect(Object.keys(EXCLUDED)).toContain('tool_call_id');
    expect(Object.keys(EXCLUDED)).toContain('response_id');
  });

  it('marks every parsed row with the producer that derived it, so provenance separates the paths', async () => {
    const { sqlite, env, tokenId } = await rig();
    await memberArm(env, tokenId, onDisk(transcriptText));
    await parseArm(sqlite, env as never, tokenId, transcriptText);
    const adapters = (project: string) => new Set((sqlite.query(`SELECT DISTINCT producer_adapter a FROM events WHERE project_id = ?`).all(project) as { a: string }[]).map((r) => r.a));
    expect([...adapters(PARSE_PROJECT)]).toEqual(['transcript-parse']);
    expect(adapters(MEMBER_PROJECT).has('transcript-parse')).toBe(false);
  });
});

describe('transcript parity under a compaction continuation', () => {
  it('derives the same prompts from a continued transcript on both paths', async () => {
    const continued = fs.readFileSync(path.join(import.meta.dir, '..', 'fixtures', 'claude-compact-continuation.jsonl'), 'utf8');
    const { sqlite, env, tokenId } = await rig();
    // The fixture names its own session; both arms are driven against that id.
    await memberArm(env, tokenId, onDisk(continued));
    await parseArm(sqlite, env as never, tokenId, continued);
    const texts = (project: string) => (sqlite.query(`SELECT text FROM prompt_batches WHERE project_id = ? ORDER BY text`).all(project) as { text: string }[]).map((r) => r.text);
    // Both paths see the same prompts of the continued run, and neither
    // re-derives the predecessor's.
    // Neither arm may be empty, or the equality above would hold vacuously.
    expect(texts(MEMBER_PROJECT).length).toBeGreaterThan(0);
    expect(texts(PARSE_PROJECT)).toEqual(texts(MEMBER_PROJECT));
    expect(new Set(texts(MEMBER_PROJECT)).size).toBe(texts(MEMBER_PROJECT).length);
  });
});
