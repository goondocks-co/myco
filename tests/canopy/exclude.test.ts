import { describe, it, expect } from 'bun:test';
import { isExcluded } from '@myco/canopy/exclude';
import { MycoConfigSchema } from '@myco/config/schema';

// Source the default pattern list from the live schema so this test fails if
// the defaults drift, instead of silently exercising a stale copy.
const DEFAULT_PATTERNS = MycoConfigSchema.parse({ version: 3 }).canopy.exclude.patterns;

describe('isExcluded (default patterns)', () => {
  it('excludes node_modules at any depth', () => {
    expect(isExcluded('node_modules/foo/index.js', DEFAULT_PATTERNS)).toBe(true);
    expect(isExcluded('packages/a/node_modules/foo/index.js', DEFAULT_PATTERNS)).toBe(true);
  });

  it('excludes .git and build output dirs', () => {
    expect(isExcluded('.git/HEAD', DEFAULT_PATTERNS)).toBe(true);
    expect(isExcluded('dist/app.js', DEFAULT_PATTERNS)).toBe(true);
    expect(isExcluded('build/index.html', DEFAULT_PATTERNS)).toBe(true);
    expect(isExcluded('.next/cache/foo', DEFAULT_PATTERNS)).toBe(true);
    expect(isExcluded('.turbo/daemon.log', DEFAULT_PATTERNS)).toBe(true);
  });

  it('excludes lockfiles by basename at any depth', () => {
    expect(isExcluded('package-lock.json', DEFAULT_PATTERNS)).toBe(true);
    expect(isExcluded('packages/a/package-lock.json', DEFAULT_PATTERNS)).toBe(true);
    expect(isExcluded('yarn.lock', DEFAULT_PATTERNS)).toBe(true);
    expect(isExcluded('apps/web/pnpm-lock.yaml', DEFAULT_PATTERNS)).toBe(true);
    expect(isExcluded('vendor/foo.lock', DEFAULT_PATTERNS)).toBe(true);
  });

  it('allows normal source files', () => {
    expect(isExcluded('src/index.ts', DEFAULT_PATTERNS)).toBe(false);
    expect(isExcluded('packages/myco/src/db/schema.ts', DEFAULT_PATTERNS)).toBe(false);
    expect(isExcluded('README.md', DEFAULT_PATTERNS)).toBe(false);
    expect(isExcluded('docs/design.md', DEFAULT_PATTERNS)).toBe(false);
  });

  it('does NOT mistake segment substrings for matches', () => {
    // `node_modules` is a full segment pattern — `node_modules_legacy` must not match.
    expect(isExcluded('node_modules_legacy/foo.js', DEFAULT_PATTERNS)).toBe(false);
    // `build` as a segment — `rebuild.ts` must not match.
    expect(isExcluded('src/rebuild.ts', DEFAULT_PATTERNS)).toBe(false);
  });

  it('normalizes backslash paths (windows-ish)', () => {
    expect(isExcluded('packages\\a\\node_modules\\foo.js', DEFAULT_PATTERNS)).toBe(true);
  });

  it('returns false for empty pattern list', () => {
    expect(isExcluded('node_modules/foo.js', [])).toBe(false);
  });
});
