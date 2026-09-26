/**
 * What a run may do, held where the harness actually does it.
 *
 * A source run's Git reads go through the run's own `git`, so each vector a
 * read command offers — writing a file, running a program, reading outside
 * the checkout — is executed against that script and the file system checked
 * afterwards. The protocol driver judges the same calls from the command it is
 * asked about, so the same vectors are put to its grant. OpenCode asks only
 * where its configuration says to, so what a stub OpenCode is started with is
 * read back from the stub itself.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE_GIT_READ_COMMANDS } from '@goondocks/myco-shared/repository';
import { acpDriver, RUN_AGENT, RUN_TOOLS_TIMEOUT_MS, runAgentConfig, turnOver, type Channel } from '@myco/runner/drivers/acp.js';
import { answerPermission, ToolCalls } from '@myco/runner/drivers/acp-permission.js';
import { claudeCodeDriver } from '@myco/runner/drivers/claude-code.js';
import { grantsCall, runGrant, SHELL_TOOL } from '@myco/runner/drivers/grant.js';
import { listRunTools, type RunTools } from '@myco/runner/drivers/run-tools.js';
import { GIT_TRIPWIRE_ENV, gitReadRefusal, shellWords } from '@myco/runner/drivers/source-git.js';
import type { RunEvent } from '@myco/runner/events.js';
import { writeRunDir } from '@myco/runner/mcp-config.js';
import { harnessById, HARNESSES } from '@myco/runner/harnesses.js';

const CONNECTION = { serverUrl: 'https://deployment.example', projectId: 'proj_1', runToken: 'tok_run_secret' };

/** A harness whose shell reaches the run's own `git`. */
const SHIM = { sourceGit: 'shim' } as const;

/** Git for setting a fixture up, reading neither the machine's nor the user's configuration. */
const setupEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const setupGit = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: setupEnv, encoding: 'utf8' });

