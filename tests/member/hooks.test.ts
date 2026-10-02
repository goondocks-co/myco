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
import { MEMBER_SESSION_STATE_RETENTION_MS, TRANSCRIPT_HEAD_HASH_BYTES } from '@myco/member/constants.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { sessionStatePath, updateSessionState } from '@myco/member/session-state.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { resolveWorktreeRoot } from '@myco/project-root.js';
import { readSessionState } from '@myco/member/session-state.js';
import { parseTranscripts } from '@myco-server-worker/ingest/parse.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { registerTestMember, recordingFetch, runHook } from './helpers/hooks.js';
import { FEATURES_HEADER, TURN_END_HEADER } from '@goondocks/myco-shared/member-protocol';
import { run as runMemberCli } from '@myco/cli/member.js';
import { runHelperVerb } from '@myco/cli/member-helper.js';
import { TAIL_IDLE_MS } from '@myco/member/backlog.js';
import { readRefusedHook, REFUSED_HOOK_RETENTION_MS } from '@myco/member/refused-hooks.js';
import { refusedHookChecks } from '@myco/cli/member-doctor.js';

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
  runHook(name, { session_id: session, hook_event_name: raw.hook_event_name ?? undefined, ...raw }, { helpers: 'run', fetch: fetchSpy.fetch, argv, symbiont });

