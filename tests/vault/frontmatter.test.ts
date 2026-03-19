import { describe, it, expect } from 'vitest';
import { stripFrontmatter } from '@myco/vault/frontmatter';

describe('stripFrontmatter', () => {
  it('strips YAML frontmatter and returns body and parsed frontmatter', () => {
    const raw = '---\ntype: session\nid: abc123\n---\n\n# Session Title\n\nBody content here.';
    const { body, frontmatter } = stripFrontmatter(raw);
    expect(frontmatter.type).toBe('session');
    expect(frontmatter.id).toBe('abc123');
    expect(body).toContain('# Session Title');
    expect(body).toContain('Body content here.');
    expect(body).not.toContain('---');
  });

  it('returns raw text as body (trimmed) when no frontmatter is present', () => {
    const raw = '# Just a heading\n\nSome content without frontmatter.';
    const { body, frontmatter } = stripFrontmatter(raw);
    expect(body).toBe(raw.trim());
    expect(frontmatter).toEqual({});
  });

  it('handles malformed YAML gracefully by returning an empty frontmatter object', () => {
    // YAML with a tab character causes a parse error
    const raw = '---\nkey: : bad yaml ::\n\tanother: [unclosed\n---\n\nBody after bad frontmatter.';
    const { body, frontmatter } = stripFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toContain('Body after bad frontmatter.');
  });

  it('handles empty content', () => {
    const { body, frontmatter } = stripFrontmatter('');
    expect(body).toBe('');
    expect(frontmatter).toEqual({});
  });

  it('preserves body content exactly after frontmatter without extra trimming of internal whitespace', () => {
    const bodyContent = '# Heading\n\nParagraph one.\n\nParagraph two.\n\n    indented block';
    const raw = `---\ntype: spore\n---\n\n${bodyContent}`;
    const { body } = stripFrontmatter(raw);
    // The body should preserve all internal whitespace
    expect(body).toContain('    indented block');
    expect(body).toContain('Paragraph one.');
    expect(body).toContain('Paragraph two.');
  });

  it('handles frontmatter with multiple field types', () => {
    const raw = '---\ntitle: My Note\ncount: 42\nenabled: true\ntags:\n  - foo\n  - bar\n---\n\nContent.';
    const { body, frontmatter } = stripFrontmatter(raw);
    expect(frontmatter.title).toBe('My Note');
    expect(frontmatter.count).toBe(42);
    expect(frontmatter.enabled).toBe(true);
    expect(frontmatter.tags).toEqual(['foo', 'bar']);
    expect(body).toBe('Content.');
  });

  it('handles frontmatter with no body after it', () => {
    const raw = '---\ntype: artifact\n---\n';
    const { body, frontmatter } = stripFrontmatter(raw);
    expect(frontmatter.type).toBe('artifact');
    expect(body).toBe('');
  });

  it('does not treat a line starting with --- mid-document as frontmatter delimiter', () => {
    // No opening --- at position 0, so the whole thing is treated as body
    const raw = 'Some text\n---\ntype: not frontmatter\n---\nMore text.';
    const { body, frontmatter } = stripFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw.trim());
  });
});
