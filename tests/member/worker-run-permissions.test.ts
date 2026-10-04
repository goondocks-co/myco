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
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "../support/fenced-fs.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE_GIT_READ_COMMANDS } from '@goondocks/myco-shared/repository';
import { acpDriver, RUN_AGENT_PREFIX, RUN_TOOLS_TIMEOUT_MS, runAgentConfig, runAsking, turnOver, type Channel } from '@myco/runner/drivers/acp.js';
import { answerPermission, ToolCalls } from '@myco/runner/drivers/acp-permission.js';
import { claudeCodeDriver } from '@myco/runner/drivers/claude-code.js';
import { driverFor } from '@myco/runner/drivers/registry.js';
import { writeCursorRunHome } from '@myco/runner/drivers/cursor.js';
import { grantsCall, runGrant, SHELL_TOOL } from '@myco/runner/drivers/grant.js';
import { listRunTools, type RunTools } from '@myco/runner/drivers/run-tools.js';
import { GIT_TRIPWIRE_ENV, gitReadRefusal, gitShimScript, shellWords } from '@myco/runner/drivers/source-git.js';
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

/** The machine's Git, as the run's `git` would find it. */
const machineGit = (): string => execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

/**
 * A source run whose checkout holds, at `evil`, a directory laid out as a bare
 * repository with a history of its own, whose configuration and attributes
 * select a diff program, a text conversion and a file system monitor that each
 * make `sentinel`, and whose own attributes select that driver for every file.
 */
