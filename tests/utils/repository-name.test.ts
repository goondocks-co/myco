import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repositoryName, repositoryRemote, __resetGitBinaryCacheForTest } from '@myco/utils/git.js';
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
