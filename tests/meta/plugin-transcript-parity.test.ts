/**
 * One row per fact for the agents whose transcript Myco's own plugin writes.
 *
 * The hazard these gates exist for is not a lost row but a doubled one, and it
 * is invisible in the projections. A member hook mints a random event id while
 * the parse derives a deterministic one, so the two never meet on the raw
 * insert; the projection key collapses them and the second write shows up only
 * as a `projection_conflict` and an extra `events` row. Counting projected rows
 * alone would pass while every turn was written twice.
 *
 * So the prompt hook ships no `prompt` for these agents — the transcript is the
 * only writer, and the id it carries is the one the hook minted and returned.
 * These tests hold that end to end: raw rows, projected rows, and the absence
 * of the conflict signal another lane's duplicate detector reads.
 *
 * Cross-package: the member's hook config and the server's parsers both load
 * here, which is why this lives in `tests/meta/`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { parseOnce } from '@myco-server-worker/ingest/parse.js';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sha256Hex as sha256HexOf } from '@myco-server-worker/hash.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';
import { deriveTranscriptCapture } from '@myco/member/transcript.js';
import { emptySessionState } from '@myco/member/session-state.js';
import type { Database } from 'bun:sqlite';

const MACHINE = 'mach_1';
const PROJECT = 'proj_1';
const SESSION = 'ses_plugin_1';
const TRANSCRIPT = 'tx_0123456789abcdef0123456789abcdef';
const NOW = Date.parse('2027-01-01T00:00:00Z');

/** The id the member's hook minted and handed back for the plugin to stamp. */
const MINTED_PROMPT = '01932bd0-0000-7000-8000-00000000ab01';

/** One turn as the plugin writes it: the session record first, then the turn. */
const TRANSCRIPT_TEXT = [
  { v: 1, type: 'session', sessionId: SESSION, agent: 'opencode', cwd: '/Users/fixture/repo', at: '2026-09-08T12:00:00.000Z' },
  { v: 1, type: 'prompt', sessionId: SESSION, promptId: MINTED_PROMPT, text: 'add a retry', origin: 'human', at: '2026-09-08T12:00:01.000Z' },
  { v: 1, type: 'tool', sessionId: SESSION, promptId: MINTED_PROMPT, name: 'read', input: { filePath: 'src/a.ts' }, output: 'ok', failed: false, at: '2026-09-08T12:00:02.000Z' },
  { v: 1, type: 'response', sessionId: SESSION, promptId: MINTED_PROMPT, text: 'Added a bounded retry.', at: '2026-09-08T12:00:03.000Z' },
].map((line) => JSON.stringify(line)).join('\n') + '\n';

async function rig() {
  const { sqlite, serverEnv } = sqliteEnv();
  const issued = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: MACHINE }, NOW);
  sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
              VALUES (?, ?, ?, ?, ?, ?)`, PROJECT, SESSION, MACHINE, issued.tokenId, NOW, NOW);
  return { sqlite, env: { db: serverEnv.db, blobs: serverEnv.blobs }, tokenId: issued.tokenId };
}

/** Store the bytes as one segment and run the parse over them, as a shipped transcript would be. */
async function parseArm(sqlite: Database, env: { db: unknown; blobs: { put: (k: string, v: ReadableStream) => Promise<unknown> } }, tokenId: string, agent: string, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  const key = await sha256HexOf(bytes);
  await env.blobs.put(`${PROJECT}/${key}`, new Blob([bytes]).stream());
  sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
             PROJECT, key, bytes.length, 'text/plain', tokenId, NOW);
  sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id)
              VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
             PROJECT, TRANSCRIPT, SESSION, MACHINE, agent, bytes.length, NOW, NOW, tokenId);
  sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
              VALUES (?, ?, 0, ?, ?, 'seg', ?, ?, ?)`, PROJECT, TRANSCRIPT, bytes.length, key, NOW, NOW, tokenId);

  await parseOnce(env as never, {
    projectId: PROJECT, transcriptId: TRANSCRIPT, sessionId: SESSION, machineId: MACHINE,
    tokenId, agent, size: bytes.length, parsedOffset: 0, fidelity: null, openPromptId: null,
  }, NOW);
}