/** A source run's directory: its MCP configuration, and a checkout with two commits at `repo`. */
function sourceRun(): { scratchDir: string; mcpConfigPath: string; repo: string } {
  const run = writeRunDir(mkdtempSync(join(tmpdir(), 'myco-run-')), 'run_1', CONNECTION);
  const repo = join(run.scratchDir, 'repo');
  mkdirSync(repo);
  setupGit(repo, 'init', '-q');
  writeFileSync(join(repo, 'a'), 'hello\n');
  setupGit(repo, 'add', 'a');
  setupGit(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one');
  writeFileSync(join(repo, 'a'), 'hello\nmore\n');
  setupGit(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'two');
  return { ...run, repo };
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/**
 * Each way a read command can write, run a program, or leave the checkout, as
 * the arguments after `git`, with the file it would create where it creates
 * one. `grep` is out of the read list, so its vector is refused as a command.
 */
const VECTORS: Array<{ args: string[]; creates?: string }> = [
  { args: ['-C', 'repo', 'log', '--output=../made-output'], creates: 'made-output' },
  { args: ['-C', 'repo', 'log', '--outp=../made-abbrev'], creates: 'made-abbrev' },
  { args: ['-C', 'repo', 'show', '--output=../made-show', 'HEAD'], creates: 'made-show' },
  { args: ['-C', 'repo', 'blame', '--output=../made-blame', 'a'], creates: 'made-blame' },
  { args: ['-C', 'repo', 'diff', '--no-index', '--output=../made-noindex', 'a', '/etc/hosts'], creates: 'made-noindex' },
  { args: ['-C', 'repo', 'grep', '-Otouch ../made-pager', 'hello'], creates: 'made-pager' },
  { args: ['-C', 'repo', 'grep', '--open-files-in-pager=touch ../made-pager-long', 'hello'], creates: 'made-pager-long' },
  { args: ['-C', 'repo', 'diff', '--no-index', 'a', '/etc/hosts'] },
  { args: ['-c', 'core.pager=touch made-pager-config', '-C', 'repo', 'log', '-p'], creates: 'made-pager-config' },
  { args: ['-C', 'repo', '-c', 'alias.x=!touch ../made-alias', 'x'], creates: 'made-alias' },
  { args: ['-C', 'repo', '--exec-path=/tmp', 'log'] },
  { args: ['--git-dir=repo/.git', 'log'] },
  { args: ['-C', 'repo', 'log', '--help'] },
  { args: ['-C', '/', 'log'] },
];

describe('the run\'s own git', () => {
  function shim(run: { scratchDir: string; mcpConfigPath: string }, args: readonly string[], env: Record<string, string> = {}): { status: number | null; stderr: string } {
    const grant = runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, SHIM);
    const result = spawnSync(join(run.scratchDir, 'bin', 'git'), [...args], { cwd: run.scratchDir, env: { ...process.env, ...grant.env, ...env }, encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr };
  }

  it('runs a read of the checkout with the machine\'s Git', () => {
    const run = sourceRun();
    const result = spawnSync(join(run.scratchDir, 'bin', 'git'), ['-C', 'repo', 'log', '--format=%s'], {
      cwd: run.scratchDir, env: { ...process.env, ...runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, SHIM).env }, encoding: 'utf8',
    });
    expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 0, stdout: 'two\none\n' });
  });

  it('refuses each way a read command writes a file, runs a program or leaves the checkout, and nothing is made', () => {
    const run = sourceRun();
    for (const { args, creates } of VECTORS) {
      const { status, stderr } = shim(run, args);
      expect({ args, status, refused: stderr.startsWith('git: ') }).toEqual({ args, status: 1, refused: true });
      if (creates !== undefined) {
        expect({ args, made: existsSync(join(run.scratchDir, creates)) || existsSync(join(run.repo, creates)) }).toEqual({ args, made: false });
      }
    }
  });

  it('refuses a checkout directory that leads out of the checkout through a link, and a call made outside it', () => {
    const run = sourceRun();
    const elsewhere = sourceRun();
    symlinkSync(elsewhere.repo, join(run.repo, 'link'));
    expect(shim(run, ['-C', 'repo/link', 'log', '-1']).stderr).toContain('only inside this run\'s checkout');
    expect(shim(run, ['log', '-1']).stderr).toContain('only inside this run\'s checkout');
  });

  it('reads neither the user\'s Git configuration nor the Git variables it was handed', () => {
    const run = sourceRun();
    const home = mkdtempSync(join(tmpdir(), 'myco-home-'));
    const made = join(home, 'made-by-external-diff');
    const external = join(home, 'external-diff');
    writeFileSync(external, `#!/bin/sh\ntouch ${JSON.stringify(made)}\n`, { mode: 0o755 });
    writeFileSync(join(home, '.gitconfig'), `[diff]\n\texternal = ${external}\n`);
    const trace = join(home, 'trace');
    const { status } = shim(run, ['-C', 'repo', 'diff', 'HEAD~1'], { HOME: home, XDG_CONFIG_HOME: home, GIT_TRACE: trace, GIT_EXTERNAL_DIFF: external });
    expect({ status, externalRan: existsSync(made), traced: existsSync(trace) }).toEqual({ status: 0, externalRan: false, traced: false });
  });

  it('leaves any other Git in the run\'s environment unable to run', () => {
    const run = sourceRun();
    const result = spawnSync('git', ['-C', 'repo', 'diff', '--no-index', '--output=../made-direct', 'a', '/etc/hosts'], { cwd: run.scratchDir, env: { ...process.env, ...GIT_TRIPWIRE_ENV }, encoding: 'utf8' });
    expect({ status: result.status, made: existsSync(join(run.scratchDir, 'made-direct')) }).toEqual({ status: 128, made: false });
  });

  it('is the git a shell reaches after the user\'s configuration puts another first and defines its own', () => {
    const run = sourceRun();
    const grant = runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, SHIM);
    // A shell whose startup put the machine's Git first and defined `git` itself, then the run's setup.
    const script = `PATH=/usr/bin:/bin:$PATH; git() { echo user-function; }; . ${JSON.stringify(grant.shellSetup!)}; command -v git`;
    const reached = execFileSync('/bin/sh', ['-c', script], { env: { ...process.env, ...grant.env }, encoding: 'utf8' }).trim();
    expect(reached).toBe(join(run.scratchDir, 'bin', 'git'));
  });

  it('is not written, and no Git command granted, where it cannot hold one: on Windows', () => {
    const run = sourceRun();
    const grant = runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, SHIM, 'win32');
    expect(grant.rules.filter((rule) => rule.startsWith(`${SHELL_TOOL}(`))).toEqual([]);
    expect({ env: grant.env, shellSetup: grant.shellSetup, written: existsSync(join(run.scratchDir, 'bin', 'git')) }).toEqual({ env: {}, shellSetup: null, written: false });
  });

  it('grants Git reads only on a harness whose shell reaches the run\'s git: none on Cursor, which keeps its file tools', () => {
    expect(Object.fromEntries(HARNESSES.map((h) => [h.id, h.sourceGit]))).toEqual({
      'claude-code': 'shim', codex: 'none', opencode: 'shim', cursor: 'none', antigravity: 'shim',
    });
    const run = sourceRun();
    const cursor = runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, harnessById('cursor')!);
    expect(cursor.rules.filter((rule) => rule.startsWith(`${SHELL_TOOL}(`))).toEqual([]);
    expect(cursor.rules).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep']));
    expect({ env: cursor.env, shellSetup: cursor.shellSetup, written: existsSync(join(run.scratchDir, 'bin', 'git')) }).toEqual({ env: {}, shellSetup: null, written: false });
    const shim = runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, { ...harnessById('cursor')!, sourceGit: 'shim' });
    expect(shim.rules).toContain(`${SHELL_TOOL}(git -C repo log:*)`);
  });

  it('grants no Git search: runs search with their own tool', () => {
    expect(SOURCE_GIT_READ_COMMANDS as readonly string[]).not.toContain('grep');
  });
});

