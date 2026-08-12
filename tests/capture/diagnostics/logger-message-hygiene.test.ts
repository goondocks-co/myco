/**
 * Structural gate for a claim both diagnostic-bundle log channels rely on:
 * daemon.log and log_entries only ever carry CODE-AUTHORED message/kind
 * strings, never raw interpolated prompt/content/text/body — that's the
 * mechanism behind "skeletonize/redact never has to scrub message strings
 * themselves, only the structured `data` payload next to them" (see
 * capture/diagnostics/index.ts's DAEMON_LOG_CORE_FIELDS comment and
 * collect-vault.ts's redactLogPayload).
 *
 * This is a cheap grep-style gate, not a type checker: it walks every
 * `logger.<info|warn|error|debug>(` call site in packages/myco/src and
 * flags one whose message or kind ARGUMENT is a template literal that
 * interpolates a variable whose name matches /(prompt|content|text|body|
 * message)/i. A `data` object payload argument (the 3rd arg) is not
 * inspected — that channel's own field-level redaction is what
 * `redactLogPayload` exists for; this gate is about the two positional
 * string arguments that ship as-is, unredacted, into daemon.log.
 *
 * Tolerant by design: `ALLOWLIST` below can carry `<path>:<line>` entries
 * for a confirmed-safe false positive (e.g. an identifier like
 * `contentHash` or `err.message` that merely CONTAINS one of the risky
 * substrings) rather than this test needing a smarter parser.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '../../../packages/myco/src');

const CALL_RE = /\blogger\.(debug|info|warn|error)\s*\(/g;
const RISKY_NAME = /(prompt|content|text|body|message)/i;

/**
 * Confirmed-safe false positives, as `<path relative to SRC>:<line>`.
 *
 * - `daemon/api/context.ts:644` — `${promptTokens}` is an integer token
 *   COUNT (`estimateTokens(text)`, context.ts:641), not prompt text; the
 *   identifier merely contains the substring "prompt". The message also
 *   interpolates spore titles (`${titles.join(', ')}`), which the risky-name
 *   regex doesn't match and this gate doesn't police — spore titles are
 *   already-published metadata, not raw prompt/session content.
 */
const ALLOWLIST = new Set<string>(['daemon/api/context.ts:644']);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function readQuoted(text: string, start: number, quote: string): { next: number } {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === quote) { i++; break; }
    i++;
  }
  return { next: i };
}

/** Scans a backtick template literal starting at `start`, honoring nested `${ … }` code (which may itself contain strings/templates). */
function readTemplate(text: string, start: number): { next: number } {
  let i = start + 1;
  let exprDepth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (exprDepth === 0) {
      if (ch === '`') { i++; break; }
      if (ch === '$' && text[i + 1] === '{') { exprDepth = 1; i += 2; continue; }
      i++;
      continue;
    }
    if (ch === '{') { exprDepth++; i++; continue; }
    if (ch === '}') { exprDepth--; i++; continue; }
    if (ch === '`') { i = readTemplate(text, i).next; continue; }
    if (ch === '"' || ch === "'") { i = readQuoted(text, i, ch).next; continue; }
    i++;
  }
  return { next: i };
}

/** Finds the text between a call's opening `(` (at `openParenIdx`) and its matching close, string/template/comment aware. Returns null on an unbalanced scan (never true for valid TS) rather than mis-flagging. */
function findCallArgsText(content: string, openParenIdx: number): string | null {
  let i = openParenIdx + 1;
  const start = i;
  let depth = 1;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '"' || ch === "'") { i = readQuoted(content, i, ch).next; continue; }
    if (ch === '`') { i = readTemplate(content, i).next; continue; }
    if (ch === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i);
      i = nl === -1 ? content.length : nl + 1;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') { depth++; i++; continue; }
    if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return content.slice(start, i);
      i++;
      continue;
    }
    i++;
  }
  return null;
}

/** Splits a call's argument text into top-level (depth-0) arguments. */
function splitTopLevelArgs(argsText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;
  while (i < argsText.length) {
    const ch = argsText[i];
    if (ch === '"' || ch === "'") {
      const q = readQuoted(argsText, i, ch);
      current += argsText.slice(i, q.next);
      i = q.next;
      continue;
    }
    if (ch === '`') {
      const t = readTemplate(argsText, i);
      current += argsText.slice(i, t.next);
      i = t.next;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') { depth++; current += ch; i++; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth--; current += ch; i++; continue; }
    if (ch === ',' && depth === 0) { args.push(current); current = ''; i++; continue; }
    current += ch;
    i++;
  }
  if (current.trim().length > 0 || args.length > 0) args.push(current);
  return args;
}

/** Every `${ … }` interpolation expression inside a (backtick-delimited) template literal. */
function extractInterpolations(templateText: string): string[] {
  const exprs: string[] = [];
  let i = 0;
  while (i < templateText.length) {
    if (templateText[i] === '\\') { i += 2; continue; }
    if (templateText[i] === '$' && templateText[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      const start = j;
      while (j < templateText.length && depth > 0) {
        if (templateText[j] === '{') depth++;
        else if (templateText[j] === '}') depth--;
        if (depth > 0) j++;
      }
      exprs.push(templateText.slice(start, j));
      i = j + 1;
      continue;
    }
    i++;
  }
  return exprs;
}

function findOffenders(content: string, relPath: string): string[] {
  const offenders: string[] = [];
  for (const match of content.matchAll(CALL_RE)) {
    const openParenIdx = match.index! + match[0].length - 1;
    const argsText = findCallArgsText(content, openParenIdx);
    if (argsText === null) continue;
    const [kindArg, messageArg] = splitTopLevelArgs(argsText);
    for (const arg of [kindArg, messageArg]) {
      if (!arg) continue;
      const trimmed = arg.trim();
      if (!trimmed.startsWith('`')) continue;
      const risky = extractInterpolations(trimmed).some((expr) => RISKY_NAME.test(expr));
      if (!risky) continue;
      const line = lineNumberAt(content, match.index!);
      const key = `${relPath}:${line}`;
      if (!ALLOWLIST.has(key)) offenders.push(key);
    }
  }
  return offenders;
}

describe('logger message/kind arguments are code-authored, never interpolated content', () => {
  it('no logger.<info|warn|error|debug> call interpolates a prompt/content/text/body/message-named variable into its message or kind argument', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const content = fs.readFileSync(file, 'utf8');
      const relPath = path.relative(SRC, file);
      offenders.push(...findOffenders(content, relPath));
    }
    expect(offenders).toEqual([]);
  });

  it('self-test: the scanner actually flags an interpolated risky-named variable', () => {
    const sample = "logger.info('daemon.test', `Prompt was: ${userPromptText}`);";
    expect(findOffenders(sample, 'sample.ts')).toEqual(['sample.ts:1']);
  });

  it('self-test: the scanner does not flag a code-authored literal message', () => {
    const sample = "logger.warn(LOG_KINDS.DAEMON_LAG, `Event-loop lag ${lag}ms exceeds threshold ${threshold}ms`, { lag });";
    expect(findOffenders(sample, 'sample.ts')).toEqual([]);
  });
});