const count = (sqlite: Database, table: string): number =>
  (sqlite.query(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(PROJECT) as { n: number }).n;

describe('native plugin transcripts land one row per fact', () => {
  it('writes one prompt row under the id the member minted, not a derived one', async () => {
    const { sqlite, env, tokenId } = await rig();
    await parseArm(sqlite, env as never, tokenId, 'opencode', TRANSCRIPT_TEXT);

    const prompts = sqlite.query(`SELECT prompt_id FROM prompt_batches WHERE project_id = ?`).all(PROJECT) as { prompt_id: string }[];
    expect(prompts.map((p) => p.prompt_id)).toEqual([MINTED_PROMPT]);
  });

  /**
   * The gate for the doubling. One raw `events` row per derived fact and no
   * more: a member that also shipped the prompt would add a second row here
   * while `prompt_batches` still held one, which is exactly the shape that
   * hid the defect on the agents whose hooks still ship.
   */
  it('writes one events row per fact and raises no projection conflict', async () => {
    const { sqlite, env, tokenId } = await rig();
    await parseArm(sqlite, env as never, tokenId, 'opencode', TRANSCRIPT_TEXT);

    expect(count(sqlite, 'events')).toBe(3);
    expect(count(sqlite, 'prompt_batches')).toBe(1);
    expect(count(sqlite, 'responses')).toBe(1);
    expect(count(sqlite, 'tool_calls')).toBe(1);
  });

  it('re-parsing the same bytes changes nothing, so a resumed pass cannot double a turn', async () => {
    const { sqlite, env, tokenId } = await rig();
    await parseArm(sqlite, env as never, tokenId, 'opencode', TRANSCRIPT_TEXT);
    const before = count(sqlite, 'events');
    sqlite.run(`UPDATE transcripts SET parsed_offset = 0 WHERE project_id = ?`, PROJECT);
    await parseOnce(env as never, {
      projectId: PROJECT, transcriptId: TRANSCRIPT, sessionId: SESSION, machineId: MACHINE,
      tokenId, agent: 'opencode', size: new TextEncoder().encode(TRANSCRIPT_TEXT).length,
      parsedOffset: 0, fidelity: null, openPromptId: null,
    }, NOW);
    expect(count(sqlite, 'events')).toBe(before);
    expect(count(sqlite, 'prompt_batches')).toBe(1);
  });
});

describe('the member is not a second writer for these agents', () => {
  /**
   * Read through the capability the hook itself reads. A manifest that lost
   * the declaration would put the member back to shipping prompts, and the
   * only symptom would be the doubling this file exists to prevent.
   */
  it('declares the transcript as the turn-row source for every plugin-written agent', () => {
    for (const agent of ['opencode', 'pi', 'cline']) {
      expect({ agent, source: HOOK_CONFIG[agent]?.capabilities.turnRowSource }).toEqual({ agent, source: 'transcript' });
    }
  });

  /**
   * The member's own transcript derivation must find nothing in these files.
   * It is gated twice over — these agents declare no `capturePrompts`, and the
   * adapter registry holds no adapter for them — and the outcome is asserted
   * here rather than resting on either citation.
   */
  it('derives no events from a plugin-written transcript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plugin-parity-'));
    const file = path.join(dir, `${SESSION}.jsonl`);
    fs.writeFileSync(file, TRANSCRIPT_TEXT);
    for (const agent of ['opencode', 'pi', 'cline']) {
      const derived = deriveTranscriptCapture(
        { agent, sessionId: SESSION, stage: () => { throw new Error('nothing should stage'); }, now: () => NOW, version: 'test' },
        file,
        emptySessionState(),
      );
      expect({ agent, events: derived.events.length }).toEqual({ agent, events: 0 });
    }
  });

  it('registers a parser for every agent that declares the transcript as its turn-row source', () => {
    const declared = Object.entries(HOOK_CONFIG)
      .filter(([, entry]) => entry.capabilities.turnRowSource === 'transcript')
      .map(([agent]) => agent)
      .sort();
    expect(declared.filter((agent) => PARSERS[agent] === undefined)).toEqual([]);
  });
});
