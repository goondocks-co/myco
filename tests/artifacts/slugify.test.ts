import { describe, it, expect } from 'vitest';
import { slugifyPath } from '@myco/artifacts/slugify';

describe('slugifyPath', () => {
  it('converts a simple path', () => {
    expect(slugifyPath('docs/specs/auth-design.md'))
      .toBe('docs-specs-auth-design');
  });

  it('strips the file extension', () => {
    expect(slugifyPath('README.md')).toBe('readme');
  });

  it('lowercases the result', () => {
    expect(slugifyPath('Docs/MySpec.md')).toBe('docs-myspec');
  });

  it('converts spaces to hyphens', () => {
    expect(slugifyPath('docs/my spec (v2).md')).toBe('docs-my-spec-v2');
  });

  it('replaces backslashes (Windows paths)', () => {
    expect(slugifyPath('docs\\specs\\design.md'))
      .toBe('docs-specs-design');
  });

  it('handles paths with no extension', () => {
    expect(slugifyPath('docs/README')).toBe('docs-readme');
  });

  it('handles deeply nested paths', () => {
    expect(slugifyPath('docs/superpowers/specs/2026-03-13-auth-design.md'))
      .toBe('docs-superpowers-specs-2026-03-13-auth-design');
  });

  it('caps at 100 chars and appends hash for long paths', () => {
    const longPath = 'a/'.repeat(60) + 'file.md'; // way over 100 chars
    const result = slugifyPath(longPath);
    expect(result.length).toBeLessThanOrEqual(107); // 100 + '-' + 6
    expect(result).toMatch(/-[a-f0-9]{6}$/);
  });

  it('does not append hash when exactly 100 chars', () => {
    const slug = 'a'.repeat(100);
    const pathStr = slug + '.md';
    const result = slugifyPath(pathStr);
    expect(result).toBe(slug);
    expect(result.length).toBe(100);
  });

  it('produces deterministic output', () => {
    const p = 'docs/specs/design.md';
    expect(slugifyPath(p)).toBe(slugifyPath(p));
  });
});
