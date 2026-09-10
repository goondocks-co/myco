/**
 * The retained hooks of every tier-1 harness, driven with stdin fixtures
 * through the in-process worker.
 *
 * For an agent the Deployment parses, the hooks register the session, inject,
 * ship the transcript delta and the plan files the turn wrote, and end the
 * session — and write no turn row: the prompts, replies and tool calls land
 * when the Deployment's parse reads the bytes the hooks shipped. The member
 * kinds on the wire are session.start, transcript.segment, plan and
 * session.end; Cursor adds tool.use and tool.failure, which its transcript
 * cannot carry. No retired daemon route is ever dialled.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';
import { evaluateUserPromptRules, resolveSubagentThread } from '@myco/hooks/capture-rules.js';
import { deriveId, mintId, planKeyForPromptTag, promptEvent, type EnvelopeContext } from '@myco/member/envelope.js';
import { MemberSpool } from '@myco/member/spool.js';
import { TRANSCRIPT_HEAD_HASH_BYTES } from '@myco/member/constants.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { resolveWorktreeRoot } from '@myco/project-root.js';
import { readSessionState } from '@myco/member/session-state.js';
import { parseTranscripts } from '@myco-server-worker/ingest/parse.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { registerTestMember, recordingFetch, runHook } from './helpers/hooks.js';

let mycoHome: string;
let rig: MemberRig;
let fetchSpy: ReturnType<typeof recordingFetch>;
const savedHome = process.env.MYCO_HOME;

beforeEach(async () => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  resetMachineIdCache();
  rig = await memberRig();
  registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt });
  fetchSpy = recordingFetch(rig.fetch);
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  resetMachineIdCache();
});

/** 1.4 wire paths no hook may dial; a path under one of these is the same violation. */
const RETIRED = ['/sessions/register', '/sessions/unregister', '/events/stop', '/events/sync-transcript-prompts', '/context/subagent', '/context/resume', '/canopy/inject', '/api/sessions'];
/** 1.4's session-start composition, matched exactly: `/context/prompt` and `/context/session` beside it are the live recall routes. */
const RETIRED_EXACT = ['/context'];
const dialled = () => fetchSpy.requests.map((r) => r.path);
const assertNoRetired = () => {
  for (const p of dialled()) {
    for (const r of RETIRED) expect(p.startsWith(r)).toBe(false);
    for (const r of RETIRED_EXACT) expect(p).not.toBe(r);
  }
};
const session = 'sess-hooks-1';
const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures');
const transcript = (lines: unknown[], id = session): string => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-tx-')), `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
};
const run = (name: Parameters<typeof runHook>[0], raw: Record<string, unknown>, argv?: string[], symbiont?: string) =>
  runHook(name, { session_id: session, hook_event_name: raw.hook_event_name ?? undefined, ...raw }, { fetch: fetchSpy.fetch, argv, symbiont });

/** The Deployment's parse over every transcript the hooks shipped, run to completion as the tick would. */
async function parseAll(): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) {
    if ((await parseTranscripts(rig.env.serverEnv, Date.now())) === 0) return;
  }
}
/** Kinds on the member's side of the wire, in arrival order. */
const memberKinds = () => (rig.env.sqlite.query(`SELECT kind FROM events WHERE producer_adapter <> 'transcript-parse' ORDER BY received_at, rowid`).all() as Array<{ kind: string }>).map((r) => r.kind);
const texts = (table: string, column = 'text') => (rig.env.sqlite.query(`SELECT ${column} AS v FROM ${table} ORDER BY v`).all() as Array<{ v: string }>).map((r) => r.v);

