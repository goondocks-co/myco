/**
 * What git a hook starts (#1561): a repository's identity (its root, branch and commit) is read from git's own files,
 * so a hook's own work starts no git process but at a session's end, which asks git the two questions of whether
 * tracked files changed, at once. Each git process costs 5 to 20 ms on a hook someone is waiting for.
 *
 * A hook that delivers in itself (a sandbox's turn and session ends, `--credential env`) also runs the helper's pass,
 * which asks git for the repository remote the start's context ask carries: that is the only other git it starts.
 *
 * Call-selection probes complete async Git questions on microtasks. Real-process checks observe optional enrichment
 * through the spool, where an exhausted budget leaves dirty absent.
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
import crypto from 'node:crypto';
import { REPO_ROOT } from '../helpers/import-closure.ts';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.ts';
import { resolveCredential } from '@myco/member/credential.js';
import { readRegistryEntry, registryEntryPath, projectsDir } from '@myco/member/registry.js';
import { transcriptPlacer } from '@myco/symbionts/transcript-attribution.js';
import { MemberSpool } from '@myco/member/spool.js';
import { registerTestMember, runHook } from './helpers/hooks.js';
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

const DIRTY_QUERIES = ['diff --cached --quiet --', 'diff --quiet --'];
const EXPIRED_HOOK_ELAPSED_MS = 60_000;
interface ProbeEvent { args: string[]; phase: 'start' | 'end' }
function probeEvents(log: string): ProbeEvent[] {
  return fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function expectConcurrentDirtyQuestions(log: string): void {
  const events = probeEvents(log).filter((event) => event.args[0] === 'diff');
  expect(events.map((event) => event.phase)).toEqual(['start', 'start', 'end', 'end']);
  expect(events.slice(0, 2).map((event) => event.args.join(' ')).sort()).toEqual(DIRTY_QUERIES);
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
    const headSha = execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    const shim = path.join(dir, 'bin');
    fs.mkdirSync(shim);
    const log = path.join(dir, 'git.log');
    loggingGit(shim, log);
    const probe = path.join(dir, 'probe.jsonl');

    const mycoHome = tempMycoHome();
    registerTestMember({ mycoHome, token: 'mt_tok', projectId: 'proj_1', root: repo });
    const tx = path.join(dir, 'sess-git.jsonl');
    fs.writeFileSync(tx, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
    const calls = (hook: string, extra: Record<string, unknown> = {}, source: 'registry' | 'env' = 'registry'): string[] => {
      fs.writeFileSync(log, '');
      fs.writeFileSync(probe, '');
      const credential = source === 'env' ? { MYCO_SERVER_URL: 'https://member-test.invalid', MYCO_MEMBER_TOKEN: 'mt_tok', MYCO_PROJECT: 'proj_1' } : {};
      const result = spawnSync(process.execPath, [HOOK_PROCESS, hook, '--symbiont', 'claude-code', '--credential', source], {
        cwd: repo,
        env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}`, MYCO_HOME: mycoHome, ...credential, MYCO_TEST_REFUSE_FETCH: '1', MYCO_TEST_KICK_LOG: path.join(dir, 'kick.log'), MYCO_TEST_GIT_PROBE: probe, MYCO_TEST_REAL_GIT: realGit },
        input: JSON.stringify({ session_id: 'sess-git', transcript_path: tx, cwd: repo, prompt: 'p', last_assistant_message: 'x', ...extra }),
        encoding: 'utf-8', timeout: 20_000,
      });
      expect({ hook, status: result.status }).toEqual({ hook, status: 0 });
      if (hook === 'session-end') {
        const entry = readRegistryEntry(repo, mycoHome)!;
        const sessionId = typeof extra.session_id === 'string' ? extra.session_id : 'sess-git';
        const ended = new MemberSpool(entry, { mycoHome }).readRecords(sessionId).filter((record) => record?.kind === 'session.end');
        expect(ended.at(-1)?.payload).toMatchObject({ headSha, dirty: false });
      }
      return probeEvents(probe).filter((event) => event.phase === 'start').map((event) => event.args.join(' '));
    };

    expect(calls('session-start', { hook_event_name: 'SessionStart' })).toEqual([]);
    expect(calls('user-prompt-submit', { hook_event_name: 'UserPromptSubmit' })).toEqual([]);
    expect(calls('stop', { hook_event_name: 'Stop' })).toEqual([]);
    expect(calls('session-end', { hook_event_name: 'SessionEnd' }).sort()).toEqual(['diff --cached --quiet --', 'diff --quiet --']);
    expectConcurrentDirtyQuestions(probe);

    // A sandbox: its ends run the helper's pass in the hook, which asks git for the remote the start's ask carries.
    const remote = 'remote get-url origin';
    const env = { session_id: 'sess-git-env' };
    expect(calls('session-start', { ...env, hook_event_name: 'SessionStart' }, 'env')).toEqual([]);
    expect(calls('user-prompt-submit', { ...env, hook_event_name: 'UserPromptSubmit' }, 'env')).toEqual([]);
    expect(calls('stop', { ...env, hook_event_name: 'Stop' }, 'env').filter((c) => c !== remote)).toEqual([]);
    expect(calls('session-end', { ...env, hook_event_name: 'SessionEnd' }, 'env').filter((c) => c !== remote).sort()).toEqual(['diff --cached --quiet --', 'diff --quiet --']);
    expectConcurrentDirtyQuestions(probe);

    for (const source of ['registry', 'env'] as const) for (const expired of [false, true]) {
      fs.writeFileSync(log, '');
      const sessionId = `sess-real-${source}-${expired}`;
      const result = spawnSync(process.execPath, [HOOK_PROCESS, 'session-end', '--symbiont', 'claude-code', '--credential', source], {
        cwd: repo,
        env: {
          ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}`, MYCO_HOME: mycoHome,
          ...(source === 'env' ? { MYCO_SERVER_URL: 'https://member-test.invalid', MYCO_MEMBER_TOKEN: 'mt_tok', MYCO_PROJECT: 'proj_1' } : {}),
          MYCO_TEST_REFUSE_FETCH: '1', MYCO_TEST_KICK_LOG: path.join(dir, 'kick.log'),
          ...(expired ? { MYCO_TEST_HOOK_ELAPSED_MS: String(EXPIRED_HOOK_ELAPSED_MS) } : {}),
        },
        input: JSON.stringify({ session_id: sessionId, cwd: repo, hook_event_name: 'SessionEnd' }),
        encoding: 'utf-8', timeout: 20_000,
      });
      expect({ source, status: result.status }).toEqual({ source, status: 0 });
      const entry = readRegistryEntry(repo, mycoHome)!;
      const records = new MemberSpool(entry, { mycoHome }).readRecords(sessionId).filter((record) => record?.kind === 'session.end');
      expect(records.length).toBeGreaterThan(0);
      const facts = records.at(-1)!.payload;
      const observed = fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).filter((call) => call !== remote);
      expect(observed.every((call) => DIRTY_QUERIES.includes(call))).toBe(true);
      if (facts.dirty === undefined) {
        // An unenriched session.end carries no dirty verdict.
        expect(facts.headSha === undefined || facts.headSha === headSha).toBe(true);
        if (expired) {
          expect(facts.headSha).toBeUndefined();
          expect(observed).toEqual([]);
          console.info(`[hook-git-calls] forced expired budget: ${source}`);
        } else console.info(`[hook-git-calls] skipped under budget: ${source}`);
      } else {
        expect(expired).toBe(false);
        expect(facts).toMatchObject({ headSha, dirty: false });
        expect(observed.sort()).toEqual(DIRTY_QUERIES);
        console.info(`[hook-git-calls] enriched: ${source}`);
      }
    }
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
/** What git is asked once for a verdict: the verdict, and where its system config lives (`--exec-path` before git 2.42). */
const VERDICT_QUERIES = [VERDICT_QUERY, 'var GIT_CONFIG_SYSTEM', '--exec-path'];
const HEAD_QUERIES = ['rev-parse --abbrev-ref HEAD', 'rev-parse HEAD'];

