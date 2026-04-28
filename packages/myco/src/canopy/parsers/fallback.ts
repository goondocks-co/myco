import type { CanopyParser, CanopyParserInput, CanopyParserOutput } from '../types.js';

const TOP_COMMENT_MAX = 200;

/**
 * Universal mechanical baseline used when no language-specific parser applies
 * or when a language parser fails. Returns enough structure that the row is
 * still useful (path/hash/size/lines arrive from the scanner).
 */
export const fallbackParser: CanopyParser = (input: CanopyParserInput): CanopyParserOutput => {
  const firstLine = firstNonEmptyLine(input.content);
  return {
    language: null,
    exports: [],
    imports: [],
    topComment: firstLine ? firstLine.slice(0, TOP_COMMENT_MAX) : null,
  };
};

function firstNonEmptyLine(content: string): string | null {
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}
