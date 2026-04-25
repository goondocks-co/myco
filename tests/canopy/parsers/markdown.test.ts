import { describe, it, expect } from 'bun:test';
import { markdownParser } from '@myco/canopy/parsers/markdown';

function input(content: string, path = 'README.md') {
  return { path, content, sizeBytes: Buffer.byteLength(content), lineCount: content.split(/\r?\n/).length };
}

describe('markdownParser', () => {
  it('uses the first H1 as topComment', () => {
    const out = markdownParser(input(`# Hello world\n\nbody\n## sub\n## sub2\n`));
    expect(out.language).toBe('markdown');
    expect(out.topComment).toContain('Hello world');
    expect(out.topComment).toContain('h2:2');
  });

  it('falls back to the first non-empty line when there is no H1', () => {
    const out = markdownParser(input(`\n\nplain first line\n## sub\n`));
    expect(out.topComment).toContain('plain first line');
  });

  it('returns no exports or imports', () => {
    const out = markdownParser(input(`# a\n\n## b\n`));
    expect(out.exports).toEqual([]);
    expect(out.imports).toEqual([]);
  });

  it('omits the heading-count suffix when only an H1 is present', () => {
    const out = markdownParser(input(`# Solo\n\ntext only\n`));
    expect(out.topComment).toBe('Solo');
  });

  it('returns null topComment for an empty file', () => {
    const out = markdownParser(input(''));
    expect(out.topComment).toBeNull();
  });
});
