/**
 * The commit point. A hook that derives an event also writes the receipt that
 * stops it being derived again — the prompt hash, the plan hash, the
 * attachment key, the transcript's parsed size. If the receipt can be on disk
 * while the event is not, a crash in between is PERMANENT loss: the rerun
 * reads the receipt, derives nothing, and the event exists nowhere. These
 * tests kill the hook exactly there and require the rerun to produce the same
 * capture.
 *
 * The same section proves the hook fails open: a spool that cannot be written
 * still leaves the harness a valid response and a zero exit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { MemberSpool } from '@myco/member/spool.js';
import { readSessionState } from '@myco/member/session-state.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { resolveWorktreeRoot } from '@myco/project-root.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { recordingFetch, registerTestMember, runHook } from './helpers/hooks.js';

let mycoHome: string;
let rig: MemberRig;
let fetchSpy: ReturnType<typeof recordingFetch>;
const savedHome = process.env.MYCO_HOME;
const session = 'sess-durable-1';

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

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64');
const transcript = (): string => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-durable-tx-')), `${session}.jsonl`);
  fs.writeFileSync(file, [
    { type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'typed prompt' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'plan: <ultraplan>\n# Plan A\n\nstep one\n</ultraplan>' }], stop_reason: 'end_turn' } },
    { type: 'attachment', uuid: 'q1', timestamp: '2026-01-01T00:00:02Z', attachment: { type: 'queued_command', prompt: 'queued steer' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
};

const run = (name: Parameters<typeof runHook>[0], raw: Record<string, unknown>, argv?: string[]) =>
  runHook(name, { session_id: session, ...raw }, { fetch: fetchSpy.fetch, argv });

/** Kill the hook at the commit point: `appendAndRecord` is where the events and their receipts land together. */
function crashAtCommit<T>(body: () => Promise<T>): Promise<T> {
  const original = MemberSpool.prototype.appendAndRecord;
  MemberSpool.prototype.appendAndRecord = function crashed(): void { throw new Error('ENOSPC: no space left on device'); };
  return body().finally(() => { MemberSpool.prototype.appendAndRecord = original; });
}

describe('capture is never lost permanently at the commit point', () => {
  it('a plan file write and a pasted plan tag killed at the commit point leave no receipt, and the rerun lands each once', async () => {
    const root = resolveWorktreeRoot(process.cwd()) ?? resolveMemberProjectRoot(process.cwd());
    const file = path.join(root, '.claude/plans', `durable-${session}-${process.pid}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const tx = transcript();
      await run('session-start', { hook_event_name: 'SessionStart', transcript_path: tx, cwd: root });
      await run('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', transcript_path: tx, prompt: 'write it', cwd: root });
      fs.writeFileSync(file, '# Durable\n\n- [ ] one\n');
      const spool = new MemberSpool('proj_1', { mycoHome });
      const crashedWrite = await crashAtCommit(() => run('post-tool-use', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file }, tool_response: 'ok', cwd: root }));
      expect(crashedWrite.stderr).toContain('ENOSPC');
      expect(readSessionState(spool.dir, session).planPaths).toEqual({});
      expect(rig.rows('plans')).toBe(0);
      await run('post-tool-use', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file }, tool_response: 'ok', cwd: root });
      expect(rig.rows('plans')).toBe(1);
      expect(Object.keys(readSessionState(spool.dir, session).planPaths)).toEqual([`.claude/plans/${path.basename(file)}`]);

      const crashedTag = await crashAtCommit(() => run('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', transcript_path: tx, prompt: 'Approved:\n<ultraplan>\n# Pasted\n</ultraplan>', cwd: root }));
      expect(crashedTag.stderr).toContain('ENOSPC');
      const state = readSessionState(spool.dir, session);
      expect([Object.keys(state.planHashes), state.planTagCount]).toEqual([[], 0]);
      await run('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', transcript_path: tx, prompt: 'Approved:\n<ultraplan>\n# Pasted\n</ultraplan>', cwd: root });
      expect(rig.rows('plans')).toBe(2);
      expect(readSessionState(spool.dir, session).planTagCount).toBe(1);
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
  });

  it('a Stop killed after deriving and before appending loses nothing: the rerun derives the same events', async () => {
    const tx = transcript();
    await run('session-start', { hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' });
    const before = rig.rows('events');

    const crashed = await crashAtCommit(() => run('stop', { hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: '' }));

    // Nothing was sent, nothing was spooled — and, the point of the test,
    // nothing was receipted: no prompt hash, no plan hash, no parsed size.
    expect(crashed.stderr).toContain('ENOSPC');
    expect(rig.rows('events')).toBe(before);
    const spool = new MemberSpool('proj_1', { mycoHome });
    expect(spool.sessionIds().filter((id) => id === session)).toEqual([]);
    const state = readSessionState(spool.dir, session);
    expect(Object.keys(state.prompts)).toEqual([]);
    expect(Object.keys(state.planHashes)).toEqual([]);
    expect(state.attachmentKeys).toEqual([]);
    expect(state.transcript?.parsedSize ?? 0).toBe(0);

    // The rerun derives exactly what the killed run would have delivered.
    await run('stop', { hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: '' });
    const byKind = Object.fromEntries((rig.env.sqlite.query('SELECT kind, COUNT(*) n FROM events GROUP BY kind').all() as Array<{ kind: string; n: number }>).map((k) => [k.kind, k.n]));
    // Both transcript-only prompts (no UserPromptSubmit ran here), the plan and the image.
    expect(byKind).toMatchObject({ prompt: 2, plan: 1, attachment: 1 });
    expect((rig.env.sqlite.query('SELECT text FROM prompt_batches ORDER BY text').all() as Array<{ text: string }>).map((p) => p.text)).toEqual(['queued steer', 'typed prompt']);
    expect((rig.env.sqlite.query('SELECT title FROM plans').get() as { title: string }).title).toBe('Plan A');
  });

  it('a UserPromptSubmit killed at the commit point re-captures its prompt on the rerun', async () => {
    const tx = transcript();
    const crashed = await crashAtCommit(() => run('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', transcript_path: tx, prompt: 'typed prompt' }));

    // Fail open: the harness still gets its response and the hook exits 0.
    expect(crashed.stdout).toContain(`Session:: \`${session}\``);
    expect(rig.rows('prompt_batches')).toBe(0);
    const state = readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, session);
    expect(state.promptId).toBeUndefined();
    expect(Object.keys(state.prompts)).toEqual([]);

    await run('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', transcript_path: tx, prompt: 'typed prompt' });
    expect(rig.rows('prompt_batches')).toBe(1);
    // And the transcript pass does not deliver it a second time.
    await run('stop', { hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: '' });
    expect((rig.env.sqlite.query('SELECT COUNT(*) n FROM prompt_batches WHERE text = ?').get('typed prompt') as { n: number }).n).toBe(1);
  });

  it('a spool that cannot be written still answers the harness and exits without a signal', async () => {
    const tx = transcript();
    const crashed = await crashAtCommit(() => run('pre-tool-use', { hook_event_name: 'PreToolUse', transcript_path: tx, tool_name: 'Read', tool_input: { file_path: '/x' } }));
    expect(crashed.stdout).toBe('');
    expect(process.exitCode ?? 0).toBe(0);
    const failed = await crashAtCommit(() => run('post-tool-use', { hook_event_name: 'PostToolUse', transcript_path: tx, tool_name: 'Read', tool_input: { file_path: '/x' }, tool_output: 'body' }));
    expect(failed.stderr).toContain('post-tool-use error');
    expect(process.exitCode ?? 0).toBe(0);
  });
});
