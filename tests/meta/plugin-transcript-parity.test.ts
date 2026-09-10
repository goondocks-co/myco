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

import { parseOnce } from '@myco-server-worker/ingest/parse.js';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sha256Hex as sha256HexOf } from '@myco-server-worker/hash.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';
import { deriveTranscriptCapture } from '@myco/member/transcript.js';
import { emptySessionState } from '@myco/member/session-state.js';
import { runHook, type HookName } from '../member/helpers/hooks.js';
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

describe('the hook path itself, end to end', () => {
  /**
   * The gates above read a hand-written transcript, which proves the parse but
   * not the hook that feeds it. This drives the real `user-prompt-submit`
   * through the same runner a harness invokes, for a transcript-carrying agent
   * and for one whose hooks still ship, and reads what each left on the spool.
   *
   * The contrast is the gate: a capability that stopped being read would show
   * up as the two agents behaving alike, which no single-agent assertion sees.
   */
  const runFor = async (symbiont: string, verb: HookName = 'user-prompt-submit'): Promise<{ stdout: string; posted: string[] }> => {
    const held = { ...process.env };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hookarm-'));
    Object.assign(process.env, {
      MYCO_SERVER_URL: 'https://example.invalid',
      MYCO_MEMBER_TOKEN: 'A'.repeat(43),
      MYCO_PROJECT: PROJECT,
      MYCO_HOME: home,
    });
    try {
      const posted: string[] = [];
      const fetchImpl = (async (url: string, init?: { body?: string }) => {
        if (String(url).endsWith('/events') && typeof init?.body === 'string') {
          posted.push((JSON.parse(init.body) as { kind: string }).kind);
        }
        return new Response(JSON.stringify({ persisted: true }), { status: 200 });
      }) as never;
      // A transcript path is present in every real invocation, and Codex's
      // own manifest drops a prompt that arrives without one.
      const transcript = path.join(home, 'transcript.jsonl');
      fs.writeFileSync(transcript, '');
      const { stdout } = await runHook(
        verb,
        {
          session_id: SESSION, prompt: 'add a retry', transcript_path: transcript, cwd: home,
          // What each turn-row hook needs to have something to write.
          tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_response: 'ok',
          last_assistant_message: 'done', agent_id: 'sub_1', agent_type: 'general',
        },
        { fetch: fetchImpl, symbiont, credential: 'env' },
      );
      return { stdout, posted };
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in held)) delete process.env[key];
      Object.assign(process.env, held);
    }
  };

  it('returns a prompt id and writes no prompt for a transcript-carrying agent', async () => {
    const { stdout, posted } = await runFor('opencode');
    expect(typeof (JSON.parse(stdout || '{}') as { promptId?: string }).promptId).toBe('string');
    expect(posted).toEqual([]);
  });

  it('writes the prompt for an agent whose hooks still carry its turn rows', async () => {
    const { posted } = await runFor('copilot');
    expect(posted).toContain('prompt');
  });

  it('writes no prompt, response or tool call from the hooks of an agent the Deployment parses', async () => {
    for (const agent of ['claude-code', 'codex']) {
      for (const verb of ['user-prompt-submit', 'stop', 'post-tool-use', 'subagent-start'] as const) {
        const { posted } = await runFor(agent, verb);
        expect({ agent, verb, posted: posted.filter((k) => ['prompt', 'response', 'tool.use', 'subagent.start'].includes(k)) }).toEqual({ agent, verb, posted: [] });
      }
    }
  });

  /**
   * Every hook that writes a turn row, not just the prompt one. The gate is
   * the whole set: `stop`, `post-tool-use` and `subagent-start` each key a row
   * to the id the prompt hook minted, so one of them left ungated puts the
   * turn back on two writers with only the conflict signal to show for it.
   */
  it('posts nothing from any turn-row hook for a transcript-carrying agent', async () => {
    for (const verb of ['user-prompt-submit', 'stop', 'post-tool-use', 'subagent-start'] as const) {
      const { posted } = await runFor('opencode', verb);
      expect({ verb, posted }).toEqual({ verb, posted: [] });
    }
  });

  it('posts a row from those same hooks for an agent whose hooks still carry them', async () => {
    // The contrast: without it, a capability that stopped being read anywhere
    // would look identical to one being read everywhere.
    const seen: string[] = [];
    for (const verb of ['user-prompt-submit', 'stop', 'post-tool-use'] as const) {
      seen.push(...(await runFor('copilot', verb)).posted);
    }
    expect(seen.length).toBeGreaterThan(2);
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