describe('member hooks through the worker: claude-code, transcript-first', () => {
  it('registers, injects, ships the delta and ends the session; the parse writes the turns; no retired route is dialled', async () => {
    const tx = transcript([
      { type: 'user', cwd: '/work/repo', promptId: 'p1', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/work/repo/a.ts' } }] } },
      { type: 'user', uuid: 'r1', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents' }] } },
      { type: 'assistant', uuid: 'a2', timestamp: '2026-01-01T00:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text: 'The answer.' }], stop_reason: 'end_turn' } },
    ]);
    await run('session-start', { hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' });
    expect(rig.rows('sessions')).toBe(1);

    const ups = await run('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', transcript_path: tx, prompt: 'hello' });
    expect(ups.stdout).toContain(`Session:: \`${session}\``);
    // Injection only: no prompt row, nothing spooled, no receipt for a row the parse owns.
    expect(rig.rows('prompt_batches')).toBe(0);
    expect(readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, session).promptId).toBeUndefined();
    await run('subagent-start', { hook_event_name: 'SubagentStart', transcript_path: tx, agent_id: 'a1', agent_type: 'Explore' });

    await run('stop', { hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: 'The answer.' });
    expect(rig.rows('transcript_segments')).toBe(1);
    expect(rig.rows('responses')).toBe(0);
    await parseAll();
    expect(texts('prompt_batches')).toEqual(['hello']);
    expect(texts('responses')).toEqual(['The answer.']);
    expect(rig.rows('tool_calls')).toBe(1);
    expect(rig.rows('prompt_batches')).toBe(1);

    await run('session-end', { hook_event_name: 'SessionEnd', transcript_path: tx });
    const sessionRow = rig.env.sqlite.query('SELECT origin_path, ended_at FROM sessions WHERE session_id = ?').get(session) as { origin_path: string; ended_at: number | null };
    expect(sessionRow.origin_path).toBe('/work/repo');
    expect(sessionRow.ended_at).toBeGreaterThan(0);

    expect(memberKinds()).toEqual(['session.start', 'transcript.segment', 'session.end']);
    assertNoRetired();
    expect(new Set(dialled())).toEqual(new Set(['/events', '/context/prompt', '/context/session', ...dialled().filter((p) => p.startsWith('/blobs/'))]));
    expect(new MemberSpool('proj_1', { mycoHome }).sessionIds()).toEqual([]);
  });

  it('a session-start drop rule and a user-prompt drop rule emit nothing and dial nothing', async () => {
    const tx = transcript([{ type: 'user', entrypoint: 'sdk-py', message: { role: 'user', content: 'x' } }]);
    const ss = await run('session-start', { transcript_path: tx });
    expect(ss.stderr).toContain('session-start: dropped');
    expect(dialled()).toEqual([]);
    expect(rig.rows('events')).toBe(0);
    const tx2 = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    const ups = await run('user-prompt-submit', { transcript_path: tx2, prompt: '<local-command-stdout>ls</local-command-stdout>' });
    expect(ups.stderr).toContain('user-prompt-submit: dropped');
    expect(ups.stdout).toContain('Session::');
    expect(dialled()).toEqual([]);
    expect(rig.rows('events')).toBe(0);
  });

  it('pre-tool-use writes the empty response and dials nothing', async () => {
    const r = await run('pre-tool-use', { tool_name: 'Read', tool_input: { file_path: '/x' } });
    expect(r.stdout).toBe('');
    expect(dialled()).toEqual([]);
    expect(new MemberSpool('proj_1', { mycoHome }).sessionIds()).toEqual([]);
  });

  it('Stop ships the delta and derives nothing itself: the parse writes the typed prompt, the queued command, the plan tag and the reply; a grown transcript ships its tail at the held offset', async () => {
    const tx = transcript([
      { type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'typed prompt' }] } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Here is a plan <ultraplan>\n# Plan A\n\nstep one\n</ultraplan> done' }], stop_reason: 'end_turn' } },
      { type: 'attachment', uuid: 'q1', timestamp: '2026-01-01T00:00:02Z', attachment: { type: 'queued_command', prompt: 'queued steer' } },
      { type: 'assistant', uuid: 'a2', timestamp: '2026-01-01T00:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text: 'final words' }], stop_reason: 'end_turn' } },
    ]);
    await run('session-start', { transcript_path: tx, cwd: '/work/repo' });
    await run('user-prompt-submit', { transcript_path: tx, prompt: 'typed prompt' });
    await run('stop', { transcript_path: tx, last_assistant_message: '' });
    expect(memberKinds()).toEqual(['session.start', 'transcript.segment']);
    await parseAll();
    expect(texts('prompt_batches')).toEqual(['queued steer', 'typed prompt']);
    expect(rig.env.sqlite.query('SELECT title, content FROM plans').get()).toEqual({ title: 'Plan A', content: '# Plan A\n\nstep one' });
    expect(texts('responses')).toEqual(['Here is a plan <ultraplan>\n# Plan A\n\nstep one\n</ultraplan> done', 'final words']);
    const segment = rig.env.sqlite.query('SELECT base_offset, length FROM transcript_segments').get() as { base_offset: number; length: number };
    expect(segment).toEqual({ base_offset: 0, length: fs.statSync(tx).size });
    // A second Stop on an unchanged transcript emits nothing new and ships nothing.
    const before = rig.rows('events');
    await run('stop', { transcript_path: tx, last_assistant_message: '' });
    expect(rig.rows('events')).toBe(before);
    // A transcript that grows ships only the tail, at the server's held offset.
    fs.appendFileSync(tx, JSON.stringify({ type: 'user', uuid: 'u9', promptId: 'p9', message: { role: 'user', content: 'later' } }) + '\n');
    await run('stop', { transcript_path: tx, last_assistant_message: 'ok' });
    const segments = rig.env.sqlite.query('SELECT base_offset, length FROM transcript_segments ORDER BY base_offset').all() as Array<{ base_offset: number; length: number }>;
    expect(segments).toHaveLength(2);
    expect(segments[1].base_offset).toBe(segments[0].length);
    expect(segments[0].length + segments[1].length).toBe(fs.statSync(tx).size);
    await parseAll();
    expect(texts('prompt_batches')).toEqual(['later', 'queued steer', 'typed prompt']);
    assertNoRetired();
  });

  it('a hook under an unknown symbiont takes its default budget, records nothing, and never dials', async () => {
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    const pre = await runHook('pre-tool-use', { session_id: session, hook_event_name: 'PreToolUse', transcript_path: tx, tool_name: 'Read', tool_input: { file_path: '/x' } }, { fetch: fetchSpy.fetch, symbiont: 'not-a-symbiont' });
    expect(pre.stdout).toBe('');
    expect(dialled()).toEqual([]);
    expect(rig.rows('events')).toBe(0);
  });

  it('a prompt carrying sub-agent thread fields projects them — but codex, the only symbiont that declares the paths, drops those prompts first', async () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const parentPromptId = mintId();
    const ctx: EnvelopeContext = { agent: 'codex', sessionId: 'sess-parent-thread', stage: spool.stagerFor('sess-parent-thread'), version: '2.0.0-test' };
    await rig.postEvent(promptEvent(ctx, { promptId: parentPromptId, text: 'parent asks' }).envelope);
    const childCtx: EnvelopeContext = { ...ctx, sessionId: 'sess-child-thread', stage: spool.stagerFor('sess-child-thread') };
    await rig.postEvent(promptEvent(childCtx, { promptId: mintId(), text: 'child works', parentPromptId, threadId: deriveId('thread', 'thr_child'), threadLabel: 'Explorer' }).envelope);
    const row = rig.env.sqlite.query('SELECT parent_prompt_id, thread_id, thread_label FROM prompt_batches WHERE text = ?').get('child works') as { parent_prompt_id: string; thread_id: string; thread_label: string };
    expect(row).toEqual({ parent_prompt_id: parentPromptId, thread_id: deriveId('thread', 'thr_child'), thread_label: 'Explorer' });

    const declaring = Object.entries(HOOK_CONFIG).filter(([, entry]) => entry.subagentParentPath !== undefined).map(([name]) => name);
    expect(declaring).not.toEqual([]);
    for (const agent of declaring) {
      const meta = { source: { subagent: { thread_spawn: { parent_thread_id: 'sess-parent-thread', agent_nickname: 'Explorer' } } } };
      expect({ agent, thread: resolveSubagentThread(agent, meta)?.parentSessionId }).toEqual({ agent, thread: 'sess-parent-thread' });
      expect({ agent, action: evaluateUserPromptRules(agent, { prompt: 'child works', transcriptMeta: meta }).action }).toEqual({ agent, action: 'drop' });
    }
  });

  it('captures a plan file from the write the transcript records, re-sends an edit made outside the turn at the next Stop, and keeps a status set on the Deployment', async () => {
    // The hook resolves its credential for the process's own project root, so the plan file sits in this checkout's plan directory for the test's duration.
    const root = resolveWorktreeRoot(process.cwd()) ?? resolveMemberProjectRoot(process.cwd());
    const file = path.join(root, '.claude/plans', `feature-${session}-${process.pid}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cleanup = () => { try { fs.unlinkSync(file); } catch {} };
    try {
      const lines = [
        { type: 'user', uuid: 'u1', promptId: 'p1', message: { role: 'user', content: 'write the plan' } },
        // An Edit record carries only a diff, so the file is read from disk at Stop.
        { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: file, old_string: '', new_string: '# Feature' } }] } },
        { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } },
      ];
      const tx = transcript(lines);
      await run('session-start', { transcript_path: tx, cwd: root });
      fs.writeFileSync(file, '# Feature\n\n- [ ] step\n');
      await run('stop', { transcript_path: tx, last_assistant_message: 'done', cwd: root });
      const key = deriveId('plan', 'proj_1', `.claude/plans/${path.basename(file)}`);
      const row = () => rig.env.sqlite.query('SELECT plan_key, title, content, status, origin_path, prompt_id FROM plans').get() as Record<string, unknown>;
      // The parse derives the turn's prompt id; the member names none on the file.
      expect(row()).toEqual({ plan_key: key, title: 'Feature', content: '# Feature\n\n- [ ] step\n', status: 'active', origin_path: `.claude/plans/${path.basename(file)}`, prompt_id: null });
      expect(memberKinds()).toEqual(['session.start', 'plan', 'transcript.segment']);
      // The same content again is not re-sent; a status set on the Deployment survives the next write.
      await run('stop', { transcript_path: tx, last_assistant_message: 'done', cwd: root });
      expect(rig.rows('plans')).toBe(1);
      expect(memberKinds().filter((k) => k === 'plan')).toHaveLength(1);
      rig.env.sqlite.run(`UPDATE plans SET status = 'completed' WHERE plan_key = ?`, [key]);
      // An edit outside the hooks lands at Stop through the backstop; a write outside the plan dirs never becomes a plan.
      fs.writeFileSync(file, '# Feature\n\n- [x] step\n- [ ] more\n');
      const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-notes-')), 'notes.md');
      fs.writeFileSync(elsewhere, '# Not a plan');
      fs.appendFileSync(tx, JSON.stringify({ type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: elsewhere, content: '# Not a plan' } }] } }) + '\n');
      await run('stop', { transcript_path: tx, last_assistant_message: 'done', cwd: root });
      expect(row()).toMatchObject({ content: '# Feature\n\n- [x] step\n- [ ] more\n', status: 'completed' });
      expect(rig.rows('plans')).toBe(1);
    } finally { cleanup(); }
  });

  it('captures a plan a person pasted in a tag envelope, keyed by the prompt so it never meets a key the parse derives, and never one a runtime injected', async () => {
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    await run('session-start', { transcript_path: tx, cwd: '/work/repo' });
    await run('user-prompt-submit', { transcript_path: tx, prompt: 'Approved:\n<ultraplan>\n# Pasted\n\n- [ ] do it\n</ultraplan>' });
    // The id the hook minted travels on the recall request; the plan is keyed by it.
    const asked = JSON.parse(fetchSpy.requests.find((r) => r.path === '/context/prompt')!.body!) as { promptId: string };
    const row = rig.env.sqlite.query('SELECT plan_key, title, content, status, origin_path, prompt_id FROM plans').get() as Record<string, unknown>;
    expect(row).toEqual({ plan_key: planKeyForPromptTag(session, 'ultraplan', asked.promptId), title: 'Pasted', content: '# Pasted\n\n- [ ] do it', status: 'active', origin_path: 'transcript:ultraplan', prompt_id: null });
    expect(rig.rows('prompt_batches')).toBe(0);
    await run('user-prompt-submit', { transcript_path: tx, prompt: '<system-reminder>quoting <ultraplan>\n# Quoted\n</ultraplan></system-reminder>' });
    // The same plan pasted again is one plan.
    await run('user-prompt-submit', { transcript_path: tx, prompt: 'Again:\n<ultraplan>\n# Pasted\n\n- [ ] do it\n</ultraplan>' });
    expect(rig.rows('plans')).toBe(1);
    expect(memberKinds()).toEqual(['session.start', 'plan']);
  });

  it('ships the subagent transcripts beside the session under their own identity and role, and the parse reads them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-sub-'));
    const tx = path.join(dir, `${session}.jsonl`);
    fs.writeFileSync(tx, JSON.stringify({ type: 'user', uuid: 'u1', promptId: 'p1', message: { role: 'user', content: 'delegate' } }) + '\n');
    const sibling = path.join(dir, session, 'subagents', 'agent-abc.jsonl');
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, fs.readFileSync(path.join(FIXTURES, 'claude-parse-subagent.jsonl')));
    await run('session-start', { transcript_path: tx, cwd: '/work/repo' });
    await run('stop', { transcript_path: tx, last_assistant_message: '' });
    const transcripts = rig.env.sqlite.query('SELECT role, origin_path, size FROM transcripts ORDER BY role').all() as Array<{ role: string; origin_path: string; size: number }>;
    expect(transcripts.map((t) => t.role)).toEqual(['primary', 'subagent']);
    expect(transcripts[1].size).toBe(fs.statSync(sibling).size);
    const state = readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, session);
    expect(Object.keys(state.siblings)).toEqual([sibling]);
    expect(state.siblings[sibling].nextOffset).toBe(fs.statSync(sibling).size);
    await parseAll();
    expect(texts('prompt_batches')).toContain('search the codebase for the retention leaf');
    // Nothing new to ship on a second Stop.
    const before = rig.rows('events');
    await run('stop', { transcript_path: tx, last_assistant_message: '' });
    expect(rig.rows('events')).toBe(before);
  });

  it('mints the identity over the head of the file and ships a transcript replaced in place as a transcript of its own', async () => {
    const padding = 'x'.repeat(TRANSCRIPT_HEAD_HASH_BYTES);
    const tx = transcript([{ type: 'user', uuid: 'u1', promptId: 'p1', message: { role: 'user', content: `first ${padding}` } }]);
    await run('session-start', { transcript_path: tx, cwd: '/work/repo' });
    await run('stop', { transcript_path: tx, last_assistant_message: '' });
    const held = rig.env.sqlite.query('SELECT transcript_id, head_hash, size FROM transcripts').all() as Array<{ transcript_id: string; head_hash: string | null; size: number }>;
    expect(held).toHaveLength(1);
    expect(held[0].head_hash).toMatch(/^[0-9a-f]{64}$/);
    // Truncated and rewritten under the same path and inode: the head differs.
    fs.writeFileSync(tx, JSON.stringify({ type: 'user', uuid: 'u2', promptId: 'p2', message: { role: 'user', content: `second ${padding}` } }) + '\n');
    const out = await run('stop', { transcript_path: tx, last_assistant_message: '' });
    expect(out.stderr).toContain('was replaced under its path');
    const after = rig.env.sqlite.query('SELECT transcript_id, head_hash, size FROM transcripts ORDER BY first_received_at, transcript_id').all() as Array<{ transcript_id: string; head_hash: string; size: number }>;
    expect(after).toHaveLength(2);
    expect(after.map((t) => t.transcript_id)).toContain(held[0].transcript_id);
    const fresh = after.find((t) => t.transcript_id !== held[0].transcript_id)!;
    expect(fresh.head_hash).not.toBe(held[0].head_hash);
    expect(fresh.size).toBe(fs.statSync(tx).size);
    expect(readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, session).transcript?.transcriptId).toBe(fresh.transcript_id);
    expect(new MemberSpool('proj_1', { mycoHome }).readRefused()).toEqual([]);
  });

  it('restores the session block once per compaction from the start the harness fires after compacting', async () => {
    rig.env.sqlite.query(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`).run(Date.now());
    rig.env.sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('instructions.template', ?, ?, 'test')`).run(JSON.stringify('Keep the plan current.'), Date.now());
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    expect((await run('session-start', { transcript_path: tx, cwd: '/work/repo', source: 'startup' })).stdout).toContain('Keep the plan current.');
    expect((await run('session-start', { transcript_path: tx, cwd: '/work/repo', source: 'compact' })).stdout).toContain('Keep the plan current.');
    expect((await run('session-start', { transcript_path: tx, cwd: '/work/repo', source: 'compact' })).stdout).toContain('Keep the plan current.');
    expect(readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, session).delivered).toEqual(['cortex', 'cortex-compact:1', 'cortex-compact:2']);
    expect((await run('session-start', { transcript_path: tx, cwd: '/work/repo', source: 'resume' })).stdout).toBe('');
    expect(memberKinds().every((k) => k === 'session.start')).toBe(true);
  });
});

describe('member hooks through the worker: codex', () => {
  it('registers, injects and ships the rollout; the parse writes the prompt, the tool call and the reply', async () => {
    const tx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-codex-')), `rollout-2026-09-01T10-00-00-${session}.jsonl`);
    fs.copyFileSync(path.join(FIXTURES, 'codex-parse-basic.jsonl'), tx);
    await run('session-start', { hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/repo' }, undefined, 'codex');
    const ups = await run('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', transcript_path: tx, prompt: 'summarise the ingest path', cwd: '/repo' }, undefined, 'codex');
    expect(ups.stdout).toContain(`Session:: \`${session}\``);
    await run('stop', { hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: 'done', cwd: '/repo' }, undefined, 'codex');
    expect(memberKinds()).toEqual(['session.start', 'transcript.segment']);
    await parseAll();
    expect(texts('prompt_batches')).toEqual(['summarise the ingest path']);
    expect(rig.rows('tool_calls')).toBe(1);
    expect(rig.rows('responses')).toBe(1);
    expect((rig.env.sqlite.query('SELECT agent FROM sessions').get() as { agent: string }).agent).toBe('codex');
    assertNoRetired();
  });
});