/** The Deployment's parse over every transcript the hooks shipped, run to completion as the tick would. */
async function parseAll(): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) {
    if ((await parseTranscripts(rig.env.serverEnv, Date.now())).changed === 0) return;
  }
}
/** Kinds on the member's side of the wire, in arrival order; a turn's start and end are asserted on their own. */
const memberKinds = () => (rig.env.sqlite.query(`SELECT kind FROM events WHERE producer_adapter <> 'transcript-parse' AND kind <> 'turn' ORDER BY received_at, rowid`).all() as Array<{ kind: string }>).map((r) => r.kind);
/** Captured rows the Deployment holds: every member event but a turn's start or end, which each hook adds. */
const captured = () => (rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE kind <> 'turn'`).get() as { n: number }).n;
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
    const before = captured();
    await run('stop', { transcript_path: tx, last_assistant_message: '' });
    expect(captured()).toBe(before);
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
    const pre = await runHook('pre-tool-use', { session_id: session, hook_event_name: 'PreToolUse', transcript_path: tx, tool_name: 'Read', tool_input: { file_path: '/x' } }, { helpers: 'run', fetch: fetchSpy.fetch, symbiont: 'not-a-symbiont' });
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
    const before = captured();
    await run('stop', { transcript_path: tx, last_assistant_message: '' });
    expect(captured()).toBe(before);
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
    expect(new MemberSpool('proj_1', { mycoHome }).readRefused().entries).toEqual([]);
  });

  it('restores the session block once per compaction from the start the harness fires after compacting', async () => {
    rig.env.sqlite.query(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`).run(Date.now());
    rig.env.sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('instructions.template', ?, ?, 'test')`).run(JSON.stringify('Keep the plan current.'), Date.now());
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    // A first start on this machine has nothing cached but its Project line: the helper it kicks fetches the block for
    // the next.
    const prime = await runHook('session-start', { session_id: 'sess-prime', transcript_path: tx, cwd: '/work/repo', source: 'startup' }, { helpers: 'run', fetch: fetchSpy.fetch });
    expect(prime.stdout).toContain('Project:: `proj_1`');
    expect(prime.stdout).not.toContain('Keep the plan current.');
    expect((await run('session-start', { transcript_path: tx, cwd: '/work/repo', source: 'startup' })).stdout).toContain('Keep the plan current.');
    expect((await run('session-start', { transcript_path: tx, cwd: '/work/repo', source: 'compact' })).stdout).toContain('Keep the plan current.');
    expect((await run('session-start', { transcript_path: tx, cwd: '/work/repo', source: 'compact' })).stdout).toContain('Keep the plan current.');
    expect(readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, session).delivered).toEqual(['cortex', 'cortex-compact:1', 'cortex-compact:2']);
    expect((await run('session-start', { transcript_path: tx, cwd: '/work/repo', source: 'resume' })).stdout).toBe('');
    expect(memberKinds().every((k) => k === 'session.start')).toBe(true);
  });
});

describe('member hooks through the worker: the turn-end mark', () => {
  /** Every transcript segment posted, with its session and whether it carried the turn-end mark. */
  const segmentPosts = () => fetchSpy.requests
    .filter((r) => r.path === '/events' && r.body !== undefined)
    .map((r) => ({ envelope: JSON.parse(r.body!) as { kind: string; sessionId: string }, marked: r.headers[TURN_END_HEADER] === '1' }))
    .filter((p) => p.envelope.kind === 'transcript.segment')
    .map((p) => `${p.envelope.sessionId} ${p.marked ? 'marked' : 'unmarked'}`);
  const offline: typeof rig.fetch = async () => { throw new TypeError('fetch failed'); };
  const line = (text: string) => ({ type: 'user', uuid: `u-${text}`, message: { role: 'user', content: text } });

  /** When the Deployment holds each segment as created: the time a turn end rides on. */
  const segmentStamps = (sessionId: string) => fetchSpy.requests
    .filter((r) => r.path === '/events' && r.body !== undefined)
    .map((r) => JSON.parse(r.body!) as { kind: string; sessionId: string; createdAt: number })
    .filter((e) => e.kind === 'transcript.segment' && e.sessionId === sessionId)
    .map((e) => e.createdAt);
  const turnEnds = (sessionId: string) => (rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND kind = 'turn'`).get(sessionId) as { n: number }).n;

  it('tells a Deployment of a turn end when it happened: a mark rides the segment that reaches it, stamped with the turn\'s end, until the Deployment advertises turn events', async () => {
    // Offline from the start: nothing is known of the Deployment's features, so the Stop leaves a mark.
    const txA = transcript([line('a')], 'sess-a');
    await runHook('session-start', { session_id: 'sess-a', hook_event_name: 'SessionStart', transcript_path: txA, cwd: '/work/repo' }, { helpers: 'run', fetch: offline });
    // The turn ended an hour ago, by the hook's clock.
    const stoppedAt = Date.now() - 3_600_000;
    await runHook('stop', { session_id: 'sess-a', hook_event_name: 'Stop', transcript_path: txA, last_assistant_message: 'x' }, { helpers: 'run', fetch: offline, now: () => stoppedAt });
    const spool = new MemberSpool('proj_1', { mycoHome });
    expect(spool.pendingTurnEnds('sess-a').map((p) => p.mark.atSize)).toEqual([fs.statSync(txA).size]);

    // Back online. Session b's start runs the helper, which ships session a's segment: it reaches the mark and carries
    // the turn's own end, not the time it shipped.
    const txB = transcript([line('b')], 'sess-b');
    await runHook('session-start', { session_id: 'sess-b', hook_event_name: 'SessionStart', transcript_path: txB, cwd: '/work/repo' }, { helpers: 'run', fetch: fetchSpy.fetch });
    expect(segmentPosts()).toEqual(['sess-a marked']);
    expect(segmentStamps('sess-a')).toEqual([stoppedAt]);
    expect(spool.pendingTurnEnds('sess-a')).toEqual([]);

    // The Deployment's answers advertised `turn`: session b's Stop is a turn event, and its segment carries no mark.
    await runHook('stop', { session_id: 'sess-b', hook_event_name: 'Stop', transcript_path: txB, last_assistant_message: 'x' }, { helpers: 'run', fetch: fetchSpy.fetch });
    expect(turnEnds('sess-b')).toBe(1);
    expect(segmentPosts().filter((p) => p.startsWith('sess-b'))).toEqual(['sess-b unmarked']);
    expect(spool.pendingTurnEnds('sess-b')).toEqual([]);
  });
});

