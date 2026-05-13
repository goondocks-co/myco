import { describe, it, expect } from 'bun:test';
import { parseGitStatus } from '../../packages/myco/src/daemon/api/git-status';

describe('parseGitStatus', () => {
  it('parses a clean branch with upstream and tracking info', () => {
    const out = [
      '# branch.oid abc123def456',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
      '',
    ].join('\n');
    const result = parseGitStatus(out);
    expect(result.branch).toBe('main');
    expect(result.head_sha).toBe('abc123def456');
    expect(result.dirty).toBe(false);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
  });

  it('parses a dirty branch with ahead/behind', () => {
    const out = [
      '# branch.oid 0123456789ab',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +3 -1',
      '1 .M N... 100644 100644 100644 abc def src/foo.ts',
      '? src/unknown.ts',
    ].join('\n');
    const result = parseGitStatus(out);
    expect(result.branch).toBe('feature/x');
    expect(result.dirty).toBe(true);
    expect(result.ahead).toBe(3);
    expect(result.behind).toBe(1);
  });

  it('handles a branch with no upstream', () => {
    const out = [
      '# branch.oid 9876543210fe',
      '# branch.head local-only',
      '',
    ].join('\n');
    const result = parseGitStatus(out);
    expect(result.branch).toBe('local-only');
    expect(result.dirty).toBe(false);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
  });

  it('handles detached HEAD', () => {
    const out = [
      '# branch.oid deadbeefcafe',
      '# branch.head (detached)',
      '',
    ].join('\n');
    const result = parseGitStatus(out);
    expect(result.branch).toBe('(detached)');
    expect(result.head_sha).toBe('deadbeefcafe');
  });
});
