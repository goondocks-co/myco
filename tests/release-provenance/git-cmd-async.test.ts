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