describe('member hooks through the worker: turn ends told by the transcript alone', () => {
  it('ends a segment at every mark, each stamped with its own turn, ignores a mark naming another transcript, and holds the turn under way, a mark written mid-ship included, until its end', async () => {
    // A Deployment from before `turn`: no answer of its names a feature, so every turn end is a mark.
    const stripped: typeof rig.fetch = async (input, init) => {
      const res = await fetchSpy.fetch(input, init);
      const headers = new Headers(res.headers);
      headers.delete(FEATURES_HEADER);
      return new Response(await res.text(), { status: res.status, headers });
    };
    let midShip: (() => void) | null = null;
    const fetch: typeof rig.fetch = async (input, init) => {
      const req = new Request(input, init);
      if (midShip !== null && new URL(req.url).pathname.startsWith('/blobs/')) { const act = midShip; midShip = null; act(); }
      return stripped(req);
    };
    const id = 'sess-marks';
    const line = (text: string) => `${JSON.stringify({ type: 'user', uuid: `u-${text}`, message: { role: 'user', content: text } })}\n`;
    const tx = transcript([], id);
    fs.writeFileSync(tx, line('one'));
    const hook = (name: Parameters<typeof runHook>[0], raw: Record<string, unknown>, now?: () => number, helpers: 'run' | 'record' = 'record') =>
      runHook(name, { session_id: id, transcript_path: tx, cwd: '/work/repo', ...raw }, { helpers, fetch, now });
    await hook('session-start', {}, undefined, 'run');
    const spool = new MemberSpool('proj_1', { mycoHome });
    // Two turns end before any helper runs: two marks a few bytes apart, inside what one segment would carry.
    const t1 = Date.now() - 60_000;
    await hook('stop', { last_assistant_message: 'x' }, () => t1);
    const x1 = fs.statSync(tx).size;
    fs.appendFileSync(tx, line('two'));
    const t2 = Date.now() - 30_000;
    await hook('stop', { last_assistant_message: 'y' }, () => t2);
    const x2 = fs.statSync(tx).size;
    // A mark naming a transcript this session no longer points at says nothing of this one's bytes.
    spool.appendTurnEnd(id, { slot: 'primary', transcriptId: 'tx-elsewhere', atSize: 3 }, undefined, Date.now());
    // The third turn is under way; its Stop lands while the helper is shipping.
    fs.appendFileSync(tx, line('three'));
    const t3 = Date.now() - 10_000;
    let x3 = 0;
    midShip = () => {
      fs.appendFileSync(tx, line('three, done'));
      x3 = fs.statSync(tx).size;
      const transcriptId = readSessionState(spool.dir, id).transcript!.transcriptId;
      spool.appendTurnEnd(id, { slot: 'primary', transcriptId, atSize: x3 }, undefined, t3);
    };
    await hook('user-prompt-submit', { prompt: 'p' }, undefined, 'run');
    const segments = () => fetchSpy.requests
      .filter((r) => r.path === '/events' && r.body !== undefined)
      .map((r) => ({ e: JSON.parse(r.body!) as { kind: string; sessionId: string; createdAt: number; payload: { baseOffset: number; length: number } }, marked: r.headers[TURN_END_HEADER] === '1' }))
      .filter(({ e }) => e.kind === 'transcript.segment' && e.sessionId === id)
      .map(({ e, marked }) => ({ end: e.payload.baseOffset + e.payload.length, marked, at: marked ? e.createdAt : undefined }));
    // One segment per turn, each ending at its mark with its turn's end; nothing of the turn under way.
    expect(segments()).toEqual([{ end: x1, marked: true, at: t1 }, { end: x2, marked: true, at: t2 }]);
    // The mark written mid-ship waits for the pass after; the others are spent.
    expect(spool.pendingTurnEnds(id).map((p) => p.mark.atSize)).toEqual([x3]);

    await hook('user-prompt-submit', { prompt: 'q' }, undefined, 'run');
    expect(segments().slice(2)).toEqual([{ end: x3, marked: true, at: t3 }]);
    expect(spool.pendingTurnEnds(id)).toEqual([]);

    // The session ends: what its transcript holds past the last turn ships, a turn's end no longer.
    fs.appendFileSync(tx, line('after'));
    await hook('session-end', {}, undefined, 'run');
    expect(segments().slice(3)).toEqual([{ end: fs.statSync(tx).size, marked: false, at: undefined }]);
  });
});

