/**
 * Every hook's `main()` driven with stdin fixtures through the in-process
 * worker: the envelope lands `persisted:true` with its projected row; a drop
 * rule emits nothing; UserPromptSubmit keeps the `Session::` line; no retired
 * daemon route is ever dialled; PreToolUse answers the empty response and
 * never dials; Stop carries the response, the transcript-derived prompts,
 * plans, images, and the transcript segments.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';
import { evaluateUserPromptRules, resolveSubagentThread } from '@myco/hooks/capture-rules.js';
import { deriveId, mintId, promptEvent, type EnvelopeContext } from '@myco/member/envelope.js';
import { MemberSpool } from '@myco/member/spool.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { resolveWorktreeRoot } from '@myco/project-root.js';
import { readSessionState } from '@myco/member/session-state.js';
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

const RETIRED = ['/sessions/register', '/sessions/unregister', '/events/stop', '/events/sync-transcript-prompts', '/context', '/context/prompt', '/context/subagent', '/canopy/inject', '/api/sessions'];
const dialled = () => fetchSpy.requests.map((r) => r.path);
const assertNoRetired = () => { for (const p of dialled()) for (const r of RETIRED) expect(p.startsWith(r)).toBe(false); };
const session = 'sess-hooks-1';
const transcript = (lines: unknown[]): string => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-tx-')), `${session}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
};
const run = (name: Parameters<typeof runHook>[0], raw: Record<string, unknown>, argv?: string[]) =>
  runHook(name, { session_id: session, hook_event_name: raw.hook_event_name ?? undefined, ...raw }, { fetch: fetchSpy.fetch, argv });

describe('member hooks through the worker', () => {
  it('runs the whole session in hook order and projects every kind; no retired route is dialled', async () => {
    const tx = transcript([{ type: 'user', cwd: '/work/repo', message: { role: 'user', content: 'hello' }, uuid: 'u1', timestamp: '2026-01-01T00:00:00Z' }]);
    await run('session-start', { hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' });
    expect(rig.rows('sessions')).toBe(1);
    const ups = await run('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', transcript_path: tx, prompt: 'hello' });
    expect(ups.stdout).toContain(`Session:: \`${session}\``);
    expect(rig.rows('prompt_batches')).toBe(1);
    const promptId = readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, session).promptId;
    expect(promptId).toBeDefined();
    await run('post-tool-use', { hook_event_name: 'PostToolUse', transcript_path: tx, tool_name: 'Read', tool_input: { file_path: '/work/repo/a.ts' }, tool_output: 'contents' });
    await run('post-tool-use-failure', { hook_event_name: 'PostToolUseFailure', transcript_path: tx, tool_name: 'Bash', tool_input: { command: 'false' }, error: 'exit 1' });
    expect(rig.rows('tool_calls')).toBe(2);
    expect((rig.env.sqlite.query('SELECT prompt_id FROM tool_calls').all() as Array<{ prompt_id: string }>).every((r) => r.prompt_id === promptId)).toBe(true);
    await run('subagent-start', { hook_event_name: 'SubagentStart', transcript_path: tx, agent_id: 'a1', agent_type: 'Explore' });
    await run('subagent-stop', { hook_event_name: 'SubagentStop', transcript_path: tx, agent_id: 'a1', agent_type: 'Explore', last_assistant_message: 'done' });
    await run('pre-compact', { hook_event_name: 'PreCompact', transcript_path: tx, trigger: 'auto' });
    await run('post-compact', { hook_event_name: 'PostCompact', transcript_path: tx, trigger: 'auto', compact_summary: 's' });
    await run('task-completed', { hook_event_name: 'TaskCompleted', transcript_path: tx, task_id: 't', task_subject: 'Ship' });
    await run('stop-failure', { hook_event_name: 'StopFailure', transcript_path: tx, error: 'boom' });
    await run('notification', { transcript_path: tx, message: 'attention', level: 'warn' }, []);
    await run('error-occurred', { transcript_path: tx, message: 'err' }, []);
    await run('stop', { hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: 'The answer.' });
    expect(rig.rows('responses')).toBe(1);
    expect(rig.rows('transcript_segments')).toBe(1);
    await run('session-end', { hook_event_name: 'SessionEnd', transcript_path: tx });
    const sessionRow = rig.env.sqlite.query('SELECT branch, origin_path, ended_at FROM sessions WHERE session_id = ?').get(session) as { origin_path: string; ended_at: number | null };
    expect(sessionRow.origin_path).toBe('/work/repo');
    expect(sessionRow.ended_at).toBeGreaterThan(0);
    const kinds = (rig.env.sqlite.query('SELECT kind FROM events ORDER BY received_at, rowid').all() as Array<{ kind: string }>).map((r) => r.kind);
    expect(new Set(kinds)).toEqual(new Set([
      'session.start', 'prompt', 'tool.use', 'tool.failure', 'subagent.start', 'subagent.stop', 'compaction.pre', 'compaction.post',
      'task.completed', 'stop.failure', 'notification', 'error', 'response', 'transcript.segment', 'session.end',
    ]));
    assertNoRetired();
    expect(new Set(dialled())).toEqual(new Set(['/events', ...dialled().filter((p) => p.startsWith('/blobs/'))]));
    // Every spool file is gone: each hook drained its own events.
    expect(new MemberSpool('proj_1', { mycoHome }).sessionIds()).toEqual([]);
  });

  it('a session-start drop rule and a user-prompt drop rule emit nothing and dial nothing', async () => {
    // Claude Code's `sdk-py` entrypoint drop rule (transcript meta) — session_start.
    const tx = transcript([{ type: 'user', entrypoint: 'sdk-py', message: { role: 'user', content: 'x' } }]);
    const ss = await run('session-start', { transcript_path: tx });
    expect(ss.stderr).toContain('session-start: dropped');
    expect(dialled()).toEqual([]);
    expect(rig.rows('events')).toBe(0);
    // A `<local-command-stdout>` envelope is dropped by the user_prompt rule; no delete is dialled either.
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

  it('Stop mines the transcript: a queued command becomes a derived-id prompt, a plan tag a plan, an image an attachment, and the bytes ship as segments', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64');
    const tx = transcript([
      { type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'typed prompt' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Here is a plan <ultraplan>\n# Plan A\n\nstep one\n</ultraplan> done' }], stop_reason: 'end_turn' } },
      { type: 'attachment', uuid: 'q1', timestamp: '2026-01-01T00:00:02Z', attachment: { type: 'queued_command', prompt: 'queued steer' } },
      { type: 'assistant', uuid: 'a2', timestamp: '2026-01-01T00:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text: 'final words' }], stop_reason: 'end_turn' } },
      // A tag inside a user turn the transcript holds is never a plan: only assistant text is scanned here.
      { type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:04Z', message: { role: 'user', content: [{ type: 'text', text: 'quoting <ultraplan>\n# Not a plan\n</ultraplan>' }] } },
    ]);
    await run('session-start', { transcript_path: tx, cwd: '/work/repo' });
    await run('user-prompt-submit', { transcript_path: tx, prompt: 'typed prompt' });
    await run('stop', { transcript_path: tx, last_assistant_message: '' });
    const kinds = (rig.env.sqlite.query('SELECT kind, COUNT(*) n FROM events GROUP BY kind').all() as Array<{ kind: string; n: number }>);
    const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.n]));
    expect(byKind).toMatchObject({ 'session.start': 1, prompt: 2, plan: 1, attachment: 1, response: 1, 'transcript.segment': 1 });
    const prompts = rig.env.sqlite.query('SELECT text, origin FROM prompt_batches ORDER BY created_at').all() as Array<{ text: string; origin: string }>;
    expect(prompts.map((p) => p.text).sort()).toEqual(['queued steer', 'typed prompt']);
    const plan = rig.env.sqlite.query('SELECT title, content FROM plans').get() as { title: string; content: string };
    expect(plan).toEqual({ title: 'Plan A', content: '# Plan A\n\nstep one' });
    const response = rig.env.sqlite.query('SELECT text FROM responses').get() as { text: string };
    expect(response.text).toBe('final words');
    const segment = rig.env.sqlite.query('SELECT base_offset, length FROM transcript_segments').get() as { base_offset: number; length: number };
    expect(segment).toEqual({ base_offset: 0, length: fs.statSync(tx).size });
    // A second Stop on an unchanged transcript emits nothing new and ships nothing.
    const before = rig.rows('events');
    await run('stop', { transcript_path: tx, last_assistant_message: '' });
    expect(rig.rows('events')).toBe(before);
    // A transcript that grows ships only the tail, at the server's held offset.
    fs.appendFileSync(tx, JSON.stringify({ type: 'user', uuid: 'u9', message: { role: 'user', content: 'later' } }) + '\n');
    await run('stop', { transcript_path: tx, last_assistant_message: 'ok' });
    const segments = rig.env.sqlite.query('SELECT base_offset, length FROM transcript_segments ORDER BY base_offset').all() as Array<{ base_offset: number; length: number }>;
    expect(segments).toHaveLength(2);
    expect(segments[1].base_offset).toBe(segments[0].length);
    expect(segments[0].length + segments[1].length).toBe(fs.statSync(tx).size);
    assertNoRetired();
  });

  it('post-tool-use with no tool name is dropped: a non-tool step records nothing and dials nothing', async () => {
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    const r = await run('post-tool-use', { hook_event_name: 'PostToolUse', transcript_path: tx, tool_input: { file_path: '/x' }, tool_output: 'body' });
    expect(r.stderr).toContain('post-tool-use dropped (no tool_name)');
    expect(dialled()).toEqual([]);
    expect(rig.rows('tool_calls')).toBe(0);
    expect(new MemberSpool('proj_1', { mycoHome }).sessionIds()).toEqual([]);
  });

  it('a hook under an unknown symbiont takes its default budget, records nothing, and never dials', async () => {
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    const pre = await runHook('pre-tool-use', { session_id: session, hook_event_name: 'PreToolUse', transcript_path: tx, tool_name: 'Read', tool_input: { file_path: '/x' } }, { fetch: fetchSpy.fetch, symbiont: 'not-a-symbiont' });
    expect(pre.stdout).toBe('');
    expect(dialled()).toEqual([]);
    expect(rig.rows('events')).toBe(0);
  });

  it('a prompt carrying sub-agent thread fields projects them — but codex, the only symbiont that declares the paths, drops those prompts first', async () => {
    // Half one: the fields the hook would set travel end-to-end.
    const spool = new MemberSpool('proj_1', { mycoHome });
    const parentPromptId = mintId();
    const ctx: EnvelopeContext = { agent: 'codex', sessionId: 'sess-parent-thread', stage: spool.stagerFor('sess-parent-thread'), version: '2.0.0-test' };
    await rig.postEvent(promptEvent(ctx, { promptId: parentPromptId, text: 'parent asks' }).envelope);
    const childCtx: EnvelopeContext = { ...ctx, sessionId: 'sess-child-thread', stage: spool.stagerFor('sess-child-thread') };
    await rig.postEvent(promptEvent(childCtx, { promptId: mintId(), text: 'child works', parentPromptId, threadId: deriveId('thread', 'thr_child'), threadLabel: 'Explorer' }).envelope);
    const row = rig.env.sqlite.query('SELECT parent_prompt_id, thread_id, thread_label FROM prompt_batches WHERE text = ?').get('child works') as { parent_prompt_id: string; thread_id: string; thread_label: string };
    expect(row).toEqual({ parent_prompt_id: parentPromptId, thread_id: deriveId('thread', 'thr_child'), thread_label: 'Explorer' });

    // Half two, and the reason there is no hook-level end-to-end gate: every
    // symbiont that declares `subagentParentPath` also declares a rule that
    // drops a prompt whose transcript meta carries the sub-agent marker the
    // resolution reads, so `resolveSubagentThread` is unreachable from the
    // hook path today. If a manifest ever stops dropping them, this fails and
    // the end-to-end gate becomes both possible and required.
    const declaring = Object.entries(HOOK_CONFIG).filter(([, entry]) => entry.subagentParentPath !== undefined).map(([name]) => name);
    expect(declaring).not.toEqual([]);
    for (const agent of declaring) {
      const meta = { source: { subagent: { thread_spawn: { parent_thread_id: 'sess-parent-thread', agent_nickname: 'Explorer' } } } };
      expect({ agent, thread: resolveSubagentThread(agent, meta)?.parentSessionId }).toEqual({ agent, thread: 'sess-parent-thread' });
      expect({ agent, action: evaluateUserPromptRules(agent, { prompt: 'child works', transcriptMeta: meta }).action }).toEqual({ agent, action: 'drop' });
    }
  });

  it('captures a plan file on the write that lands it, keyed by its path and named after the prompt, keeps its status on a re-write, and re-sends an edit at Stop', async () => {
    // The hook resolves its credential for the process's own project root, so the plan file sits in this checkout's plan directory for the test's duration.
    const root = resolveWorktreeRoot(process.cwd()) ?? resolveMemberProjectRoot(process.cwd());
    const file = path.join(root, '.claude/plans', `feature-${session}-${process.pid}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cleanup = () => { try { fs.unlinkSync(file); } catch {} };
    try {
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    await run('session-start', { transcript_path: tx, cwd: root });
    await run('user-prompt-submit', { transcript_path: tx, prompt: 'write the plan', cwd: root });
    const promptId = readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, session).promptId;
    fs.writeFileSync(file, '# Feature\n\n- [ ] step\n');
    await run('post-tool-use', { tool_name: 'Write', tool_input: { file_path: file }, tool_response: 'ok', cwd: root });
    const key = deriveId('plan', 'proj_1', `.claude/plans/${path.basename(file)}`);
    const row = () => rig.env.sqlite.query('SELECT plan_key, title, content, status, origin_path, prompt_id FROM plans').get() as Record<string, unknown>;
    expect(row()).toEqual({ plan_key: key, title: 'Feature', content: '# Feature\n\n- [ ] step\n', status: 'active', origin_path: `.claude/plans/${path.basename(file)}`, prompt_id: promptId });
    // The same content again is not re-sent; a status set on the Deployment survives the next write.
    await run('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: file }, tool_response: 'ok', cwd: root });
    expect(rig.rows('plans')).toBe(1);
    rig.env.sqlite.run(`UPDATE plans SET status = 'completed' WHERE plan_key = ?`, [key]);
    fs.writeFileSync(file, '# Feature\n\n- [x] step\n');
    await run('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: file }, tool_response: 'ok', cwd: root });
    expect(row()).toMatchObject({ content: '# Feature\n\n- [x] step\n', status: 'completed' });
    // An edit outside the hooks lands at Stop through the backstop; a write outside the plan dirs never becomes a plan.
    fs.writeFileSync(file, '# Feature\n\n- [x] step\n- [ ] more\n');
    await run('stop', { transcript_path: tx, last_assistant_message: 'done', cwd: root });
    expect(row()).toMatchObject({ content: '# Feature\n\n- [x] step\n- [ ] more\n', status: 'completed', prompt_id: promptId });
    const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-notes-')), 'notes.md');
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.writeFileSync(elsewhere, '# Not a plan');
    await run('post-tool-use', { tool_name: 'Write', tool_input: { file_path: elsewhere }, tool_response: 'ok', cwd: root });
    expect(rig.rows('plans')).toBe(1);
    } finally { cleanup(); }
  });

  it('captures a plan a person pasted in a tag envelope with the prompt that carried it, and never one a runtime injected', async () => {
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    await run('session-start', { transcript_path: tx, cwd: '/work/repo' });
    await run('user-prompt-submit', { transcript_path: tx, prompt: 'Approved:\n<ultraplan>\n# Pasted\n\n- [ ] do it\n</ultraplan>' });
    const promptId = readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, session).promptId;
    const row = rig.env.sqlite.query('SELECT title, content, status, origin_path, prompt_id FROM plans').get() as Record<string, unknown>;
    expect(row).toEqual({ title: 'Pasted', content: '# Pasted\n\n- [ ] do it', status: 'active', origin_path: 'transcript:ultraplan', prompt_id: promptId });
    await run('user-prompt-submit', { transcript_path: tx, prompt: '<system-reminder>quoting <ultraplan>\n# Quoted\n</ultraplan></system-reminder>' });
    expect(rig.rows('plans')).toBe(1);
    expect((rig.env.sqlite.query(`SELECT origin FROM prompt_batches ORDER BY created_at`).all() as { origin: string }[]).map((r) => r.origin)).toEqual(['user', 'system']);
  });

  it('windsurf --phases: the response phase emits only the response, the transcript phase only the transcript work', async () => {
    const tx = transcript([{ type: 'user', message: { role: 'user', content: 'x' } }]);
    // Windsurf's own field names: trajectory_id, tool_info.transcript_path, tool_info.response.
    const raw = { trajectory_id: session, tool_info: { transcript_path: tx, response: 'resp' } };
    await runHook('stop', raw, { fetch: fetchSpy.fetch, symbiont: 'windsurf', argv: ['--phases', 'response'] });
    expect(rig.rows('responses')).toBe(1);
    expect(rig.rows('transcript_segments')).toBe(0);
    await runHook('stop', raw, { fetch: fetchSpy.fetch, symbiont: 'windsurf', argv: ['--phases', 'transcript'] });
    expect(rig.rows('responses')).toBe(1);
    expect(rig.rows('transcript_segments')).toBe(1);
  });
});
