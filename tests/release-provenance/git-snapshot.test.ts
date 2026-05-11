import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { captureGitSnapshot } from '@myco/release-provenance/git-snapshot.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-release-git-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n', 'utf-8');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-qm', 'initial']);
  return repo;
}

describe('captureGitSnapshot', () => {
  it('captures branch, head, dirty counts, tracked blobs, and patch IDs', () => {
    const repo = makeRepo();
    try {
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\n', 'utf-8');
      fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n', 'utf-8');

      const snapshot = captureGitSnapshot(repo);

      expect(snapshot.is_git_repository).toBe(true);
      expect(snapshot.branch).toBeTruthy();
      expect(snapshot.head_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(snapshot.is_dirty).toBe(true);
      expect(snapshot.staged_count).toBe(0);
      expect(snapshot.unstaged_count).toBe(1);
      expect(snapshot.untracked_count).toBe(1);
      expect(snapshot.changed_paths).toEqual(['tracked.txt', 'untracked.txt']);
      expect(snapshot.tracked_blob_hashes['tracked.txt']).toMatch(/^[0-9a-f]{40}$/);
      expect(snapshot.patch_ids).toEqual([
        expect.objectContaining({ kind: 'unstaged', patch_id: expect.stringMatching(/^[0-9a-f]{40}$/) }),
      ]);
      expect(snapshot.status_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshot.error).toBeNull();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns soft-fail evidence outside a Git repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-release-nongit-'));
    try {
      const snapshot = captureGitSnapshot(dir);

      expect(snapshot.is_git_repository).toBe(false);
      expect(snapshot.error).toBe('not_git_repository');
      expect(snapshot.changed_paths).toEqual([]);
      expect(snapshot.status_hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