describe('member hooks through the worker: a session its harness left without its end', () => {
  it('holds what the transcript holds past the last turn\'s end until the session has gone 15 minutes without a hook, then ships it', async () => {
    const fetch: typeof rig.fetch = async (input, init) => {
      const res = await fetchSpy.fetch(input, init);
      const headers = new Headers(res.headers);
      headers.delete(FEATURES_HEADER);
      return new Response(await res.text(), { status: res.status, headers });
    };
    const id = 'sess-killed';
    const line = (text: string) => `${JSON.stringify({ type: 'user', uuid: `u-${text}`, message: { role: 'user', content: text } })}\n`;
    const tx = transcript([], id);
    fs.writeFileSync(tx, line('one'));
    const t0 = Date.now();
    const hook = (name: Parameters<typeof runHook>[0], raw: Record<string, unknown>) =>
      runHook(name, { session_id: id, transcript_path: tx, cwd: '/work/repo', ...raw }, { helpers: 'record', fetch, now: () => t0 });
    await hook('session-start', {});
    await hook('stop', { last_assistant_message: 'x' });
    const ended = fs.statSync(tx).size;
    // The next turn was under way when the harness was killed: no Stop, no SessionEnd.
    fs.appendFileSync(tx, line('two, never finished'));
    const pass = (at: number) => runHelperVerb(['--project', 'proj_1', '--home', mycoHome], { fetch, now: () => at, lingerMs: 0, keepStderr: true });
    const ends = () => fetchSpy.requests
      .filter((r) => r.path === '/events' && r.body !== undefined)
      .map((r) => JSON.parse(r.body!) as { kind: string; sessionId: string; payload: { baseOffset: number; length: number } })
      .filter((e) => e.kind === 'transcript.segment' && e.sessionId === id)
      .map((e) => e.payload.baseOffset + e.payload.length);

    await pass(t0 + TAIL_IDLE_MS - 1_000);
    expect(ends()).toEqual([ended]);
    await pass(t0 + TAIL_IDLE_MS + 1_000);
    expect(ends()).toEqual([ended, fs.statSync(tx).size]);
  });
});

describe('member hooks through the worker: a session resumed after its end', () => {
  it('is live again: the end it recorded is cleared by its next hook', async () => {
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }], 'sess-resumed');
    const hook = (name: Parameters<typeof runHook>[0], raw: Record<string, unknown> = {}) =>
      runHook(name, { session_id: 'sess-resumed', transcript_path: tx, cwd: '/work/repo', ...raw }, { helpers: 'record', fetch: fetchSpy.fetch });
    const spool = new MemberSpool('proj_1', { mycoHome });
    await hook('session-start');
    await hook('session-end');
    expect(readSessionState(spool.dir, 'sess-resumed').endedAt).toBeNumber();
    await hook('session-start', { source: 'resume' });
    expect(readSessionState(spool.dir, 'sess-resumed').endedAt).toBeUndefined();
  });
});

