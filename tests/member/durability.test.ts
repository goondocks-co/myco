/**
 * The commit point. A hook that derives an event also writes the receipt that
 * stops it being derived again — the plan hash, the plan file's content hash,
 * the transcript's read size. If the receipt can be on disk while the event is
 * not, a crash in between is PERMANENT loss: the rerun reads the receipt,
 * derives nothing, and the event exists nowhere. These tests kill the hook
 * exactly there and require the rerun to produce the same capture.
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

/** A Claude Code transcript whose turn wrote `planFile` through a tool the transcript records only as a diff. */
const transcript = (planFile: string): string => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-durable-tx-')), `${session}.jsonl`);
  fs.writeFileSync(file, [
    { type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'typed prompt' }] } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: planFile, old_string: '', new_string: '# Durable' } }] } },
    { type: 'assistant', uuid: 'a2', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'written' }], stop_reason: 'end_turn' } },
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

const memberKinds = () => Object.fromEntries((rig.env.sqlite.query(`SELECT kind, COUNT(*) n FROM events WHERE producer_adapter <> 'transcript-parse' GROUP BY kind`).all() as Array<{ kind: string; n: number }>).map((k) => [k.kind, k.n]));

describe('capture is never lost permanently at the commit point', () => {
  it('a Stop killed after reading the plan write and before appending leaves no receipt: the rerun ships the plan and the delta once', async () => {
    const root = resolveWorktreeRoot(process.cwd()) ?? resolveMemberProjectRoot(process.cwd());
    const file = path.join(root, '.claude/plans', `durable-${session}-${process.pid}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const tx = transcript(file);
      await run('session-start', { hook_event_name: 'SessionStart', transcript_path: tx, cwd: root });
      fs.writeFileSync(file, '# Durable\n\n- [ ] one\n');
      const before = rig.rows('events');
      const spool = new MemberSpool('proj_1', { mycoHome });

      const crashed = await crashAtCommit(() => run('stop', { hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: '', cwd: root }));

      // Nothing was sent, nothing was spooled — and, the point of the test,
      // nothing was receipted: no plan path, no read size, no pointer.
      expect(crashed.stderr).toContain('ENOSPC');
      expect(rig.rows('events')).toBe(before);
      expect(spool.sessionIds().filter((id) => id === session)).toEqual([]);
      const state = readSessionState(spool.dir, session);
      expect(state.planPaths).toEqual({});
      expect(state.transcript).toBeUndefined();

      // The rerun derives exactly what the killed run would have delivered, once.
      await run('stop', { hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: '', cwd: root });
      expect(memberKinds()).toEqual({ 'session.start': 1, plan: 1, 'transcript.segment': 1 });
      expect((rig.env.sqlite.query('SELECT title FROM plans').get() as { title: string }).title).toBe('Durable');
      expect(readSessionState(spool.dir, session).transcript?.parsedSize).toBe(fs.statSync(tx).size);
      await run('stop', { hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: '', cwd: root });
      expect(memberKinds()).toEqual({ 'session.start': 1, plan: 1, 'transcript.segment': 1 });
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
  });

  it('a pasted plan tag killed at the commit point leaves no receipt, and the rerun lands it once', async () => {
    const tx = transcript('/nowhere/plan.md');
    await run('session-start', { hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' });
    const spool = new MemberSpool('proj_1', { mycoHome });
    const prompt = 'Approved:\n<ultraplan>\n# Pasted\n</ultraplan>';
    const crashed = await crashAtCommit(() => run('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', transcript_path: tx, prompt }));
    // Fail open: the harness still gets its response and the hook exits 0.
    expect(crashed.stderr).toContain('ENOSPC');
    expect(crashed.stdout).toContain(`Session:: \`${session}\``);
    expect(rig.rows('plans')).toBe(0);
    expect(Object.keys(readSessionState(spool.dir, session).planHashes)).toEqual([]);

    await run('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', transcript_path: tx, prompt });
    expect(rig.rows('plans')).toBe(1);
    expect(Object.keys(readSessionState(spool.dir, session).planHashes)).toHaveLength(1);
    await run('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', transcript_path: tx, prompt });
    expect(rig.rows('plans')).toBe(1);
    // A transcript-first agent keeps no prompt receipt: the prompt row is the parse's.
    expect(readSessionState(spool.dir, session).promptId).toBeUndefined();
  });

  it('a spool that cannot be written still answers the harness and exits without a signal', async () => {
    const tx = transcript('/nowhere/plan.md');
    const crashed = await crashAtCommit(() => run('pre-tool-use', { hook_event_name: 'PreToolUse', transcript_path: tx, tool_name: 'Read', tool_input: { file_path: '/x' } }));
    expect(crashed.stdout).toBe('');
    expect(process.exitCode ?? 0).toBe(0);
    const failed = await crashAtCommit(() => run('session-end', { hook_event_name: 'SessionEnd', transcript_path: tx }));
    expect(failed.stderr).toContain('session-end error');
    expect(process.exitCode ?? 0).toBe(0);
  });
});