describe('member hooks through the worker: cursor', () => {
  it('ships the tool calls its transcript cannot carry, and the delta the parse reads for prompts and replies', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-cursor-'));
    const tx = path.join(dir, 'agent-transcripts', session, `${session}.jsonl`);
    fs.mkdirSync(path.dirname(tx), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'cursor-parse-basic.jsonl'), tx);
    const cursor = (name: Parameters<typeof runHook>[0], raw: Record<string, unknown>) =>
      runHook(name, { conversation_id: session, transcript_path: tx, cwd: '/repo', ...raw }, { fetch: fetchSpy.fetch, symbiont: 'cursor' });
    await cursor('session-start', { hook_event_name: 'sessionStart' });
    await cursor('post-tool-use', { hook_event_name: 'postToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/a.ts' }, tool_output: 'contents' });
    await cursor('post-tool-use-failure', { hook_event_name: 'postToolUseFailure', tool_name: 'Shell', tool_input: { command: 'false' }, error: 'exit 1' });
    expect(rig.rows('tool_calls')).toBe(2);
    // No prompt hook ran, and the parse derives its own prompt ids, so the calls name no turn.
    expect((rig.env.sqlite.query('SELECT prompt_id FROM tool_calls').all() as Array<{ prompt_id: string | null }>).every((r) => r.prompt_id === null)).toBe(true);
    await cursor('stop', { hook_event_name: 'stop', last_assistant_message: 'The lease expired.' });
    expect(rig.rows('responses')).toBe(0);
    await parseAll();
    expect(texts('prompt_batches')).toEqual(['why is the daemon restarting']);
    expect(texts('responses')).toEqual(['The lease expired.']);
    await cursor('session-end', { hook_event_name: 'sessionEnd' });
    expect(memberKinds()).toEqual(['session.start', 'tool.use', 'tool.failure', 'transcript.segment', 'session.end']);
    assertNoRetired();
  });
});

