import { describe, expect, it } from 'bun:test';
import {
  filterRefsByPackagePatterns,
  pathMatchesGlob,
  tagPatternsForChangedPaths,
} from '@myco/release-provenance/package-map.js';

describe('pathMatchesGlob', () => {
  it('matches direct prefixes', () => {
    expect(pathMatchesGlob('packages/myco-team/worker.ts', 'packages/myco-team/')).toBe(true);
    expect(pathMatchesGlob('packages/myco/foo.ts', 'packages/myco-team/')).toBe(false);
  });

  it('treats trailing /* and /** as prefix wildcards', () => {
    expect(pathMatchesGlob('packages/myco-team/worker.ts', 'packages/myco-team/**')).toBe(true);
    expect(pathMatchesGlob('packages/myco-team/worker.ts', 'packages/myco-team/*')).toBe(true);
  });

  it('matches exact paths when glob has no trailing wildcard', () => {
    expect(pathMatchesGlob('README.md', 'README.md')).toBe(true);
    expect(pathMatchesGlob('README.mdx', 'README.md')).toBe(false);
  });
});

describe('tagPatternsForChangedPaths', () => {
  it('returns empty when no mappings configured', () => {
    expect(tagPatternsForChangedPaths(['packages/x.ts'], [])).toEqual([]);
  });

  it('returns empty when no paths match', () => {
    expect(tagPatternsForChangedPaths(
      ['packages/other/x.ts'],
      [{ path_glob: 'packages/myco-team/', tag_pattern: 'myco-team-v*' }],
    )).toEqual([]);
  });

  it('returns the matched tag patterns (deduplicated)', () => {
    const result = tagPatternsForChangedPaths(
      ['packages/myco-team/worker.ts', 'packages/myco-team/types.ts'],
      [{ path_glob: 'packages/myco-team/', tag_pattern: 'myco-team-v*' }],
    );
    expect(result).toEqual(['myco-team-v*']);
  });

  it('collects multiple patterns when paths span buckets', () => {
    const result = tagPatternsForChangedPaths(
      ['packages/myco-team/worker.ts', 'packages/myco-collective/index.ts'],
      [
        { path_glob: 'packages/myco-team/', tag_pattern: 'myco-team-v*' },
        { path_glob: 'packages/myco-collective/', tag_pattern: 'myco-collective-v*' },
      ],
    );
    expect(new Set(result)).toEqual(new Set(['myco-team-v*', 'myco-collective-v*']));
  });
});

describe('filterRefsByPackagePatterns', () => {
  it('keeps refs that match any pattern', () => {
    expect(filterRefsByPackagePatterns(
      ['v1.2.3', 'myco-team-v0.4.0', 'myco-collective-v0.1.0'],
      ['myco-team-v*'],
    )).toEqual(['myco-team-v0.4.0']);
  });

  it('falls back to the umbrella refs when no pattern matches', () => {
    expect(filterRefsByPackagePatterns(['v1.2.3'], ['myco-team-v*'])).toEqual(['v1.2.3']);
  });

  it('returns all refs when patterns list is empty', () => {
    expect(filterRefsByPackagePatterns(['v1.2.3', 'main'], [])).toEqual(['v1.2.3', 'main']);
  });
});
