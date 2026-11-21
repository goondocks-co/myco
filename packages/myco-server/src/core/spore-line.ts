import { oneLine } from './injection.js';

const FENCE = /^(?:`{3,}|~{3,})/;
const RULE = /^(?:[-*_]\s*){3,}$/;
const TABLE = /^\|/;
const MARKERS = /^(?:[#>*+-]+\s*|\d+[.)]\s+)+/;

/** The lines of a body that carry prose: front matter, fenced code, table rows, rules and blank lines are structure. */
function proseLines(content: string): string[] {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  let at = 0;
  while (at < lines.length && lines[at] === '') at++;
  if (lines[at] === '---') {
    const close = lines.indexOf('---', at + 1);
    at = close < 0 ? lines.length : close + 1;
  }
  const prose: string[] = [];
  let fenced = false;
  for (const line of lines.slice(at)) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced || RULE.test(line) || TABLE.test(line)) continue;
    const text = line.replace(MARKERS, '').trim();
    if (text !== '') prose.push(text);
  }
  return prose;
}

/** The first line of a body that is neither blank nor a fence, rule or front-matter delimiter, with its table bars removed. */
function firstContentLine(content: string): string | undefined {
  return content.split(/\r?\n/).map((line) => line.trim().replace(/^\|+|\|+$/g, '').trim())
    .find((line) => line !== '' && !FENCE.test(line) && !RULE.test(line));
}

/**
 * A spore's one line: its agent line, or where it has none, the first prose line of its body. A body holding no prose
 * gives its first content line, such as a line of code; a body of blank text alone gives `fallback`.
 */
export function sporeLine(agentLine: string | null, content: string, fallback: string): string {
  if (agentLine !== null && agentLine.trim() !== '') return oneLine(agentLine);
  const opening = proseLines(content)[0] ?? firstContentLine(content);
  return opening === undefined ? fallback : oneLine(opening);
}