describe('member hooks through the worker: hook-source agents', () => {
  it('post-tool-use with no tool name is dropped: a non-tool step records nothing and dials nothing', async () => {
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    const r = await run('post-tool-use', { hook_event_name: 'PostToolUse', transcript_path: tx, tool_input: { file_path: '/x' }, tool_output: 'body' });
    expect(r.stderr).toContain('post-tool-use dropped (no tool_name)');
    expect(dialled()).toEqual([]);
    expect(rig.rows('tool_calls')).toBe(0);
    expect(new MemberSpool('proj_1', { mycoHome }).sessionIds()).toEqual([]);
  });

  it('windsurf --phases: the response phase emits only the response, the transcript phase only the transcript work', async () => {
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    const raw = { trajectory_id: session, tool_info: { transcript_path: tx, response: 'resp' } };
    await runHook('stop', raw, { fetch: fetchSpy.fetch, symbiont: 'windsurf', argv: ['--phases', 'response'] });
    expect(rig.rows('responses')).toBe(1);
    expect(rig.rows('transcript_segments')).toBe(0);
    await runHook('stop', raw, { fetch: fetchSpy.fetch, symbiont: 'windsurf', argv: ['--phases', 'transcript'] });
    expect(rig.rows('responses')).toBe(1);
    expect(rig.rows('transcript_segments')).toBe(1);
  });

  it('copilot, which the Deployment does not parse, still ships its turn rows from the hooks', async () => {
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    const copilot = (name: Parameters<typeof runHook>[0], raw: Record<string, unknown>) =>
      runHook(name, { session_id: session, transcript_path: tx, cwd: '/repo', ...raw }, { fetch: fetchSpy.fetch, symbiont: 'copilot' });
    await copilot('session-start', { hook_event_name: 'SessionStart' });
    await copilot('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
    await copilot('post-tool-use', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/a.ts' }, tool_response: 'contents' });
    await copilot('stop', { hook_event_name: 'Stop', last_assistant_message: 'The answer.' });
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(rig.rows('tool_calls')).toBe(1);
    expect(rig.rows('responses')).toBe(1);
    const promptId = (rig.env.sqlite.query('SELECT prompt_id FROM prompt_batches').get() as { prompt_id: string }).prompt_id;
    expect((rig.env.sqlite.query('SELECT prompt_id FROM tool_calls').get() as { prompt_id: string }).prompt_id).toBe(promptId);
  });
});