function checkoutHoldingARepository(): { run: ReturnType<typeof sourceRun>; sentinel: string } {
  const run = sourceRun();
  const outside = mkdtempSync(join(tmpdir(), 'myco-evil-'));
  const sentinel = join(outside, 'sentinel');
  const program = join(outside, 'driver');
  writeFileSync(program, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\ncat "$1" 2>/dev/null\n`, { mode: 0o755 });
  const source = join(outside, 'source');
  mkdirSync(source);
  setupGit(source, 'init', '-q');
  writeFileSync(join(source, 'a'), 'evil\n');
  setupGit(source, 'add', 'a');
  setupGit(source, '-c', 'user.name=e', '-c', 'user.email=e@e', 'commit', '-qm', 'evil-history');
  writeFileSync(join(source, 'a'), 'evil\nmore\n');
  setupGit(source, '-c', 'user.name=e', '-c', 'user.email=e@e', 'commit', '-qam', 'evil-history-2');
  const evil = join(run.repo, 'evil');
  setupGit(run.scratchDir, 'clone', '-q', '--bare', source, evil);
  appendFileSync(join(evil, 'config'), `[diff "evil"]\n\ttextconv = ${program}\n[diff]\n\texternal = ${program}\n[core]\n\tfsmonitor = ${program}\n`);
  mkdirSync(join(evil, 'info'), { recursive: true });
  writeFileSync(join(evil, 'info', 'attributes'), '* diff=evil\n');
  writeFileSync(join(run.repo, '.gitattributes'), '* diff=evil\n');
  setupGit(run.repo, 'add', '-A');
  setupGit(run.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'three');
  return { run, sentinel };
}

/** A read of each command the run may make, from inside the checkout's `evil` directory. */
const READS_FROM_EVIL: Record<(typeof SOURCE_GIT_READ_COMMANDS)[number], string[]> = {
  log: ['log', '-p', '--format=%s', 'HEAD', '--'],
  shortlog: ['shortlog', '-s', 'HEAD', '--'],
  show: ['show', '--format=%s', 'HEAD', '--'],
  diff: ['diff', 'HEAD~1', 'HEAD', '--'],
  'diff-tree': ['diff-tree', '-p', '--textconv', 'HEAD~1', 'HEAD', '--'],
  'ls-tree': ['ls-tree', '-r', '--name-only', 'HEAD'],
  'ls-files': ['ls-files'],
  'rev-parse': ['rev-parse', '--show-toplevel', '--git-dir'],
  'rev-list': ['rev-list', 'HEAD', '--'],
  status: ['status', '--porcelain'],
  blame: ['blame', 'HEAD', '--', 'config'],
  'cat-file': ['cat-file', '--textconv', 'HEAD:evil/config'],
  describe: ['describe', '--always'],
};

/**
 * Each way a read command reads a file named by path outside the checkout, as
 * the arguments after `git`, given the file's absolute path. The file sits
 * beside the checkout, so `../outside` names it from the checkout, and so does
 * the link `outlink` inside the checkout.
 */
const OUTSIDE_READS = (outside: string): string[][] => [
  ['-C', 'repo', 'blame', '--contents', 'outlink', 'a'],
  ['-C', 'repo', 'blame', '--ignore-revs-file=outlink', 'a'],
  ['-C', 'repo', 'blame', '-S', 'outlink', 'a'],
  ['-C', 'repo', 'log', '-1', '-p', '-Ooutlink'],
  ['-C', 'repo', 'ls-files', '--exclude-from=outlink'],
  ['-C', 'repo', 'ls-files', '-X', 'outlink'],
  ['-C', 'repo', 'rev-parse', '--resolve-git-dir', 'outlink'],
  ['-C', 'repo', 'diff', `--relative=${outside}`],
  ['-C', 'repo', 'blame', '--contents', outside, 'a'],
  ['-C', 'repo', 'blame', `--contents=${outside}`, 'a'],
  ['-C', 'repo', 'blame', `--cont=${outside}`, 'a'],
  ['-C', 'repo', 'blame', `--ignore-revs-file=${outside}`, 'a'],
  ['-C', 'repo', 'blame', '--ignore-revs', outside, 'a'],
  ['-C', 'repo', 'blame', '-S', outside, 'a'],
  ['-C', 'repo', 'blame', '-S', '../outside', 'a'],
  ['-C', 'repo', 'blame', `-wS${outside}`, 'a'],
  ['-C', 'repo', 'diff', outside, '/dev/null'],
  ['-C', 'repo', 'diff', '../outside', 'a'],
  ['-C', 'repo', 'log', '-1', `-pO${outside}`],
  ['-C', 'repo', 'ls-files', `--exclude-from=${outside}`],
  ['-C', 'repo', 'ls-files', '-o', `-cX${outside}`],
  ['-C', 'repo', 'rev-parse', '--resolve-git-dir', outside],
  ['-C', 'repo', 'show', 'HEAD', '--', outside],
  ['-C', 'repo', 'log', '--', '..'],
  ['-C', 'repo', 'log', '--', 'a/../../outside'],
];

/** Reads of the checkout that begin like a refused option or path and are not one. */
const ALLOWED_READS: string[][] = [
  ['-C', 'repo', 'log', '-Stwo', '--format=%s'],
  ['-C', 'repo', 'log', '--exclude=x*', '--all', '--format=%s'],
  ['-C', 'repo', 'blame', '--ignore-rev', 'HEAD', 'a'],
  ['-C', 'repo', 'log', 'HEAD~1..HEAD', '--format=%s'],
  ['-C', 'repo', 'diff', 'HEAD~1', '--', 'a'],
];

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
  { args: ['-C', 'repo', 'log', '--output=made-inside'], creates: 'made-inside' },
  { args: ['-C', 'repo', 'log', '--outp=../made-abbrev'], creates: 'made-abbrev' },
  { args: ['-C', 'repo', 'log', '--outp=made-abbrev-inside'], creates: 'made-abbrev-inside' },
  { args: ['-C', 'repo', 'blame', '--conte', 'a', 'a'] },
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
  function shim(run: { scratchDir: string; mcpConfigPath: string }, args: readonly string[], env: Record<string, string> = {}, cwd = run.scratchDir): { status: number | null; stdout: string; stderr: string } {
    const grant = runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, SHIM);
    const result = spawnSync(join(run.scratchDir, 'bin', 'git'), [...args], { cwd, env: { ...process.env, ...grant.env, ...env }, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /** A source run whose checkout holds a committed subdirectory, as a harness's shell would stand in after a `cd`. */
  function runWithSubdirectory(): { run: ReturnType<typeof sourceRun>; sub: string } {
    const run = sourceRun();
    const sub = join(run.repo, 'pkg', 'src');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'b'), 'b\n');
    setupGit(run.repo, 'add', '-A');
    setupGit(run.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'three');
    return { run, sub };
  }

  it('reads the checkout from a directory inside it, whether the call names the checkout relative to the run\'s directory, absolutely, or not at all', () => {
    const { run, sub } = runWithSubdirectory();
    const reads: string[][] = [
      ['log', '--format=%s'],
      ['-C', 'repo', 'log', '--format=%s'],
      ['-C', join(run.scratchDir, 'repo'), 'log', '--format=%s'],
      ['-C', realpathSync(run.repo), 'log', '--format=%s'],
    ];
    for (const cwd of [sub, join(run.repo, 'pkg'), run.repo]) {
      for (const args of reads) {
        const { status, stdout, stderr } = shim(run, args, {}, cwd);
        expect({ cwd, args, status, stdout, stderr }).toEqual({ cwd, args, status: 0, stdout: 'three\ntwo\none\n', stderr: '' });
      }
    }
    // A directory the shell can reach from where it stands is the one Git runs in, as Git's own `-C` has it.
    expect(shim(run, ['-C', '..', 'log', '--format=%s'], {}, sub).stdout).toBe('three\ntwo\none\n');
    expect(shim(run, ['-C', 'src', 'ls-files'], {}, join(run.repo, 'pkg')).stdout).toBe('b\n');
  });

  it('refuses from a directory inside the checkout everything it refuses from the run\'s directory, and a directory named from the run\'s that leads out of the checkout', () => {
    const { run, sub } = runWithSubdirectory();
    const elsewhere = sourceRun();
    symlinkSync(elsewhere.repo, join(run.repo, 'link'));
    symlinkSync(elsewhere.repo, join(run.scratchDir, 'escape'));
    const outside = (args: string[]): void => {
      const { status, stderr } = shim(run, args, {}, sub);
      expect({ args, status, refused: stderr.includes('only inside this run\'s checkout') }).toEqual({ args, status: 1, refused: true });
    };
    outside(['-C', 'repo/link', 'log', '-1']);
    outside(['-C', 'escape', 'log', '-1']);
    outside(['-C', '../../..', 'log', '-1']);
    outside(['-C', '.', '-C', '../../..', 'log', '-1']);
    outside(['-C', join(run.scratchDir, 'repo', '..'), 'log', '-1']);
    expect(shim(run, ['-C', 'nowhere', 'log', '-1'], {}, sub).stderr).toBe('git: cannot change to nowhere\n');
    expect(shim(run, ['-C', join(run.scratchDir, 'nowhere'), 'log', '-1'], {}, sub).stderr).toContain('cannot change to');
    for (const { args, creates } of VECTORS) {
      const { status, stderr } = shim(run, args, {}, sub);
      expect({ args, status, refused: stderr.startsWith('git: ') }).toEqual({ args, status: 1, refused: true });
      if (creates !== undefined) {
        const made = [run.scratchDir, run.repo, sub, join(run.repo, 'pkg')].some((dir) => existsSync(join(dir, creates)));
        expect({ args, made }).toEqual({ args, made: false });
      }
    }
    for (const args of OUTSIDE_READS(join(run.scratchDir, 'outside'))) {
      const { status, stderr } = shim(run, args, {}, sub);
      expect({ args, status, refused: stderr.startsWith('git: ') }).toEqual({ args, status: 1, refused: true });
    }
  });

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

  it('grants Git reads only on a harness whose shell reaches the run\'s git: none on Cursor or Antigravity, which keep their file tools', () => {
    expect(Object.fromEntries(HARNESSES.map((h) => [h.id, h.sourceGit]))).toEqual({
      'claude-code': 'shim', codex: 'none', opencode: 'shim', cursor: 'none', antigravity: 'none',
    });
    const run = sourceRun();
    for (const id of ['cursor', 'antigravity']) {
      const grant = runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, harnessById(id)!);
      expect({ id, git: grant.rules.filter((rule) => rule.startsWith(`${SHELL_TOOL}(`)) }).toEqual({ id, git: [] });
      expect(grant.rules.some((rule) => ['Read', 'Glob', 'Grep'].includes(rule))).toBe(false);
      expect(grant.source?.root).toBe(realpathSync(join(run.scratchDir, 'repo')));
      expect({ id, env: grant.env, shellSetup: grant.shellSetup, written: existsSync(join(run.scratchDir, 'bin', 'git')) }).toEqual({ id, env: {}, shellSetup: null, written: false });
    }
    const shim = runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, { ...harnessById('cursor')!, sourceGit: 'shim' });
    expect(shim.rules).toContain(`${SHELL_TOOL}(git -C repo log:*)`);
  });

  it('grants no Git search: runs search with their own tool', () => {
    expect(SOURCE_GIT_READ_COMMANDS as readonly string[]).not.toContain('grep');
  });

  it('reads the checkout\'s own repository from a directory inside it laid out as a repository, and runs none of that directory\'s programs', () => {
    const { run, sentinel } = checkoutHoldingARepository();
    const env = { ...process.env, ...runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, SHIM).env };
    const git = join(run.scratchDir, 'bin', 'git');
    for (const [command, args] of Object.entries(READS_FROM_EVIL)) {
      for (const [from, cwd, before] of [['inside', join(run.repo, 'evil'), []], ['by -C', run.scratchDir, ['-C', 'repo/evil']]] as const) {
        const result = spawnSync(git, [...before, ...args], { cwd, env, encoding: 'utf8' });
        const output = result.stdout + result.stderr;
        expect({ command, from, status: result.status, evil: output.includes('evil-history') }).toEqual({ command, from, status: 0, evil: false });
      }
    }
    const log = spawnSync(git, ['-C', 'repo/evil', 'log', '--format=%s', 'HEAD', '--'], { cwd: run.scratchDir, env, encoding: 'utf8' });
    const top = spawnSync(git, ['rev-parse', '--show-toplevel'], { cwd: join(run.repo, 'evil'), env, encoding: 'utf8' });
    expect({ log: log.stdout, top: top.stdout.trim(), ran: existsSync(sentinel) }).toEqual({ log: 'three\ntwo\none\n', top: realpathSync(run.repo), ran: false });
  });

  it('refuses each way a read command reads a file outside the checkout, and shows none of it', () => {
    const run = sourceRun();
    const outside = join(run.scratchDir, 'outside');
    writeFileSync(outside, 'outside-secret\n');
    symlinkSync(outside, join(run.repo, 'outlink'));
    for (const args of OUTSIDE_READS(outside)) {
      const result = spawnSync(join(run.scratchDir, 'bin', 'git'), args, {
        cwd: run.scratchDir, env: { ...process.env, ...runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, SHIM).env }, encoding: 'utf8',
      });
      expect({ args, status: result.status, refused: result.stderr.startsWith('git: '), shown: (result.stdout + result.stderr).includes('outside-secret') })
        .toEqual({ args, status: 1, refused: true, shown: false });
    }
  });

  it('allows the reads that only begin like a refused option or path', () => {
    const run = sourceRun();
    for (const args of ALLOWED_READS) {
      const { status, stderr } = shim(run, args);
      expect({ args, status, stderr }).toEqual({ args, status: 0, stderr: '' });
    }
  });

  it('gives Git nothing to read on its standard input', () => {
    const run = sourceRun();
    const env = { ...process.env, ...runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, SHIM).env };
    for (const args of [['-C', 'repo', 'rev-list', '--stdin'], ['-C', 'repo', 'cat-file', '--batch-check'], ['-C', 'repo', 'shortlog']]) {
      const result = spawnSync(join(run.scratchDir, 'bin', 'git'), args, { cwd: run.scratchDir, env, input: 'outside-secret\n', encoding: 'utf8' });
      expect({ args, shown: (result.stdout + result.stderr).includes('outside-secret') }).toEqual({ args, shown: false });
    }
  });

  it('checks a commit\'s signature with no program', () => {
    const run = sourceRun();
    const bin = mkdtempSync(join(tmpdir(), 'myco-gpg-'));
    const ran = join(bin, 'ran');
    writeFileSync(join(bin, 'gpg'), `#!/bin/sh\ntouch ${JSON.stringify(ran)}\nexit 1\n`, { mode: 0o755 });
    const tree = setupGit(run.repo, 'rev-parse', 'HEAD^{tree}').trim();
    const signed = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: run.repo, env: setupEnv, encoding: 'utf8',
      input: `tree ${tree}\nauthor t <t@t> 1 +0000\ncommitter t <t@t> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\nsigned\n`,
    }).trim();
    const grant = runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, SHIM);
    for (const args of [['log', '-1', '--format=%G? %s', signed], ['show', '--show-signature', signed]]) {
      spawnSync(join(run.scratchDir, 'bin', 'git'), ['-C', 'repo', ...args], { cwd: run.scratchDir, env: { ...process.env, ...grant.env, PATH: `${bin}:${grant.env.PATH!}` }, encoding: 'utf8' });
      expect({ args, ran: existsSync(ran) }).toEqual({ args, ran: false });
    }
  });

  it('never reads the machine\'s Git configuration', () => {
    const run = sourceRun();
    const machine = mkdtempSync(join(tmpdir(), 'myco-machine-'));
    const system = join(machine, 'gitconfig');
    writeFileSync(system, '[format]\n\tpretty = format:read-the-machine-configuration\n');
    // A machine whose Git reads its system configuration from `system`.
    const git = join(machine, 'git');
    writeFileSync(git, `#!/bin/sh\nGIT_CONFIG_SYSTEM=${JSON.stringify(system)} exec ${JSON.stringify(machineGit())} "$@"\n`, { mode: 0o755 });
    const shimPath = join(machine, 'run-git');
    writeFileSync(shimPath, gitShimScript(git, realpathSync(run.repo)), { mode: 0o755 });
    const result = spawnSync(shimPath, ['log', '-1'], { cwd: run.repo, env: { ...process.env, ...GIT_TRIPWIRE_ENV }, encoding: 'utf8' });
    expect({ status: result.status, read: result.stdout.includes('read-the-machine-configuration') }).toEqual({ status: 0, read: false });
  });

  it('hands the Git it runs the checkout\'s repository by name, and only the Git variables that confine it', () => {
    const run = sourceRun();
    const recorder = mkdtempSync(join(tmpdir(), 'myco-recorder-'));
    const seen = join(recorder, 'env.txt');
    writeFileSync(join(recorder, 'git'), `#!/bin/sh\nenv > ${JSON.stringify(seen)}\n`, { mode: 0o755 });
    const shimPath = join(recorder, 'run-git');
    const repo = realpathSync(run.repo);
    writeFileSync(shimPath, gitShimScript(join(recorder, 'git'), repo), { mode: 0o755 });
    spawnSync(shimPath, ['log'], { cwd: run.repo, env: { ...process.env, ...GIT_TRIPWIRE_ENV, GIT_DIR: '/elsewhere', GIT_CONFIG_PARAMETERS: '\'core.pager\'=\'x\'' } });
    const variables = Object.fromEntries(readFileSync(seen, 'utf8').split('\n').filter((line) => line.startsWith('GIT_')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    expect(variables).toEqual({
      GIT_DIR: `${repo}/.git`,
      GIT_WORK_TREE: repo,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_PAGER: 'cat',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '6',
      GIT_CONFIG_KEY_0: 'safe.bareRepository', GIT_CONFIG_VALUE_0: 'explicit',
      GIT_CONFIG_KEY_1: 'core.attributesFile', GIT_CONFIG_VALUE_1: '/dev/null',
      GIT_CONFIG_KEY_2: 'core.excludesFile', GIT_CONFIG_VALUE_2: '/dev/null',
      GIT_CONFIG_KEY_3: 'gpg.program', GIT_CONFIG_VALUE_3: '/dev/null',
      GIT_CONFIG_KEY_4: 'gpg.ssh.program', GIT_CONFIG_VALUE_4: '/dev/null',
      GIT_CONFIG_KEY_5: 'gpg.x509.program', GIT_CONFIG_VALUE_5: '/dev/null',
    });
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

  it('refuses the same reads outside the checkout the run\'s git refuses, and allows the same reads that only begin like one', () => {
    const run = sourceRun();
    const { rules } = runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, SHIM);
    const quote = (arg: string): string => `'${arg}'`;
    for (const args of OUTSIDE_READS(join(run.scratchDir, 'outside'))) {
      expect({ args, refused: gitReadRefusal(args) !== null, granted: grantsCall(rules, SHELL_TOOL, ['git', ...args].map(quote).join(' ')) })
        .toEqual({ args, refused: true, granted: false });
    }
    for (const args of ALLOWED_READS) {
      expect({ args, refusal: gitReadRefusal(args), granted: grantsCall(rules, SHELL_TOOL, ['git', ...args].map(quote).join(' ')) })
        .toEqual({ args, refusal: null, granted: true });
    }
  });

  it('refuses a command whose working directory is outside the run\'s, when only an earlier update names it', () => {
    const run = sourceRun();
    const grant = runGrant({ ...run, prompt: '', credentialEnv: {}, sourceReadOnly: true }, SHIM);
    const options = [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }];
    const answerFor = (directories: { cwd?: string; workdir?: string }): { outcome: unknown; refusal: string | null } => {
      const calls = new ToolCalls();
      // OpenCode reports the working directory on the call's updates, and only the command on its permission request.
      calls.saw({ sessionUpdate: 'tool_call_update', toolCallId: 'c', kind: 'execute', rawInput: { command: 'git log -1', ...directories } });
      const toolCall = calls.merged({ toolCallId: 'c', kind: 'execute', rawInput: { command: 'git log -1' } });
      return answerPermission(grant, new Set(), 's', { sessionId: 's', options }, toolCall);
    };
    const outside = { outcome: { outcome: 'selected', optionId: 'reject' }, refusal: 'the command would run outside the run\'s directory' };
    expect(answerFor({ cwd: run.repo })).toEqual({ outcome: { outcome: 'selected', optionId: 'once' }, refusal: null });
    expect(answerFor({ cwd: run.repo, workdir: run.repo })).toEqual({ outcome: { outcome: 'selected', optionId: 'once' }, refusal: null });
    expect(answerFor({ cwd: sourceRun().repo })).toEqual(outside);
    expect(answerFor({ cwd: join(run.scratchDir, '..') })).toEqual(outside);
    // OpenCode names the directory the agent asked for as `workdir`, beside the one it reports as `cwd`.
    expect(answerFor({ workdir: sourceRun().repo })).toEqual(outside);
    expect(answerFor({ cwd: run.repo, workdir: join(run.scratchDir, '..') })).toEqual(outside);
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

  it('starts OpenCode in an agent of the run\'s own under which every call asks, with a shell that reads no startup file and no plugin loaded', async () => {
    const stub = envRecorder('opencode');
    process.env.PATH = `${stub.dir}:${process.env.PATH ?? ''}`;
    const run = writeRunDir(mkdtempSync(join(tmpdir(), 'myco-run-')), 'run_1', CONNECTION);
    await collect(acpDriver('opencode').run({
      ...run, prompt: 'do it', credentialEnv: {},
      profile: { tier: 'default', model: 'openai/gpt-6.1', effort: 'medium', sources: { tier: 'task', model: 'configured' } },
    }, new AbortController().signal));
    const env = envOf(stub.seen);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown> & { default_agent: string };
    expect(config).toEqual({
      default_agent: expect.stringMatching(new RegExp(`^${RUN_AGENT_PREFIX}-[0-9a-f]{16}$`)),
      model: 'openai/gpt-6.1',
      small_model: 'openai/gpt-6.1',
      shell: '/bin/sh',
      // A refused call ends that call, not the turn: the agent goes on with its work.
      experimental: { continue_loop_on_deny: true },
      agent: { [config.default_agent]: { mode: 'primary', description: expect.any(String), permission: { '*': 'ask' } } },
    });
    // A plugin runs inside the harness and can answer a permission request
    // before the driver does, so a run loads none of the machine's.
    expect(env.OPENCODE_PURE).toBe('1');
    expect(runAgentConfig('myco-run-x', 'win32')).not.toHaveProperty('shell');
  });

  /** A stub `cursor-agent` that copies the configuration directory it was pointed at, then exits. */
  function cursorRecorder(): { dir: string; seen: string; env: string } {
    const dir = mkdtempSync(join(tmpdir(), 'myco-stub-'));
    const seen = join(dir, 'seen');
    const env = join(dir, 'env.txt');
    writeFileSync(join(dir, 'cursor-agent'), `#!/bin/sh\nenv > ${JSON.stringify(env)}\ncp -R "$CURSOR_CONFIG_DIR" ${JSON.stringify(seen)}\n`, { mode: 0o755 });
    chmodSync(join(dir, 'cursor-agent'), 0o755);
    return { dir, seen, env };
  }

  /** The machine's own Cursor configuration directory, holding these files, named the way Cursor finds it. */
  function machineCursor(files: Record<string, string>): { dir: string; restore: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'myco-machine-cursor-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const before = process.env.CURSOR_CONFIG_DIR;
    process.env.CURSOR_CONFIG_DIR = dir;
    return { dir, restore: () => { if (before === undefined) delete process.env.CURSOR_CONFIG_DIR; else process.env.CURSOR_CONFIG_DIR = before; } };
  }

  it('starts Cursor over a configuration of the run\'s own that approves nothing in advance, and leaves the machine\'s untouched', async () => {
    const machineSettings = {
      permissions: { allow: ['Shell(ls)', 'Shell(git)', 'Mcp(myco:myco_plans)'], deny: ['Shell(rm)'] },
      approvalMode: 'unrestricted',
      autoAcceptWebSearch: true,
      model: { modelId: 'machine-model' },
      privacyCache: { ghostMode: true },
    };
    const machine = machineCursor({
      'cli-config.json': JSON.stringify(machineSettings),
      'permissions.json': JSON.stringify({ terminalAllowlist: ['git'], mcpAllowlist: ['myco:*'] }),
      'acp-config.json': JSON.stringify({ selectedModelVariantId: 'variant' }),
    });
    const stub = cursorRecorder();
    process.env.PATH = `${stub.dir}:${process.env.PATH ?? ''}`;
    try {
      const run = writeRunDir(mkdtempSync(join(tmpdir(), 'myco-run-')), 'run_1', CONNECTION);
      await collect(driverFor('cursor')!.run({ ...run, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
      expect(envOf(stub.env).CURSOR_CONFIG_DIR).toBe(join(run.scratchDir, 'cursor-home'));
      const seen = JSON.parse(readFileSync(join(stub.seen, 'cli-config.json'), 'utf8')) as Record<string, unknown>;
      // Nothing is approved in advance and nothing runs everything: every call
      // the agent makes is asked, and the run's grant answers it. A denial only
      // narrows a run, so the machine's are kept, as is every other setting.
      expect(seen).toEqual({
        ...machineSettings,
        permissions: { allow: [], deny: ['Shell(rm)'] },
        approvalMode: 'allowlist',
        autoAcceptWebSearch: false,
      });
      // Readable only by the worker's user, as the harness first finds it.
      const home = mkdtempSync(join(tmpdir(), 'myco-cursor-home-'));
      writeCursorRunHome(home, machine.dir);
      expect((statSync(join(home, 'cli-config.json')).mode & 0o777).toString(8)).toBe('600');
      // The second allowlist Cursor reads beside its settings is not carried.
      expect(readdirSync(stub.seen).sort()).toEqual(['acp-config.json', 'cli-config.json']);
      expect(JSON.parse(readFileSync(join(machine.dir, 'cli-config.json'), 'utf8'))).toEqual(machineSettings);
    } finally { machine.restore(); }
  });

  it('writes a Cursor run\'s settings even where the machine has none, since Cursor\'s own default allows a command', async () => {
    const machine = machineCursor({});
    const stub = cursorRecorder();
    process.env.PATH = `${stub.dir}:${process.env.PATH ?? ''}`;
    try {
      const run = writeRunDir(mkdtempSync(join(tmpdir(), 'myco-run-')), 'run_1', CONNECTION);
      await collect(driverFor('cursor')!.run({ ...run, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
      expect(JSON.parse(readFileSync(join(stub.seen, 'cli-config.json'), 'utf8'))).toEqual({
        permissions: { allow: [], deny: [] }, approvalMode: 'allowlist', autoAcceptWebSearch: false,
      });
    } finally { machine.restore(); }
  });

  it('refuses to start a harness that reads a configuration of the run\'s own when its driver writes none', async () => {
    const stub = cursorRecorder();
    process.env.PATH = `${stub.dir}:${process.env.PATH ?? ''}`;
    const run = writeRunDir(mkdtempSync(join(tmpdir(), 'myco-run-')), 'run_1', CONNECTION);
    const events = await collect(acpDriver('cursor').run({ ...run, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events).toEqual([{ kind: 'ended', stop: 'error', detail: 'no run configuration is written for cursor, so its own would decide the run\'s calls', code: 'launch_failed' }]);
    expect(existsSync(stub.env)).toBe(false);
  });

  it('names each OpenCode run\'s agent afresh, so no configuration the harness merges after the run\'s can define it', async () => {
    const stub = envRecorder('opencode');
    process.env.PATH = `${stub.dir}:${process.env.PATH ?? ''}`;
    const agentOf = async (): Promise<string> => {
      const run = writeRunDir(mkdtempSync(join(tmpdir(), 'myco-run-')), 'run_1', CONNECTION);
      await collect(acpDriver('opencode').run({ ...run, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
      return (JSON.parse(envOf(stub.seen).OPENCODE_CONFIG_CONTENT!) as { default_agent: string }).default_agent;
    };
    const first = await agentOf();
    const second = await agentOf();
    expect(first).not.toBe(second);
    expect([first, second]).not.toContain(RUN_AGENT_PREFIX);
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
    const asking = runAsking(harnessById('opencode'));
    const other = peerInMode('build');
    const sessions: string[] = [];
    const events = await collect(turnOver(other.channel, 'opencode', { ...run, prompt: 'do it', credentialEnv: {}, sessionOpened: (id) => { sessions.push(id); } }, () => '', listed, { asking }));
    expect(sessions).toEqual(['s']);
    expect(other.asked).toEqual(['initialize', 'session/new']);
    expect(events).toEqual([{ kind: 'ended', stop: 'error', detail: `the harness opened the session in mode build rather than the run's agent ${asking.mode!}, so its calls would not be asked`, code: 'session_unasked' }]);

    // An agent a configuration defines under the fixed part of the name is not the run's.
    const prefixed = peerInMode(RUN_AGENT_PREFIX);
    expect((await collect(turnOver(prefixed.channel, 'opencode', { ...run, prompt: 'do it', credentialEnv: {} }, () => '', listed, { asking }))).at(-1)?.kind).toBe('ended');
    expect(prefixed.asked).toEqual(['initialize', 'session/new']);

    const own = peerInMode(asking.mode!);
    expect((await collect(turnOver(own.channel, 'opencode', { ...run, prompt: 'do it', credentialEnv: {} }, () => '', listed, { asking }))).at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
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
    const peer = peerInMode('build');
    const started = Date.now();
    const events = await collect(turnOver(peer.channel, 'cursor', { ...run, prompt: 'do it', credentialEnv: {} }, () => '', waiting, { signal: stopping.signal }));
    // Stopped by the run, well before the listing's own timeout would end it.
    expect({ events, stoppedByRun: Date.now() - started < RUN_TOOLS_TIMEOUT_MS / 2 }).toEqual({
      events: [{ kind: 'ended', stop: 'error', detail: 'the run\'s tools could not be listed: the listing was stopped', code: 'tools_unlisted' }],
      stoppedByRun: true,
    });
  });
});
