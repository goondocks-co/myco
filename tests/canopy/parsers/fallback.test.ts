import { describe, it, expect } from 'bun:test';
import { fallbackParser } from '@myco/canopy/parsers/fallback';

function input(content: string, path = 'unknown.bin') {
  return { path, content, sizeBytes: Buffer.byteLength(content), lineCount: content.split(/\r?\n/).length };
}

describe('fallbackParser', () => {
  it('returns null language and empty exports/imports', () => {
    const out = fallbackParser(input('hello'));
    expect(out.language).toBeNull();
    expect(out.exports).toEqual([]);
    expect(out.imports).toEqual([]);
  });

  it('uses the first non-empty line as topComment, trimmed', () => {
    const out = fallbackParser(input('\n\n   first line   \nsecond\n'));
    expect(out.topComment).toBe('first line');
  });

  it('truncates very long first lines to 200 chars', () => {
    const long = 'x'.repeat(500);
    const out = fallbackParser(input(long));
    expect(out.topComment?.length).toBe(200);
  });

  it('returns null topComment for entirely empty content', () => {
    const out = fallbackParser(input(''));
    expect(out.topComment).toBeNull();
  });
});
