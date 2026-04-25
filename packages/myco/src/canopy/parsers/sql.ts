import type { CanopyParser, CanopyParserInput, CanopyParserOutput } from '../types.js';

/**
 * Mechanical parser for `.sql`. Scans for top-level DDL/DML statement kinds
 * and emits affected object identifiers as `exports`. Strips line and block
 * comments first so commented-out statements don't show up.
 */
export const sqlParser: CanopyParser = (input: CanopyParserInput): CanopyParserOutput => {
  const cleaned = stripComments(input.content);
  const exports: string[] = [];

  for (const m of cleaned.matchAll(/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."`]+)/gi)) {
    exports.push(`table:${unquote(m[1])}`);
  }
  for (const m of cleaned.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."`]+)/gi)) {
    exports.push(`index:${unquote(m[1])}`);
  }
  for (const m of cleaned.matchAll(/\bCREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."`]+)/gi)) {
    exports.push(`view:${unquote(m[1])}`);
  }
  for (const m of cleaned.matchAll(/\bCREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."`]+)/gi)) {
    exports.push(`trigger:${unquote(m[1])}`);
  }
  for (const m of cleaned.matchAll(/\bALTER\s+TABLE\s+([\w."`]+)/gi)) {
    exports.push(`alter:${unquote(m[1])}`);
  }

  return { language: 'sql', exports, imports: [], topComment: null };
};

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

function unquote(s: string): string {
  return s.replace(/^["`]|["`]$/g, '');
}
