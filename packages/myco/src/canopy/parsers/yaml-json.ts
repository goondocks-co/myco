import type { CanopyParser, CanopyParserInput, CanopyParserOutput } from '../types.js';

/**
 * Mechanical parser for `.yaml` / `.yml` / `.json`.
 *
 * For JSON we attempt a real parse and emit object keys as `exports`;
 * arrays become `[array]` and primitives become `[primitive]` so the row
 * still has a recognisable shape. For YAML we collect column-zero
 * `key:` tokens — naïve but stable across the common cases (config files,
 * package metadata, GitHub Actions workflows).
 */
export const yamlJsonParser: CanopyParser = (input: CanopyParserInput): CanopyParserOutput => {
  const isJson = /\.json$/i.test(input.path);
  const language = isJson ? 'json' : 'yaml';
  const exports = isJson ? jsonTopKeys(input.content) : yamlTopKeys(input.content);
  return { language, exports, imports: [], topComment: null };
};

function jsonTopKeys(content: string): string[] {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed);
    }
    if (Array.isArray(parsed)) return ['[array]'];
    return ['[primitive]'];
  } catch {
    return [];
  }
}

function yamlTopKeys(content: string): string[] {
  const seen = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    if (raw.startsWith('---') || raw.startsWith('...')) continue;
    if (raw.startsWith('#')) continue;
    // Column-zero `key:` (no leading whitespace, no list dash).
    const m = raw.match(/^([A-Za-z_][\w.-]*)\s*:(?:\s|$)/);
    if (m) seen.add(m[1]);
  }
  return [...seen];
}
