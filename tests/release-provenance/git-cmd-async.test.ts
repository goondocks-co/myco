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
});
