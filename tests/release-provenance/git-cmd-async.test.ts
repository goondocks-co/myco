/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'bun:test';
import { runGit, runGitAsync, patchIdForCommit, patchIdForCommitAsync } from '@myco/release-provenance/git-cmd.js';

describe('runGitAsync parity', () => {
  it('matches runGit for a known repo command', async () => {
    const root = process.cwd();
    const sync = runGit(root, ['rev-parse', '--is-inside-work-tree']);
    const asyncRes = await runGitAsync(root, ['rev-parse', '--is-inside-work-tree']);
    expect(asyncRes.ok).toBe(sync.ok);
    expect(asyncRes.stdout).toBe(sync.stdout);
  });

  it('captures failure shape (ok:false, stderr) without throwing', async () => {
    const res = await runGitAsync(process.cwd(), ['not-a-real-subcommand']);
    expect(res.ok).toBe(false);
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  it('patchIdForCommitAsync matches sync for HEAD (stdin path via patch-id)', async () => {
    const root = process.cwd();
    const head = (await runGitAsync(root, ['rev-parse', 'HEAD'])).stdout;
    const sync = patchIdForCommit(root, head);
    const asyncId = await patchIdForCommitAsync(root, head);
    expect(asyncId).toBe(sync);
  });

  // Regression: execFileSync caps stdout at 1 MiB by default and throws
  // ENOBUFS beyond it, so runGit silently returned ok:false (→ null patch-id)
  // for any commit whose `git show` patch exceeds 1 MiB, while the spawn-based
  // runGitAsync read it fine. That asymmetry surfaced as a CI-only failure of
  // the HEAD parity test above (a PR merge commit's patch exceeds 1 MiB) and,
  // more importantly, silently dropped capture-time provenance for large
  // commits. runGit must read large output at parity with runGitAsync.
  it('runGit reads >1 MiB output at parity with runGitAsync (large-commit capture)', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-gitcmd-bigdiff-'));
    try {
      const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });
      git(['init', '-q']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test User']);
      // ~2 MiB single-commit diff — comfortably over execFileSync's 1 MiB default.
      const big = Array.from({ length: 40_000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
      fs.writeFileSync(path.join(repo, 'big.txt'), `${big}\n`, 'utf-8');
      git(['add', 'big.txt']);
      git(['commit', '-qm', 'big commit']);
      const head = git(['rev-parse', 'HEAD']).trim();

      const show = runGit(repo, ['show', '--format=', '--patch', head]);
      expect(show.ok).toBe(true);
      expect(show.stdout.length).toBeGreaterThan(1024 * 1024);

      const sync = patchIdForCommit(repo, head);
      const asyncId = await patchIdForCommitAsync(repo, head);
      expect(sync).not.toBeNull();
      expect(asyncId).toBe(sync);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
