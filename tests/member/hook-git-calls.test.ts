/**
 * What git a hook starts (#1561): a repository's identity (its root, branch and commit) is read from git's own files,
 * so a hook's own work starts no git process but at a session's end, which asks git the two questions of whether
 * tracked files changed, at once. Each git process costs 5 to 20 ms on a hook someone is waiting for.
 *
 * A hook that delivers in itself (a sandbox's turn and session ends, `--credential env`) also runs the helper's pass,
 * which asks git for the repository remote the start's context ask carries: that is the only other git it starts.
 *
 * Every hook runs as a hook process with a `git` on PATH that logs each call before running the real one.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/import-closure.ts';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.ts';
import { registerTestMember } from './helpers/hooks.js';
import { tempMycoHome } from './helpers/server.js';

const HOOK_PROCESS = path.join(REPO_ROOT, 'tests', 'member', 'helpers', 'hook-process.ts');
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).stdout.trim();

describe.skipIf(process.platform === 'win32' || realGit === '')('the git a hook starts', () => {
  it('is none for a session\'s start, prompt and turn end, and only the two dirty questions for its end', () => {
    const dir = removeWhenTestsEnd(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hook-git-'))));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync(realGit, args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'a');
    git('remote', 'add', 'origin', 'https://example.com/team/repo.git');
    const shim = path.join(dir, 'bin');
    fs.mkdirSync(shim);
    const log = path.join(dir, 'git.log');
    // Each call is logged; a dirty question also holds for 300 ms and logs when it ran, so the two can be seen to overlap.
    const spans = path.join(dir, 'spans.log');
    fs.writeFileSync(path.join(shim, 'git'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${log}"`,
      'case "$1" in diff)',
      `  s=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000'); sleep 0.3; "${realGit}" "$@"; rc=$?`,
      `  e=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000'); printf '%s %s\\n' "$s" "$e" >> "${spans}"; exit $rc ;;`,
      'esac',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });

    const mycoHome = tempMycoHome();
    registerTestMember({ mycoHome, token: 'mt_tok', projectId: 'proj_1', root: repo });
    const tx = path.join(dir, 'sess-git.jsonl');
    fs.writeFileSync(tx, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
    const calls = (hook: string, extra: Record<string, unknown> = {}, source: 'registry' | 'env' = 'registry'): string[] => {
      fs.writeFileSync(log, '');
      const credential = source === 'env' ? { MYCO_SERVER_URL: 'https://member-test.invalid', MYCO_MEMBER_TOKEN: 'mt_tok', MYCO_PROJECT: 'proj_1' } : {};
      const result = spawnSync(process.execPath, [HOOK_PROCESS, hook, '--symbiont', 'claude-code', '--credential', source], {
        cwd: repo,
        env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}`, MYCO_HOME: mycoHome, ...credential, MYCO_TEST_REFUSE_FETCH: '1', MYCO_TEST_KICK_LOG: path.join(dir, 'kick.log') },
        input: JSON.stringify({ session_id: 'sess-git', transcript_path: tx, cwd: repo, prompt: 'p', last_assistant_message: 'x', ...extra }),
        encoding: 'utf-8', timeout: 20_000,
      });
      expect({ hook, status: result.status }).toEqual({ hook, status: 0 });
      return fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean);
    };

    expect(calls('session-start', { hook_event_name: 'SessionStart' })).toEqual([]);
    expect(calls('user-prompt-submit', { hook_event_name: 'UserPromptSubmit' })).toEqual([]);
    expect(calls('stop', { hook_event_name: 'Stop' })).toEqual([]);
    expect(calls('session-end', { hook_event_name: 'SessionEnd' }).sort()).toEqual(['diff --cached --quiet --', 'diff --quiet --']);
    // Asked at once: each started before the other ended.
    const [a, b] = fs.readFileSync(spans, 'utf-8').trim().split('\n').map((line) => line.split(' ').map(Number));
    expect({ overlap: a[0] < b[1] && b[0] < a[1] }).toEqual({ overlap: true });

    // A sandbox: its ends run the helper's pass in the hook, which asks git for the remote the start's ask carries.
    const remote = 'remote get-url origin';
    const env = { session_id: 'sess-git-env' };
    expect(calls('session-start', { ...env, hook_event_name: 'SessionStart' }, 'env')).toEqual([]);
    expect(calls('user-prompt-submit', { ...env, hook_event_name: 'UserPromptSubmit' }, 'env')).toEqual([]);
    expect(calls('stop', { ...env, hook_event_name: 'Stop' }, 'env').filter((c) => c !== remote)).toEqual([]);
    expect(calls('session-end', { ...env, hook_event_name: 'SessionEnd' }, 'env').filter((c) => c !== remote).sort()).toEqual(['diff --cached --quiet --', 'diff --quiet --']);
  }, 60_000);
});