describe('member hooks through the worker: retention and plan files', () => {
  it('prunes the state of a session delivered long ago only after a drain that ran and delivered everything; a drain another process holds the lease for delivers nothing', async () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const old = 'sess-delivered-long-ago';
    const past = Date.now() - MEMBER_SESSION_STATE_RETENTION_MS - 86_400_000;
    updateSessionState(spool.dir, old, (state) => { state.delivered.push('cortex'); }, past);
    expect(fs.existsSync(sessionStatePath(spool.dir, old))).toBe(true);
    const tx = transcript([{ type: 'user', uuid: 'u1', promptId: 'p1', message: { role: 'user', content: 'x' } }]);
    // Another process holds this session's drain lease: the helper's drain is skipped, and skipped is not delivered.
    const lease = LifecycleLock.acquire(path.join(spool.dir, `.${session}.drain.lock`), { command: 'test' });
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) throw new Error('the test session drain lease was not acquired');
    try {
      await run('session-start', { transcript_path: tx, cwd: '/work/repo' });
      expect(fs.existsSync(sessionStatePath(spool.dir, old))).toBe(true);
      await run('stop', { transcript_path: tx, last_assistant_message: '' });
      expect(fs.existsSync(sessionStatePath(spool.dir, old))).toBe(true);
    } finally {
      lease.lock.release();
    }
    await run('stop', { transcript_path: tx, last_assistant_message: '' });
    expect(fs.existsSync(sessionStatePath(spool.dir, old))).toBe(false);
  });

  it('captures a plan file a subagent wrote, from the subagent transcript beside the session', async () => {
    const root = resolveWorktreeRoot(process.cwd()) ?? resolveMemberProjectRoot(process.cwd());
    const file = path.join(root, '.claude/plans', `sub-${session}-${process.pid}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-subplan-'));
      const tx = path.join(dir, `${session}.jsonl`);
      fs.writeFileSync(tx, JSON.stringify({ type: 'user', uuid: 'u1', promptId: 'p1', message: { role: 'user', content: 'delegate the plan' } }) + '\n');
      const sibling = path.join(dir, session, 'subagents', 'agent-plan.jsonl');
      fs.mkdirSync(path.dirname(sibling), { recursive: true });
      fs.writeFileSync(sibling, JSON.stringify({ type: 'assistant', uuid: 'sa1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: file, content: '# Delegated' } }] } }) + '\n');
      fs.writeFileSync(file, '# Delegated\n\n- [ ] by a subagent\n');
      await run('session-start', { transcript_path: tx, cwd: root });
      await run('stop', { transcript_path: tx, last_assistant_message: '', cwd: root });
      expect(rig.env.sqlite.query('SELECT title, content FROM plans').get()).toEqual({ title: 'Delegated', content: '# Delegated\n\n- [ ] by a subagent\n' });
      const state = readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, session);
      expect(state.siblings[sibling].parsedSize).toBe(fs.statSync(sibling).size);
      // A second Stop reads neither transcript again and ships no second plan.
      const before = captured();
      await run('stop', { transcript_path: tx, last_assistant_message: '', cwd: root });
      expect(captured()).toBe(before);
    } finally { try { fs.unlinkSync(file); } catch {} }
  });

  it('says so when a plan file the turn wrote cannot be read at Stop, and reads a record torn across two reads whole', async () => {
    const root = resolveWorktreeRoot(process.cwd()) ?? resolveMemberProjectRoot(process.cwd());
    const gone = path.join(root, '.claude/plans', `gone-${session}-${process.pid}.md`);
    const line = JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: gone, content: '# Gone' } }] } }) + '\n';
    const tx = transcript([{ type: 'user', uuid: 'u1', promptId: 'p1', message: { role: 'user', content: 'write then delete' } }]);
    await run('session-start', { transcript_path: tx, cwd: root });
    // The record is half written when Stop fires: the member holds the read at the last complete line.
    fs.appendFileSync(tx, line.slice(0, 40));
    await run('stop', { transcript_path: tx, last_assistant_message: '', cwd: root });
    const spool = new MemberSpool('proj_1', { mycoHome });
    expect(readSessionState(spool.dir, session).transcript?.parsedSize).toBe(fs.statSync(tx).size - 40);
    fs.appendFileSync(tx, line.slice(40));
    const out = await run('stop', { transcript_path: tx, last_assistant_message: '', cwd: root });
    expect(out.stderr).toContain(`plan file .claude/plans/${path.basename(gone)} was written this turn but cannot be read now`);
    expect(rig.rows('plans')).toBe(0);
    expect(readSessionState(spool.dir, session).transcript?.parsedSize).toBe(fs.statSync(tx).size);
  });
});

describe('member hooks through the worker: codex', () => {
  it('registers, injects, ships its tool calls from the hook and the rollout as the delta; the parse writes the prompt and the reply', async () => {
    const tx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-codex-')), `rollout-2026-09-01T10-00-00-${session}.jsonl`);
    fs.copyFileSync(path.join(FIXTURES, 'codex-parse-basic.jsonl'), tx);
    await run('session-start', { hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/repo' }, undefined, 'codex');
    const ups = await run('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', transcript_path: tx, prompt: 'summarise the ingest path', cwd: '/repo' }, undefined, 'codex');
    expect(ups.stdout).toContain(`Session:: \`${session}\``);
    // Codex 0.153 records tool calls in shapes the parser does not read yet, so the hook ships them.
    await run('post-tool-use', { hook_event_name: 'PostToolUse', transcript_path: tx, tool_name: 'shell', tool_input: { command: 'ls' }, tool_response: 'a.ts', cwd: '/repo' }, undefined, 'codex');
    expect(rig.rows('tool_calls')).toBe(1);
    await run('stop', { hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: 'done', cwd: '/repo' }, undefined, 'codex');
    expect(memberKinds()).toEqual(['session.start', 'tool.use', 'transcript.segment']);
    await parseAll();
    expect(texts('prompt_batches')).toEqual(['summarise the ingest path']);
    expect(rig.rows('responses')).toBe(1);
    // The fixture's `function_call` is the shape the parser reads; it is a second call beside the hook's, not the same row.
    expect((rig.env.sqlite.query(`SELECT producer_adapter a FROM events WHERE kind = 'tool.use' ORDER BY a`).all() as { a: string }[]).map((r) => r.a)).toEqual(['codex', 'transcript-parse']);
    expect((rig.env.sqlite.query('SELECT agent FROM sessions').get() as { agent: string }).agent).toBe('codex');
    assertNoRetired();
  });
});

