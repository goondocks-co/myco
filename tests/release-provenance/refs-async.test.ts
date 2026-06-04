import { describe, it, expect } from 'bun:test';
import { resolveConfiguredRefs, resolveConfiguredRefsAsync } from '@myco/release-provenance/refs.js';

describe('resolveConfiguredRefsAsync', () => {
  it('matches the sync resolver for literal and wildcard refs', async () => {
    const root = process.cwd();
    const sync = resolveConfiguredRefs(root, ['HEAD', 'refs/heads/*']);
    const asyncRes = await resolveConfiguredRefsAsync(root, ['HEAD', 'refs/heads/*']);
    expect([...asyncRes].sort()).toEqual([...sync].sort());
  });

  it('returns literal refs unchanged and dedupes', async () => {
    const root = process.cwd();
    const res = await resolveConfiguredRefsAsync(root, ['HEAD', 'HEAD', '']);
    expect(res).toEqual(['HEAD']);
  });
});
