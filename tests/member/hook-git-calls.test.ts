/**
 * What git a hook starts (#1561): a repository's identity (its root, branch and commit) is read from git's own files,
 * so a hook's own work starts no git process but at a session's end, which asks git the two questions of whether
 * tracked files changed, at once. Each git process costs 5 to 20 ms on a hook someone is waiting for.
 *
 * A hook that delivers in itself (a sandbox's turn and session ends, `--credential env`) also runs the helper's pass,
 * which asks git for the repository remote the start's context ask carries: that is the only other git it starts.
 *
 * Every hook runs as a hook process with a `git` on PATH that logs each call before running the real one.
 *
 * Where the files leave a repository to git (on Windows, any repository: Git for Windows checks an owner the files
 * cannot be matched with), git's verdict is asked once and kept under the member home: the first hook in the
 * repository asks git that one question, and a second starts no git.
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
const realGit = process.platform === 'win32'
  ? (spawnSync('where.exe', ['git'], { encoding: 'utf-8' }).stdout ?? '').split(/\r?\n/)[0].trim()
  : spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).stdout.trim();

/**
 * A `git` in `bin` that appends each call's arguments to `log`, then runs the real git. On Windows the member finds
 * `git.exe` on PATH, so the logging git is a compiled executable.
 */
function loggingGit(bin: string, log: string): void {
  fs.mkdirSync(bin, { recursive: true });
  if (process.platform !== 'win32') {
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    return;
  }
  const source = path.join(bin, 'logging-git.ts');
  fs.writeFileSync(source, [
    "import { appendFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');`,
    `const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });`,
    'process.exit(result.status ?? 1);',
    '',
  ].join('\n'));
  execFileSync(process.execPath, ['build', '--compile', source, '--outfile', path.join(bin, 'git.exe')], { stdio: 'ignore' });
}

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

/**
 * This process's environment with `dir` first on the search path. Windows names that variable `Path`, and a child
 * given both `Path` and `PATH` may read either: the one here replaces it whatever its case.
 */
function withPathFirst(dir: string): NodeJS.ProcessEnv {
  const entries = Object.entries(process.env);
  const current = entries.find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? '';
  return { ...Object.fromEntries(entries.filter(([name]) => name.toUpperCase() !== 'PATH')), PATH: `${dir}${path.delimiter}${current}` };
}

const VERDICT_QUERY = 'rev-parse --show-toplevel --git-dir --git-common-dir';
const HEAD_QUERIES = ['rev-parse --abbrev-ref HEAD', 'rev-parse HEAD'];

describe.skipIf(realGit === '')('the git a second hook in a repository starts', () => {
  const dir = removeWhenTestsEnd(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hook-verdict-'))));
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'git.log');

  /** A committed repository named `name`, its config set as `config` asks, joined to its own member home. */
  function joinedRepo(name: string, config: string[][] = []) {
    const repo = path.join(dir, name);
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync(realGit, args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'a');
    for (const pair of config) git('config', ...pair);
    const mycoHome = tempMycoHome();
    registerTestMember({ mycoHome, token: 'mt_tok', projectId: 'proj_1', root: repo });
    const tx = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(tx, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
    return (hook: string, event: string): string[] => {
      fs.writeFileSync(log, '');
      const result = spawnSync(process.execPath, [HOOK_PROCESS, hook, '--symbiont', 'claude-code', '--credential', 'registry'], {
        cwd: repo,
        env: { ...withPathFirst(bin), MYCO_HOME: mycoHome, MYCO_TEST_REFUSE_FETCH: '1', MYCO_TEST_KICK_LOG: path.join(dir, 'kick.log') },
        input: JSON.stringify({ session_id: `sess-${name}`, transcript_path: tx, cwd: repo, prompt: 'p', last_assistant_message: 'x', hook_event_name: event }),
        encoding: 'utf-8', timeout: 20_000,
      });
      expect({ hook, status: result.status }).toEqual({ hook, status: 0 });
      return fs.readFileSync(log, 'utf-8').trim().split(/\r?\n/).filter(Boolean);
    };
  }

  it('is none: what the first asked of git is kept', () => {
    loggingGit(bin, log);
    const calls = joinedRepo('plain');
    const first = calls('session-start', 'SessionStart');
    // Windows: git's verdict on the repository, and nothing else; elsewhere the files decide.
    if (process.platform === 'win32') {
      expect(first.length).toBeGreaterThan(0);
      expect(first.filter((call) => call !== VERDICT_QUERY)).toEqual([]);
    } else {
      expect(first).toEqual([]);
    }
    expect(calls('session-start', 'SessionStart')).toEqual([]);
    expect(calls('user-prompt-submit', 'UserPromptSubmit')).toEqual([]);
    expect(calls('stop', 'Stop')).toEqual([]);
  }, 120_000);

  it('is only where HEAD stands, for a repository whose config only git reads', () => {
    if (!fs.existsSync(bin)) loggingGit(bin, log);
    const calls = joinedRepo('worktree-config', [['extensions.worktreeConfig', 'true']]);
    const first = calls('session-start', 'SessionStart');
    expect(first.filter((call) => call !== VERDICT_QUERY).sort()).toEqual(HEAD_QUERIES);
    expect(calls('session-start', 'SessionStart').sort()).toEqual(HEAD_QUERIES);
    expect(calls('user-prompt-submit', 'UserPromptSubmit')).toEqual([]);
    expect(calls('stop', 'Stop')).toEqual([]);
  }, 120_000);
});
