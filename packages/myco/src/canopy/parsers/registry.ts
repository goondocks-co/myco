import type { CanopyParser } from '../types.js';
import { typescriptParser } from './typescript.js';
import { pythonParser } from './python.js';
import { markdownParser } from './markdown.js';
import { yamlJsonParser } from './yaml-json.js';
import { sqlParser } from './sql.js';
import { fallbackParser } from './fallback.js';

const TS_RE = /\.(?:tsx|ts|jsx|js|mjs|cjs|mts|cts)$/i;
const PY_RE = /\.py$/i;
const MD_RE = /\.(?:md|markdown)$/i;
const YJ_RE = /\.(?:yaml|yml|json)$/i;
const SQL_RE = /\.sql$/i;

/** Dispatch a path to the right mechanical parser. Extension-driven only. */
export function parserFor(path: string): CanopyParser {
  if (TS_RE.test(path)) return typescriptParser;
  if (PY_RE.test(path)) return pythonParser;
  if (MD_RE.test(path)) return markdownParser;
  if (YJ_RE.test(path)) return yamlJsonParser;
  if (SQL_RE.test(path)) return sqlParser;
  return fallbackParser;
}
