/**
 * Gate G1, deterministic (#1561): no hook waits on the network.
 *
 * Every hook every harness is wired to run (`HOOK_CONFIG`'s events, and the hooks a plugin template runs) runs once,
 * as a hook process, against a Deployment that never answers. Asserts, for each (harness, hook) pair:
 * - it makes no request at all;
 * - it answers well inside its declared timeout;
 * - it kicks the member helper whenever it left the helper work: records appended, context asked for, or a turn's or a
 *   session's end.
 * The kick is recorded rather than started (`MYCO_TEST_KICK_LOG`), so nothing outlives the test.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';
import { MemberSpool } from '@myco/member/spool.js';
import { readSessionState } from '@myco/member/session-state.js';
import { REPO_ROOT } from '../helpers/import-closure.ts';
import { memberRig, tempMycoHome } from './helpers/server.js';
import { registerTestMember } from './helpers/hooks.js';

const HOOK_PROCESS = path.join(REPO_ROOT, 'tests', 'member', 'helpers', 'hook-process.ts');
const TEMPLATES = path.join(REPO_ROOT, 'packages', 'myco', 'src', 'symbionts', 'templates');
/** Hooks that end a turn or a session, or start one: each kicks whatever it appended. */
const ALWAYS_KICKS = ['session-start', 'stop', 'session-end'];

/** Every (harness, hook) pair: the manifest's wired events, and the hooks each plugin template runs. */
function pairs(): Array<{ symbiont: string; hook: string; event?: string; timeoutMs: number }> {
  const out: Array<{ symbiont: string; hook: string; event?: string; timeoutMs: number }> = [];
  for (const [symbiont, config] of Object.entries(HOOK_CONFIG)) {
    for (const [event, entry] of Object.entries(config.hookEvents)) out.push({ symbiont, hook: entry.hook, event, timeoutMs: (entry.timeout ?? 5) * 1000 });
    const plugin = path.join(TEMPLATES, symbiont, 'plugin.ts');
    if (fs.existsSync(plugin)) {
      const hooks = new Set([...fs.readFileSync(plugin, 'utf-8').matchAll(/runMycoHook\([^)]*?"([a-z][a-z-]*)"/g)].map((m) => m[1]));
      for (const hook of hooks) out.push({ symbiont, hook, timeoutMs: 5_000 });
    }
  }
  return out;
}

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('no hook waits on the network (G1)', () => {
  const all = pairs();

  it('covers every harness and every hook it runs', () => {
    expect(new Set(all.map((p) => p.symbiont))).toEqual(new Set(Object.keys(HOOK_CONFIG)));
    expect(all.length).toBeGreaterThan(40);
  });

  for (const { symbiont, hook, event, timeoutMs } of all) {
    it(`${symbiont} ${hook}${event ? ` (${event})` : ''}: no request, an answer at once, and a kick for the work it left`, async () => {
      const rig = await memberRig();
      const mycoHome = tempMycoHome();
      // Under /tmp: a macOS per-user $TMPDIR can make every process started in it slow to launch.
      const dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'myco-g1-'));
      scratch.push(dir, mycoHome);
      registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt });
      const tx = path.join(dir, 'sess-g1.jsonl');
      fs.writeFileSync(tx, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })}\n`);
      const fetchLog = path.join(dir, 'fetch.log');
      const kickLog = path.join(dir, 'kick.log');
      const sessionId = 'sess-g1';
      const input = {
        session_id: sessionId, conversationId: sessionId, conversation_id: sessionId, trajectory_id: sessionId,
        hook_event_name: event, transcript_path: tx, transcriptPath: tx, tool_info: { transcript_path: tx, user_prompt: 'hello' },
        prompt: 'hello', tool_name: 'Read', tool_input: { file_path: '/a' }, tool_response: 'ok', toolCall: { name: 'Read', args: {} },
        last_assistant_message: 'done', agent_id: 'a1', agent_type: 'Explore', cwd: process.cwd(),
      };
      const started = Date.now();
      const result = spawnSync(process.execPath, [HOOK_PROCESS, hook, '--symbiont', symbiont, '--credential', 'registry'], {
        cwd: process.cwd(),
        env: { ...process.env, MYCO_HOME: mycoHome, MYCO_TEST_HANG_FETCH: '1', MYCO_TEST_FETCH_LOG: fetchLog, MYCO_TEST_KICK_LOG: kickLog },
        input: JSON.stringify(input), encoding: 'utf-8', timeout: timeoutMs, killSignal: 'SIGKILL',
      });
      const elapsed = Date.now() - started;
      expect({ status: result.status, signal: result.signal }).toEqual({ status: 0, signal: null });
      expect(elapsed).toBeLessThan(Math.min(timeoutMs, 5_000));
      expect(fs.existsSync(fetchLog) ? fs.readFileSync(fetchLog, 'utf-8').trim().split('\n') : []).toEqual([]);

      const spool = new MemberSpool('proj_1', { mycoHome });
      const state = readSessionState(spool.dir, sessionId);
      const leftWork = spool.depth(sessionId) > 0 || (state.contextAsks ?? []).length > 0 || ALWAYS_KICKS.includes(hook);
      const kicks = fs.existsSync(kickLog) ? fs.readFileSync(kickLog, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as string[]) : [];
      if (leftWork) {
        expect(kicks.length).toBeGreaterThan(0);
        expect(kicks[0].slice(-6)).toEqual(['member', 'helper', '--project', 'proj_1', '--home', mycoHome]);
      }
    }, 30_000);
  }
});
