/**
 * Bun's `execFileSync` drops a child's stdout under heavy load: the child
 * prints and exits 0, and the call returns an empty string without throwing
 * (oven-sh/bun#34069). The loss is all or nothing. A git query that always
 * prints must not take that empty string as its answer:
 *
 * - an empty `--git-common-dir` resolved a joined checkout's project root to
 *   its parent, and a hook run from a subdirectory or a linked worktree, whose
 *   cwd fallback is not the root, found no membership and captured nothing;
 * - an empty `--show-toplevel` sent a hook's plan paths to the process cwd;
 * - an empty branch, HEAD or remote dropped a session's git facts, and an
 *   empty `status --porcelain` read a dirty tree as clean;
 * - an empty `--git-dir` put the installer's exclude file in the project root.
 *
 * The `git` on PATH here (`helpers/lost-git.ts`) is the real one, whose stdout
 * the test drops for the invocations it arms.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { membershipProblem } from '@myco/cli/deployment-reader.js';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { resolveCredential, resolveMemberProjectRoot } from '@myco/member/credential.js';
import { gitFacts } from '@myco/member/git-facts.js';
import { unmemberedDir } from '@myco/member/no-membership.js';
import { planRootFor } from '@myco/member/plan-files.js';
import { isSafeProjectRoot, resolveWorktreeRoot } from '@myco/project-root.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { findGitBinary } from '@myco/utils/git.js';
import { registerTestMember } from './helpers/hooks.js';
import { installLostGit, type LostGit } from './helpers/lost-git.js';
import { tempMycoHome } from './helpers/server.js';

const PKG_ROOT = path.resolve(__dirname, '..', '..', 'packages', 'myco');

let git: LostGit;
let mycoHome: string;
let checkout: string;
const saved = { projectRoot: process.env.MYCO_PROJECT_ROOT, vaultDir: process.env.MYCO_VAULT_DIR, home: process.env.HOME, mycoHome: process.env.MYCO_HOME };
const stderrLines: string[] = [];
const origErr = process.stderr.write.bind(process.stderr);

const tempDir = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const realGit = (args: string[], cwd: string): string => execFileSync(git.realGit, args, { cwd, encoding: 'utf-8' });
const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

/** One commit on `checkout`, so it has a HEAD and can hold a linked worktree. */
function commitOnce(): void {
  fs.writeFileSync(path.join(checkout, 'README.md'), 'one\n');
  realGit(['add', 'README.md'], checkout);
  realGit([...IDENTITY, 'commit', '-q', '-m', 'one'], checkout);
}

/** A linked worktree of `checkout`, outside it. */
function linkedWorktree(): string {
  commitOnce();
  const worktree = path.join(tempDir('myco-lost-git-wt-'), 'wt');
  realGit(['worktree', 'add', '-q', worktree], checkout);
  return worktree;
}

/** A capture hook's registry credential, resolved from `cwd`. */
function hookCredential(cwd: string) {
  registerTestMember({ mycoHome, token: 'mt_tok', projectId: 'proj_1', root: checkout });
  return resolveCredential('registry', { cwd, mycoHome, invokedBy: 'hook stop' });
}

const expectNoMissedCapture = (): void => {
  expect(stderrLines.join('')).not.toContain('no registry entry');
  expect(fs.existsSync(unmemberedDir(mycoHome))).toBe(false);
};