describe('member hooks through the worker: cursor', () => {
  it('ships the tool calls its transcript cannot carry, and the delta the parse reads for prompts and replies', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-cursor-'));
    const tx = path.join(dir, 'agent-transcripts', session, `${session}.jsonl`);
    fs.mkdirSync(path.dirname(tx), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'cursor-agent-2026.09-redacted.jsonl'), tx);
    const cursor = (name: Parameters<typeof runHook>[0], raw: Record<string, unknown>) =>
      runHook(name, { conversation_id: session, transcript_path: tx, cwd: '/repo', ...raw }, { helpers: 'run', fetch: fetchSpy.fetch, symbiont: 'cursor' });
    await cursor('session-start', { hook_event_name: 'sessionStart' });
    await cursor('post-tool-use', { hook_event_name: 'postToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/a.ts' }, tool_output: 'contents' });
    await cursor('post-tool-use-failure', { hook_event_name: 'postToolUseFailure', tool_name: 'Shell', tool_input: { command: 'false' }, error: 'exit 1' });
    expect(rig.rows('tool_calls')).toBe(2);
    // No prompt hook ran, and the parse derives its own prompt ids, so the calls name no turn.
    expect((rig.env.sqlite.query('SELECT prompt_id FROM tool_calls').all() as Array<{ prompt_id: string | null }>).every((r) => r.prompt_id === null)).toBe(true);
    await cursor('stop', { hook_event_name: 'stop', last_assistant_message: 'Nothing was modified.' });
    expect(rig.rows('responses')).toBe(0);
    await parseAll();
    expect(texts('prompt_batches')).toEqual(['List the files in this directory and say how many there are. Do not modify anything.']);
    expect(texts('responses')).toHaveLength(1);
    expect(texts('responses')[0]).toEndWith('Nothing was modified.');
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
    await runHook('stop', raw, { helpers: 'run', fetch: fetchSpy.fetch, symbiont: 'windsurf', argv: ['--phases', 'response'] });
    expect(rig.rows('responses')).toBe(1);
    expect(rig.rows('transcript_segments')).toBe(0);
    await runHook('stop', raw, { helpers: 'run', fetch: fetchSpy.fetch, symbiont: 'windsurf', argv: ['--phases', 'transcript'] });
    expect(rig.rows('responses')).toBe(1);
    expect(rig.rows('transcript_segments')).toBe(1);
  });

  it('copilot, which the Deployment does not parse, still ships its turn rows from the hooks', async () => {
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    const copilot = (name: Parameters<typeof runHook>[0], raw: Record<string, unknown>) =>
      runHook(name, { session_id: session, transcript_path: tx, cwd: '/repo', ...raw }, { helpers: 'run', fetch: fetchSpy.fetch, symbiont: 'copilot' });
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

describe('a hook command that names no harness, or no credential source (#1561)', () => {
  const status = async (): Promise<string[]> => {
    const lines: string[] = [];
    await runMemberCli(['status'], { mycoHome, fetch: rig.fetch, stdout: (l) => lines.push(l), stderr: () => {} });
    return lines.filter((l) => l.startsWith('refused hook:'));
  };

  it('captures nothing, says why, and is counted where status and doctor show it', async () => {
    expect({ status: await status(), doctor: refusedHookChecks(mycoHome, Date.now()) }).toEqual({ status: [], doctor: [] });
    const cases: Array<[string, string | null]> = [['no --symbiont', null], ['a harness no manifest knows', 'no-such-harness']];
    for (const [what, symbiont] of cases) {
      const out = await runHook('session-start', { session_id: `sess-unnamed-${String(symbiont)}`, hook_event_name: 'SessionStart', cwd: process.cwd() }, { helpers: 'run', fetch: fetchSpy.fetch, symbiont });
      expect({ what, refused: out.stderr.includes('hook command must declare --symbiont <harness>'), spooled: new MemberSpool('proj_1', { mycoHome }).stateSessionIds() })
        .toEqual({ what, refused: true, spooled: [] });
    }
    expect(dialled()).toEqual([]);
    expect(await status()).toEqual(['refused hook: 2 hook invocation(s) on this machine named no harness Myco knows (`--symbiont <harness>`), so captured nothing']);
    expect(refusedHookChecks(mycoHome, Date.now()).map((c) => [c.name, c.status, c.detail.includes('2 hook invocation(s) on this machine named no harness')])).toEqual([['Capture', 'warn', true]]);
  });

  it('counts a hook that declares no credential source the same way', async () => {
    const out = await runHook('session-start', { session_id: 'sess-no-credential', hook_event_name: 'SessionStart', cwd: process.cwd() }, { helpers: 'run', fetch: fetchSpy.fetch, credential: null });
    expect(out.stderr).toContain('hook command must declare --credential registry|env');
    expect(await status()).toEqual(['refused hook: 1 hook invocation(s) on this machine declared no credential source (`--credential registry|env`), so captured nothing']);
    expect(refusedHookChecks(mycoHome, Date.now())).toHaveLength(1);
  });

  it('stops being reported once a month passes with no new refusal', async () => {
    await runHook('session-start', { session_id: 'sess-old', hook_event_name: 'SessionStart', cwd: process.cwd() }, { helpers: 'run', fetch: fetchSpy.fetch, symbiont: null });
    expect(readRefusedHook('no-harness', mycoHome, Date.now())?.count).toBe(1);
    expect(readRefusedHook('no-harness', mycoHome, Date.now() + REFUSED_HOOK_RETENTION_MS + 1)).toBeNull();
    expect(await status()).toEqual([]);
  });
});