describe('the protocol driver judging a command from its words', () => {
  it('splits a command as a shell does, and refuses what a shell would expand', () => {
    expect(shellWords(`git -C repo log --format='%h %s' "a b" c\\ d`)).toEqual(['git', '-C', 'repo', 'log', '--format=%h %s', 'a b', 'c d']);
    for (const expanded of ['git log *', 'git log a?', 'git log [ab]', 'git log {a,b}', 'git log ~', 'git log (x)', 'git log !x', 'git log \'open']) {
      expect({ expanded, words: shellWords(expanded) }).toEqual({ expanded, words: null });
    }
  });

  it('refuses the same vectors the run\'s git refuses, however they are quoted, and allows a read', () => {
    const run = sourceRun();
    const { rules } = runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, SHIM);
    const quote = (arg: string): string => `'${arg}'`;
    for (const { args } of VECTORS) {
      // Where `-C` leads is the grant's to judge, by the directories its rules name.
      if (args[1] !== '/') expect({ args, refusal: gitReadRefusal(args) === null }).toEqual({ args, refusal: false });
      expect({ args, granted: grantsCall(rules, SHELL_TOOL, ['git', ...args].map(quote).join(' ')) }).toEqual({ args, granted: false });
    }
    expect(grantsCall(rules, SHELL_TOOL, 'git -C repo log --out\\put=x')).toBe(false);
    expect(grantsCall(rules, SHELL_TOOL, 'git -C repo log "--output=x"')).toBe(false);
    expect(grantsCall(rules, SHELL_TOOL, 'git -C repo log -- *')).toBe(false);
    expect(grantsCall(rules, SHELL_TOOL, `git -C repo log --format='%h %s' -3`)).toBe(true);
    expect(grantsCall(rules, SHELL_TOOL, 'git  -C repo  show HEAD:a')).toBe(true);
  });

  it('refuses a command whose working directory is outside the run\'s, when only an earlier update names it', () => {
    const run = sourceRun();
    const grant = runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, SHIM);
    const options = [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }];
    const answerFor = (cwd: string): { outcome: unknown; refusal: string | null } => {
      const calls = new ToolCalls();
      // OpenCode reports the working directory on the call's updates, and only the command on its permission request.
      calls.saw({ sessionUpdate: 'tool_call_update', toolCallId: 'c', kind: 'execute', rawInput: { command: 'git log -1', cwd } });
      const toolCall = calls.merged({ toolCallId: 'c', kind: 'execute', rawInput: { command: 'git log -1' } });
      return answerPermission(grant, new Set(), 's', { sessionId: 's', options }, toolCall);
    };
    expect(answerFor(run.repo)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' }, refusal: null });
    expect(answerFor(sourceRun().repo)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' }, refusal: 'the command would run outside the run\'s directory' });
    expect(answerFor(join(run.scratchDir, '..'))).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' }, refusal: 'the command would run outside the run\'s directory' });
  });
});