beforeEach(() => {
  git = installLostGit();
  delete process.env.MYCO_PROJECT_ROOT;
  delete process.env.MYCO_VAULT_DIR;
  mycoHome = tempMycoHome();
  checkout = tempDir('myco-lost-git-checkout-');
  realGit(['init', '-q', checkout], checkout);
  // A repository whose config includes another is one the member reads by asking git, not from git's own files
  // (`utils/git-files.ts`): what is tested here is that git path. The included file need not exist.
  realGit(['config', 'include.path', 'absent.gitconfig'], checkout);
  stderrLines.length = 0;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = ((c: unknown) => { stderrLines.push(String(c)); return true; }) as never;
});
afterEach(() => {
  (process.stderr as unknown as { write: unknown }).write = origErr;
  git.restore();
  for (const [key, value] of [['MYCO_PROJECT_ROOT', saved.projectRoot], ['MYCO_VAULT_DIR', saved.vaultDir], ['HOME', saved.home], ['MYCO_HOME', saved.mycoHome]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('a git stdout lost in transit', () => {
  it('the git on PATH runs, and its stdout is what is lost', () => {
    git.loseNext(1);
    expect(execFileSync(findGitBinary(), ['rev-parse', '--git-common-dir'], { cwd: checkout, encoding: 'utf-8' })).toBe('');
    expect(execFileSync(findGitBinary(), ['rev-parse', '--git-common-dir'], { cwd: checkout, encoding: 'utf-8' }).trim()).toBe('.git');
    git.loseNext(1);
    expect(() => execFileSync(findGitBinary(), ['rev-parse', 'no-such-ref'], { cwd: checkout, stdio: 'pipe' })).toThrow();
  });

  it('does not move the project root to the checkout\'s parent', () => {
    git.loseNext(1);
    expect(resolveMemberProjectRoot(checkout)).toBe(checkout);
    expect(git.armsLeft()).toBe(0);
  });

  it('never reads a joined checkout\'s membership as missing', () => {
    registerTestMember({ mycoHome, token: 'mt_tok', projectId: 'proj_1', root: checkout });
    git.loseNext(1);
    expect(membershipProblem({ cwd: checkout, mycoHome })).toBeNull();
    expect(git.armsLeft()).toBe(0);
  });

  it('resolves a capture hook\'s registry credential from the checkout and records no missed capture', () => {
    git.loseNext(1);
    const credential = hookCredential(checkout);
    expect(credential?.root).toBe(checkout);
    expect(credential?.projectId).toBe('proj_1');
    expectNoMissedCapture();
  });

  it('resolves a capture hook\'s registry credential from a subdirectory and records no missed capture', () => {
    const sub = path.join(checkout, 'pkg', 'src');
    fs.mkdirSync(sub, { recursive: true });
    git.loseNext(1, '--git-common-dir');
    const credential = hookCredential(sub);
    expect(git.armsLeft()).toBe(0);
    expect(credential?.root).toBe(checkout);
    expectNoMissedCapture();
  });

  it('resolves a capture hook\'s registry credential from a linked worktree and records no missed capture', () => {
    const worktree = linkedWorktree();
    git.loseNext(1, '--git-common-dir');
    const credential = hookCredential(worktree);
    expect(git.armsLeft()).toBe(0);
    expect(credential?.root).toBe(checkout);
    expectNoMissedCapture();
  });

  it('keeps a real checkout a safe project root', () => {
    git.loseNext(1);
    expect(isSafeProjectRoot(checkout)).toBe(true);
  });

  it('falls back as it does for git failing when git never answers, and never to the parent', () => {
    const sub = path.join(checkout, 'pkg');
    fs.mkdirSync(sub);
    git.loseNext(1_000);
    expect(resolveMemberProjectRoot(sub)).toBe(sub);
    git.loseNext(0);
    expect(resolveMemberProjectRoot(sub)).toBe(checkout);
  });

  it('roots a linked worktree\'s plan paths at the worktree, never at an empty path', () => {
    const worktree = linkedWorktree();
    git.loseNext(1, '--show-toplevel');
    expect(resolveWorktreeRoot(worktree)).toBe(worktree);
    git.loseNext(1, '--show-toplevel');
    expect(planRootFor(checkout, worktree)).toBe(worktree);
    expect(git.armsLeft()).toBe(0);
  });

  it('keeps every git fact a session carries when one answer is lost', async () => {
    commitOnce();
    realGit(['remote', 'add', 'origin', 'https://example.com/team/repo.git'], checkout);
    const facts = await gitFacts(checkout);
    expect(facts).toEqual({ branch: expect.any(String), remote: 'https://example.com/team/repo.git', headSha: expect.stringMatching(/^[0-9a-f]{40}$/), dirty: false });
    for (const query of ['rev-parse --abbrev-ref HEAD', 'rev-parse HEAD', 'remote get-url origin']) {
      git.loseNext(1, query);
      expect({ query, facts: await gitFacts(checkout) }).toEqual({ query, facts });
      expect(git.armsLeft()).toBe(0);
    }
  });

  it('never reads a dirty tree as clean when git\'s output is lost', async () => {
    commitOnce();
    fs.writeFileSync(path.join(checkout, 'README.md'), 'two\n');
    for (const query of ['status', 'diff']) {
      git.loseNext(1_000, query);
      expect({ query, dirty: (await gitFacts(checkout)).dirty }).toEqual({ query, dirty: true });
    }
    git.loseNext(1_000);
    expect(await gitFacts(checkout)).toEqual({});
  });

  it('puts the installer\'s git exclude entry in the repository\'s git dir, never the project root', () => {
    const home = tempDir('myco-lost-git-home-');
    process.env.HOME = home;
    process.env.MYCO_HOME = mycoHome;
    resetMachineIdCache();
    const excludes = path.join(checkout, '.git', 'empty-excludes');
    fs.writeFileSync(excludes, '');
    realGit(['config', 'core.excludesFile', excludes], checkout);
    const claudeCode = loadManifests().find((m) => m.name === 'claude-code')!;
    git.loseNext(1, 'rev-parse --git-dir');
    new SymbiontInstaller(claudeCode, checkout, PKG_ROOT, false, undefined, null, 'member-project').install();
    expect(git.armsLeft()).toBe(0);
    expect(fs.readFileSync(path.join(checkout, '.git', 'info', 'exclude'), 'utf-8').split('\n')).toContain('.claude/settings.local.json');
    expect(fs.existsSync(path.join(checkout, 'info'))).toBe(false);
    resetMachineIdCache();
  });
});

describe('a session\'s dirty fact', () => {
  /** What the check it replaces said: any tracked change against HEAD, staged or not; untracked files not counted. */
  const porcelainDirty = (): boolean => realGit(['status', '--porcelain', '--untracked-files=no'], checkout).length > 0;
  const expectAgrees = async (label: string, dirty: boolean): Promise<void> => {
    expect({ label, dirty: (await gitFacts(checkout)).dirty, porcelain: porcelainDirty() }).toEqual({ label, dirty, porcelain: dirty });
  };

  it('says what `status --porcelain --untracked-files=no` said, for every kind of change', async () => {
    commitOnce();
    const file = path.join(checkout, 'README.md');
    await expectAgrees('clean', false);
    fs.writeFileSync(path.join(checkout, 'new.txt'), 'untracked\n');
    await expectAgrees('untracked only', false);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    await expectAgrees('touched, same content', false);
    fs.writeFileSync(file, 'two\n');
    await expectAgrees('unstaged change', true);
    realGit(['add', 'README.md'], checkout);
    await expectAgrees('staged change', true);
    fs.writeFileSync(file, 'one\n');
    await expectAgrees('staged change the working tree undoes', true);
    realGit(['add', 'README.md'], checkout);
    await expectAgrees('back to HEAD', false);
    fs.rmSync(file);
    await expectAgrees('tracked file deleted', true);
  });

  it('is unknown where git cannot say', async () => {
    commitOnce();
    fs.writeFileSync(path.join(checkout, '.git', 'index'), 'not an index');
    expect((await gitFacts(checkout)).dirty).toBeUndefined();
  });
});