describe.skipIf(realGit === '')('the git a second hook in a repository starts', () => {
  const dir = removeWhenTestsEnd(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hook-verdict-'))));
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'git.log');
  const probe = path.join(dir, 'probe.jsonl');

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
    fs.writeFileSync(tx, `${JSON.stringify({ type: 'user', cwd: repo, message: { role: 'user', content: 'hi' } })}\n`);
    const invoke = (hook: string, event: string): string[] => {
      fs.writeFileSync(log, '');
      fs.writeFileSync(probe, '');
      const result = spawnSync(process.execPath, [HOOK_PROCESS, hook, '--symbiont', 'claude-code', '--credential', 'registry'], {
        cwd: repo,
        env: { ...withPathFirst(bin), MYCO_HOME: mycoHome, MYCO_TEST_REFUSE_FETCH: '1', MYCO_TEST_KICK_LOG: path.join(dir, 'kick.log'), MYCO_TEST_GIT_PROBE: probe, MYCO_TEST_REAL_GIT: realGit },
        input: JSON.stringify({ session_id: `sess-${name}`, transcript_path: tx, cwd: repo, prompt: 'p', last_assistant_message: 'x', hook_event_name: event }),
        encoding: 'utf-8', timeout: 20_000,
      });
      expect({ hook, status: result.status }).toEqual({ hook, status: 0 });
      // Git-call accounting requires a bound hook whose session start actually reached the spool.
      const entry = readRegistryEntry(repo, mycoHome);
      expect(entry?.projectId).toBe('proj_1');
      expect(transcriptPlacer([repo])('claude-code', tx)).toEqual({ kind: 'bound', root: repo });
      const credential = resolveCredential('registry', { cwd: repo, mycoHome });
      const spool = new MemberSpool(entry!, { mycoHome });
      expect({
        project: credential?.projectId,
        captured: spool.readRecords(`sess-${name}`).some((record) => record?.kind === 'session.start'),
        stderr: result.stderr,
      }).toEqual({ project: 'proj_1', captured: true, stderr: '' });
      return probeEvents(probe).filter((event) => event.phase === 'start').map((event) => event.args.join(' '));
    };
    return Object.assign(invoke, { repo, mycoHome, tx });
  }

  it('is none: what the first asked of git is kept', () => {
    loggingGit(bin, log);
    const calls = joinedRepo('plain');
    const first = calls('session-start', 'SessionStart');
    // Windows requires Git's ownership verdict once; confirmed HEAD facts come from the files.
    if (process.platform === 'win32') {
      expect(first).toContain(VERDICT_QUERY);
      expect(first.filter((call) => !VERDICT_QUERIES.includes(call))).toEqual([]);
    } else {
      expect(first).toEqual([]);
    }
    expect(calls('session-start', 'SessionStart')).toEqual([]);
    expect(calls('user-prompt-submit', 'UserPromptSubmit')).toEqual([]);
    expect(calls('stop', 'Stop')).toEqual([]);
  }, 120_000);

  it('migrates a literal binding and captures when native realpath expands a checkout spelling', async () => {
    const fixture = joinedRepo('native-expanded', [['extensions.worktreeConfig', 'true']]);
    const alias = path.join(dir, 'expanded-name');
    fs.symlinkSync(fixture.repo, alias, 'junction');
    const current = registryEntryPath(fixture.repo, fixture.mycoHome);
    const binding = JSON.parse(fs.readFileSync(current, 'utf8'));
    binding.root = fixture.repo;
    delete binding.displayRoot;
    const legacyKey = crypto.createHash('sha256').update(path.resolve(fixture.repo)).digest('hex').slice(0, 16);
    const legacy = path.join(projectsDir(fixture.mycoHome), legacyKey + '.json');
    fs.writeFileSync(legacy, JSON.stringify(binding), { mode: 0o600 });
    if (current !== legacy) fs.unlinkSync(current);
    const native = fs.realpathSync.native;
    const savedHome = process.env.MYCO_HOME;
    // Native realpath expands the literal root to an idempotent long-name spelling.
    Object.defineProperty(fs.realpathSync, 'native', { value: (file: fs.PathLike, ...options: unknown[]) => {
      if (typeof file === 'string' && (file.toLowerCase() === fixture.repo.toLowerCase() || file.toLowerCase().startsWith(`${fixture.repo.toLowerCase()}${path.sep}`))) {
        return alias + file.slice(fixture.repo.length);
      }
      if (typeof file === 'string' && (file.toLowerCase() === alias.toLowerCase() || file.toLowerCase().startsWith(`${alias.toLowerCase()}${path.sep}`))) return file;
      return Reflect.apply(native, fs.realpathSync, [file, ...options]);
    } });
    process.env.MYCO_HOME = fixture.mycoHome;
    try {
      const result = await runHook('session-start', {
        session_id: 'sess-native-expanded', cwd: fixture.repo, transcript_path: fixture.tx, hook_event_name: 'SessionStart',
      }, { fetch: async () => { throw new Error('ECONNREFUSED'); } });
      const entry = readRegistryEntry(fixture.repo, fixture.mycoHome);
      expect(entry?.projectId).toBe('proj_1');
      const spool = new MemberSpool(entry!, { mycoHome: fixture.mycoHome });
      expect({
        credential: resolveCredential('registry', { cwd: fixture.repo, mycoHome: fixture.mycoHome })?.projectId,
        captured: spool.readRecords('sess-native-expanded').some((record) => record?.kind === 'session.start'),
        stderr: result.stderr,
      }).toEqual({ credential: 'proj_1', captured: true, stderr: '' });
      expect(transcriptPlacer([fixture.repo])('claude-code', fixture.tx)).toEqual({ kind: 'bound', root: fixture.repo });
    } finally {
      Object.defineProperty(fs.realpathSync, 'native', { value: native });
      if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
    }
  });

  it('is only where HEAD stands, for a repository whose config only git reads', () => {
    if (!fs.existsSync(bin)) loggingGit(bin, log);
    const calls = joinedRepo('worktree-config', [['extensions.worktreeConfig', 'true']]);
    const first = calls('session-start', 'SessionStart');
    // Per-worktree config leaves HEAD interpretation to Git on every platform.
    expect(first).toContain(VERDICT_QUERY);
    expect(first.filter((call) => !VERDICT_QUERIES.includes(call)).sort()).toEqual(HEAD_QUERIES);
    expect(calls('session-start', 'SessionStart').sort()).toEqual(HEAD_QUERIES);
    expect(calls('user-prompt-submit', 'UserPromptSubmit')).toEqual([]);
    expect(calls('stop', 'Stop')).toEqual([]);
  }, 120_000);
});
