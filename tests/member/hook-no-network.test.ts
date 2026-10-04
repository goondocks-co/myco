/**
 * Gate G1, deterministic (#1561): no hook waits on the network.
 *
 * Every hook every harness is wired to run (`HOOK_CONFIG`'s events, and the hooks a plugin template runs) runs once,
 * as a hook process, under each credential source a hook command declares. Asserts, for each (harness, hook, source):
 * - with the registry's credential, against a Deployment that never answers: it makes no request at all, and kicks
 *   the member helper whenever it left the helper work (records appended, context asked for, or a turn's or a
 *   session's end);
 * - with the environment's (a sandbox, whose processes end with it): it starts no helper, and makes no request but at
 *   a turn's or a session's end, which delivers in the hook (here against a Deployment that refuses the connection);
 * - either way it answers well inside its declared timeout. How fast each hook answers on the compiled binary is
 *   measured against a budget of its own (`scripts/measure-hook-work.ts`, in CI's hook startup job).
 * A kick is recorded rather than started (`MYCO_TEST_KICK_LOG`), so nothing outlives the test.
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
/** Hooks that end a turn or the session: under the environment's credential they deliver in the hook. */
const ENDS = ['stop', 'session-end'];
/** How long any hook here may take: no dial and nothing waited on, under a test runner's own load. */
const ANSWER_MS = 3_000;

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

  for (const { symbiont, hook, event, timeoutMs } of all) for (const source of ['registry', 'env'] as const) {
    it(`${symbiont} ${hook}${event ? ` (${event})` : ''}, ${source} credential: no request, an answer at once, and a kick only where a helper outlives the hook`, async () => {
      const rig = await memberRig();
      const mycoHome = tempMycoHome();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-g1-'));
      scratch.push(dir, mycoHome);
      if (source === 'registry') registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt });
      const credentialEnv = source === 'env'
        ? { MYCO_SERVER_URL: 'https://member-test.invalid', MYCO_MEMBER_TOKEN: rig.token, MYCO_PROJECT: 'proj_1', MYCO_TEST_REFUSE_FETCH: '1' }
        : { MYCO_TEST_HANG_FETCH: '1' };
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
      const { MYCO_SERVER_URL: _u, MYCO_MEMBER_TOKEN: _t, MYCO_PROJECT: _p, MYCO_JOIN_CODE: _c, ...ambient } = process.env;
      const result = spawnSync(process.execPath, [HOOK_PROCESS, hook, '--symbiont', symbiont, '--credential', source], {
        cwd: process.cwd(),
        env: { ...ambient, MYCO_HOME: mycoHome, ...credentialEnv, MYCO_TEST_FETCH_LOG: fetchLog, MYCO_TEST_KICK_LOG: kickLog },
        input: JSON.stringify(input), encoding: 'utf-8', timeout: timeoutMs, killSignal: 'SIGKILL',
      });
      const elapsed = Date.now() - started;
      expect({ status: result.status, signal: result.signal }).toEqual({ status: 0, signal: null });
      expect(elapsed).toBeLessThan(Math.min(timeoutMs, ANSWER_MS));
      const requests = fs.existsSync(fetchLog) ? fs.readFileSync(fetchLog, 'utf-8').trim().split('\n') : [];
      if (source === 'registry' || !ENDS.includes(hook)) expect(requests).toEqual([]);

      const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://member-test.invalid' }, { mycoHome });
      const state = readSessionState(spool.dir, sessionId);
      const leftWork = spool.depth(sessionId) > 0 || (state.contextAsks ?? []).length > 0 || ALWAYS_KICKS.includes(hook);
      const kicks = fs.existsSync(kickLog) ? fs.readFileSync(kickLog, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as string[]) : [];
      // A sandbox's helper would end with it: none is ever started.
      if (source === 'env') expect(kicks).toEqual([]);
      else if (leftWork) {
        expect(kicks.length).toBeGreaterThan(0);
        expect(kicks[0].slice(-8)).toEqual(['member', 'helper', '--project', 'proj_1', '--server', 'https://member-test.invalid', '--home', mycoHome]);
      }
    }, 30_000);
  }
});
