// docs/lib/extract.mjs
// Docs have no YAML frontmatter, so title/description are derived from content.

export function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  return match ? match[1].trim() : null;
}

export function extractDescription(markdown) {
  const withoutTitle = markdown.replace(/^#\s+.+$/m, '');
  const blocks = withoutTitle.split(/\n\s*\n/);
  for (const block of blocks) {
    const text = block.trim();
    if (!text) continue;
    // Skip structural blocks, but NOT prose that merely starts with ** (bold)
    // or a single backtick (inline code). Match heading (#), blockquote (>),
    // list bullet (- or * then space), a 3-backtick code fence, or table row (|).
    if (/^#{1,6}\s|^>\s?|^[-*]\s|^`{3}|^\|/.test(text)) continue;
    const plain = text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links -> text
      .replace(/[*_`]/g, '') // emphasis/code marks
      .replace(/\s+/g, ' ')
      .trim();
    if (plain) return plain;
  }
  return '';
}
