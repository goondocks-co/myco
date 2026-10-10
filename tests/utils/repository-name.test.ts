import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionRepositoryName } from '@myco/member/git-facts.js';
import { resolveHookBudget } from '@myco/member/budget.js';
import { repositoryName, repositoryRemote, memoizedRepositoryName, __resetGitBinaryCacheForTest } from '@myco/utils/git.js';
import { repositoryAt } from '@myco/member/auto-join.js';

const roots: string[] = [];
const fixture = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-repository-name-')));
  roots.push(root);
  return root;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('repository display name', () => {
  it('uses the main checkout for linked worktrees and their subdirectories, including auto-join labels', () => {
    const base = fixture();
    const main = path.join(base, 'whisker-sites');
    const linked = path.join(base, 'w9-task-5-terraform-alerts');
    fs.mkdirSync(main);
    git(main, 'init', '-q');
    git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
    git(main, 'remote', 'add', 'origin', 'https://example.invalid/acme/different-remote.git');
    git(main, 'worktree', 'add', '-qb', 'worker', linked);
    const nested = path.join(linked, 'src');
    fs.mkdirSync(nested);
    expect([main, linked, nested].map((root) => repositoryName(root))).toEqual(['whisker-sites', 'whisker-sites', 'whisker-sites']);
    expect(repositoryAt(linked, path.join(base, 'home')).label).toBe('whisker-sites');
  });

  it('walks missing session paths to their existing repository ancestor', () => {
    const root = fixture();
    git(root, 'init', '-q');
    expect(repositoryName(path.join(root, 'removed-worktree', 'src'))).toBe(path.basename(root));
  });

  it('uses the real main checkout name through a symlink on the hook path', () => {
    const base = fixture();
    const main = path.join(base, 'whisker-sites');
    const link = path.join(base, 'linkroot');
    fs.mkdirSync(main);
    git(main, 'init', '-q');
    fs.symlinkSync(main, link, 'dir');
    expect(repositoryName(link)).toBe('whisker-sites');
    expect(sessionRepositoryName(link, resolveHookBudget('claude-code', 'session-start', { startedAt: Date.now() }))).toBe('whisker-sites');
  });

  it('names a bare repository through its linked worktree without a remote', () => {
    const base = fixture();
    const main = path.join(base, 'whisker-sites.git');
    const linked = path.join(base, 'worker-folder');
    git(base, 'init', '--bare', '-q', main);
    git(base, 'clone', '-q', main, linked);
    git(linked, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
    git(linked, 'push', '-q', 'origin', 'HEAD');
    fs.rmSync(linked, { recursive: true, force: true });
    git(main, 'worktree', 'add', '-q', linked);
    expect(repositoryName(linked)).toBe('whisker-sites');
  });

  it('uses core.worktree for separate metadata and memoizes names within an import', () => {
    const base = fixture();
    const main = path.join(base, 'whisker-sites');
    const metadata = path.join(base, 'metadata');
    fs.mkdirSync(main);
    git(main, 'init', '-q', '--separate-git-dir', metadata);
    git(main, 'config', 'core.worktree', main);
    const names = new Map<string, string>();
    expect(memoizedRepositoryName(main, names)).toBe('whisker-sites');
    git(main, 'config', 'core.worktree', path.join(base, 'renamed'));
    expect(memoizedRepositoryName(main, names)).toBe('whisker-sites');
    expect(names.size).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('falls back within the caller deadline when Git stalls', () => {
    const base = fixture();
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o755 });
    const heldPath = process.env.PATH;
    const began = Date.now();
    try {
      process.env.PATH = bin;
      __resetGitBinaryCacheForTest();
      expect(repositoryName(base, { deadline: began + 100 })).toBe(path.basename(base));
      expect(Date.now() - began).toBeLessThan(2_000);
    } finally {
      process.env.PATH = heldPath;
      __resetGitBinaryCacheForTest();
    }
  });

  it('uses the remote repository when the common directory is not .git, then the root when Git is unavailable', () => {
    const base = fixture();
    const root = path.join(base, 'worker-folder');
    fs.mkdirSync(root);
    git(root, 'init', '-q', '--separate-git-dir', path.join(base, 'metadata'));
    git(root, 'remote', 'add', 'upstream', 'git@example.invalid:acme/whisker-sites.git');
    expect(repositoryRemote(root)).toBe('example.invalid/acme/whisker-sites');
    expect(repositoryName(root)).toBe('whisker-sites');
    git(root, 'remote', 'remove', 'upstream');
    expect(repositoryName(root)).toBe('worker-folder');
    expect(repositoryName(path.join(base, 'unavailable'))).toBe('unavailable');
  });
});
