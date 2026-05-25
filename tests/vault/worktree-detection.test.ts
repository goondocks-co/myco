/**
 * Tests for the worktree-detection helpers in `@myco/vault/resolve`.
 *
 * `isInsideWorktree` gates the worktree-bootstrap path: it only fires
 * when cwd is in a real git worktree, not in the main checkout or
 * outside git entirely.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isInsideWorktree,
  resolveMainRepoRoot,
  resolveWorktreeRoot,
} from '@myco/vault/resolve.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-worktree-')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# t\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

describe('isInsideWorktree', () => {
  it('returns false when cwd is the main checkout of a normal git repo', () => {
    initRepo(tmpDir);
    expect(isInsideWorktree(tmpDir)).toBe(false);
  });

  it('returns false when cwd is not inside a git repo at all', () => {
    expect(isInsideWorktree(tmpDir)).toBe(false);
  });

  it('returns true when cwd is inside a git worktree (not the main checkout)', () => {
    initRepo(tmpDir);
    const worktreePath = path.join(path.dirname(tmpDir), `${path.basename(tmpDir)}-wt`);
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'feature'], { cwd: tmpDir });
    try {
      expect(isInsideWorktree(worktreePath)).toBe(true);
      expect(resolveWorktreeRoot(worktreePath)).toBe(worktreePath);
      expect(resolveMainRepoRoot(worktreePath)).toBe(tmpDir);
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('returns false inside a subdirectory of the main checkout (worktree-looking-but-actually-main)', () => {
    initRepo(tmpDir);
    const sub = path.join(tmpDir, 'pkg', 'src');
    fs.mkdirSync(sub, { recursive: true });
    expect(isInsideWorktree(sub)).toBe(false);
  });
});
