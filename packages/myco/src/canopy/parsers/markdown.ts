import type { CanopyParser, CanopyParserInput, CanopyParserOutput } from '../types.js';

const TOP_COMMENT_MAX = 240;

/**
 * Mechanical parser for `.md` / `.markdown`. Pulls the first H1 (or the
 * first non-empty line if no H1 is present) into topComment, and appends a
 * compact heading-count summary so the row carries some shape.
 */
export const markdownParser: CanopyParser = (input: CanopyParserInput): CanopyParserOutput => {
  const lines = input.content.split(/\r?\n/);
  let h1: string | null = null;
  let h2 = 0;
  let h3 = 0;
  let firstNonEmpty: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (firstNonEmpty === null) firstNonEmpty = line;
    if (h1 === null && line.startsWith('# ')) h1 = line.slice(2).trim();
    else if (line.startsWith('## ')) h2++;
    else if (line.startsWith('### ')) h3++;
  }

  const head = h1 ?? firstNonEmpty;
  const headings = h2 + h3 > 0 ? ` [h2:${h2} h3:${h3}]` : '';
  const top = head ? `${head}${headings}`.slice(0, TOP_COMMENT_MAX) : null;

  return { language: 'markdown', exports: [], imports: [], topComment: top };
};
