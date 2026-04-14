const MARKDOWN_HEADING_PREFIX = /^#{1,6}\s+/;
const MARKDOWN_EMPHASIS = /[*_`~]+/g;
const COLLAPSE_WHITESPACE = /\s+/g;

export function formatGraphLabel(value: string): string {
  return value
    .replace(MARKDOWN_HEADING_PREFIX, '')
    .replace(MARKDOWN_EMPHASIS, '')
    .replace(COLLAPSE_WHITESPACE, ' ')
    .trim();
}