describe('the environment a harness is started in', () => {
  /** A stub harness binary that writes its environment to a file and exits, in place of `name`. */
  function envRecorder(name: string): { dir: string; seen: string } {
    const dir = mkdtempSync(join(tmpdir(), 'myco-stub-'));
    const seen = join(dir, 'env.txt');
    writeFileSync(join(dir, name), `#!/bin/sh\nenv > ${JSON.stringify(seen)}\nprintf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'\n`, { mode: 0o755 });
    chmodSync(join(dir, name), 0o755);
    return { dir, seen };
  }
  const envOf = (seen: string): Record<string, string> => Object.fromEntries(readFileSync(seen, 'utf8').split('\n').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

  it('starts Claude Code on a source run with the run\'s git first, its shell setup sourced after the user\'s, and the tripwire set', async () => {
    const stub = envRecorder('claude');
    process.env.PATH = `${stub.dir}:${process.env.PATH ?? ''}`;
    const run = sourceRun();
    await collect(claudeCodeDriver.run({ ...run, sourceReadOnly: true, prompt: 'read', credentialEnv: {} }, new AbortController().signal));
    const env = envOf(stub.seen);
    expect({
      path: env.PATH!.split(':')[0],
      setup: env.CLAUDE_ENV_FILE,
      tripwire: env.GIT_CONFIG_COUNT,
    }).toEqual({ path: join(run.scratchDir, 'bin'), setup: join(run.scratchDir, 'shell-env.sh'), tripwire: '1' });
  });

  it('starts OpenCode in an agent of the run\'s own under which every call asks, with a shell that reads no startup file', async () => {
    const stub = envRecorder('opencode');
    process.env.PATH = `${stub.dir}:${process.env.PATH ?? ''}`;
    const run = writeRunDir(mkdtempSync(join(tmpdir(), 'myco-run-')), 'run_1', CONNECTION);
    await collect(acpDriver('opencode').run({ ...run, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(JSON.parse(envOf(stub.seen).OPENCODE_CONFIG_CONTENT!)).toEqual({
      default_agent: RUN_AGENT,
      shell: '/bin/sh',
      agent: { [RUN_AGENT]: { mode: 'primary', description: expect.any(String), permission: { '*': 'ask' } } },
    });
    expect(runAgentConfig('win32')).not.toHaveProperty('shell');
  });
});

/** A peer that answers the handshake, opens a session in this mode, and records what it was asked. */
function peerInMode(mode: string): { channel: Channel; asked: string[] } {
  const asked: string[] = [];
  let read: ((line: string) => void) | null = null;
  const channel: Channel = {
    write: (line) => {
      const { id, method } = JSON.parse(line) as { id: number; method: string };
      asked.push(method);
      const result = method === 'session/new' ? { sessionId: 's', configOptions: [{ id: 'mode', currentValue: mode }] } : method === 'session/prompt' ? { stopReason: 'end_turn' } : {};
      queueMicrotask(() => read?.(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`));
    },
    onLine: (fn) => { read = fn; },
    onClose: () => undefined,
  };
  return { channel, asked };
}

const listed = async (): Promise<RunTools> => ({ ok: true, names: new Set(['noop_ping']) });

describe('a run on a harness that asks only under the run\'s agent', () => {
  it('ends before its prompt when the session opens in any other mode', async () => {
    const run = writeRunDir(mkdtempSync(join(tmpdir(), 'myco-run-')), 'run_1', CONNECTION);
    const other = peerInMode('build');
    const events = await collect(turnOver(other.channel, 'opencode', { ...run, prompt: 'do it', credentialEnv: {} }, () => '', listed));
    expect(other.asked).toEqual(['initialize', 'session/new']);
    expect(events).toEqual([{ kind: 'ended', stop: 'error', detail: `the harness opened the session in mode build rather than the run's agent ${RUN_AGENT}, so its calls would not be asked` }]);

    const own = peerInMode(RUN_AGENT);
    expect((await collect(turnOver(own.channel, 'opencode', { ...run, prompt: 'do it', credentialEnv: {} }, () => '', listed))).at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
  });
});

describe('listing the run\'s tools', () => {
  it('stops when the run is stopped, rather than waiting on a server that never answers', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => undefined) });
    try {
      const started = Date.now();
      const listing = await listRunTools({ url: `http://127.0.0.1:${server.port}/mcp`, headers: {} }, AbortSignal.timeout(200));
      expect({ ok: listing.ok, quick: Date.now() - started < 5_000 }).toEqual({ ok: false, quick: true });
    } finally { void server.stop(true); }
  });

  it('is given the run\'s own stop signal, and a run whose listing is stopped ends with why', async () => {
    const run = writeRunDir(mkdtempSync(join(tmpdir(), 'myco-run-')), 'run_1', CONNECTION);
    const stopping = new AbortController();
    const waiting = (_server: unknown, signal: AbortSignal): Promise<RunTools> => new Promise((resolve) => {
      signal.addEventListener('abort', () => { resolve({ ok: false, reason: 'the listing was stopped' }); }, { once: true });
    });
    setTimeout(() => { stopping.abort(); }, 50);
    const peer = peerInMode(RUN_AGENT);
    const started = Date.now();
    const events = await collect(turnOver(peer.channel, 'cursor', { ...run, prompt: 'do it', credentialEnv: {} }, () => '', waiting, { signal: stopping.signal }));
    // Stopped by the run, well before the listing's own timeout would end it.
    expect({ events, stoppedByRun: Date.now() - started < RUN_TOOLS_TIMEOUT_MS / 2 }).toEqual({
      events: [{ kind: 'ended', stop: 'error', detail: 'the run\'s tools could not be listed: the listing was stopped' }],
      stoppedByRun: true,
    });
  });
});
