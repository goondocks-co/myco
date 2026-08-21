/**
 * Write-ahead under a harness kill: a hook whose server never answers (and
 * whose fetch ignores abort) is SIGKILLed at its declared timeout — the event
 * is already in the spool and the next probing hook delivers it. A hook whose
 * server refuses the connection spools, latches, and exits inside its budget.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { MemberSpool } from '@myco/member/spool.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { registerTestMember, recordingFetch, runHook } from './helpers/hooks.js';

let mycoHome: string;
let rig: MemberRig;
let transcriptPath: string;
const savedHome = process.env.MYCO_HOME;
beforeEach(async () => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  resetMachineIdCache();
  rig = await memberRig();
  registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt });
  transcriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-kill-')), 'sess.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n');
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  resetMachineIdCache();
});

function runHookProcess(hook: string, input: Record<string, unknown>, env: Record<string, string>, timeoutMs: number) {
  return spawnSync(process.execPath, [path.resolve('tests/member/helpers/hook-process.ts'), hook, '--symbiont', 'claude-code', '--credential', 'registry'], {
    cwd: process.cwd(),
    env: { ...process.env, MYCO_HOME: mycoHome, ...env },
    input: JSON.stringify({ transcript_path: transcriptPath, ...input }),
    encoding: 'utf-8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
}

describe('write-ahead under a harness kill', () => {
  it('a PostToolUse whose server never answers is killed at its declared timeout; the event is in the spool and the next probing hook delivers it', async () => {
    const declared = HOOK_CONFIG['claude-code'].hookEvents.PostToolUse.timeout! * 1000;
    const result = runHookProcess('post-tool-use', { session_id: 'sess-kill', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/k' } }, { MYCO_TEST_HANG_FETCH: '1' }, declared);
    expect(result.stderr).not.toContain('no capture');
    expect(result.signal).toBe('SIGKILL');
    expect(rig.rows('events')).toBe(0);
    const spool = new MemberSpool('proj_1', { mycoHome });
    expect(spool.depth('sess-kill')).toBe(1);

    // The next hook of the session (Stop always probes) drains the spooled event first, then its own.
    const { fetch, requests } = recordingFetch(rig.fetch);
    await runHook('stop', { session_id: 'sess-kill', hook_event_name: 'Stop', transcript_path: transcriptPath, last_assistant_message: 'done' }, { fetch });
    expect(requests.filter((r) => r.path === '/events').length).toBeGreaterThanOrEqual(2);
    expect(rig.rows('tool_calls')).toBe(1);
    expect(rig.rows('responses')).toBe(1);
    expect(spool.depth('sess-kill')).toBe(0);
    const names = (rig.env.sqlite.query('SELECT tool_name FROM tool_calls').all() as Array<{ tool_name: string }>).map((r) => r.tool_name);
    expect(names).toEqual(['Read']);
  });

  it('a hook whose server refuses the connection spools, latches, and exits 0 well inside its budget', () => {
    const started = Date.now();
    const result = runHookProcess('user-prompt-submit', { session_id: 'sess-refused', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, { MYCO_TEST_REFUSE_FETCH: '1' }, 10_000);
    expect(result.stderr).not.toContain('no capture');
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.stdout).toContain('Session:: `sess-refused`');
    const spool = new MemberSpool('proj_1', { mycoHome });
    expect(spool.depth('sess-refused')).toBe(1);
    expect(spool.readLatch()).not.toBeNull();
  });
});
