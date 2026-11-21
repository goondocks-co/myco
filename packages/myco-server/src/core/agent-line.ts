import { AGENT_LINE_GUIDANCE, AGENT_LINE_MAX_CHARS } from './injection.js';

/** The sentence every statement of the agent-line rule shares. */
export const AGENT_LINE_NO_CODE = 'An agent_line names no file path, flag or code symbol.';

/** What an agent line is, as every writer of one reads it: extraction, seeding, curation and the spore tools. */
export const AGENT_LINE_RULE = `An agent_line is one line that opens with the situation or symptom in the words of someone who has not read the code, then gives the guidance. An internal term may follow that plain description but never stands in for it, and a version number or product-internal name says what it is. ${AGENT_LINE_NO_CODE} ${AGENT_LINE_GUIDANCE}`;

/** Product names spelled like a script file, which name the product, not a file. */
const PRODUCT_SCRIPT_NAMES = String.raw`(?:node|next|nuxt|vue|express|three|d3)\.js\b`;

/** The code notation no agent line may carry, as every writer reads it. */
export const AGENT_LINE_NOTATION_RULES = 'Deterministic validation rejects, wherever they stand, even inside parentheses or quotes: backticks; home, dot-relative or drive-rooted paths; double-dash flags; slash-separated paths whose last part is a lower-case file name with a 1–5-letter extension, including such a URL; lower-case source file names; lower-case or upper-case words joined by underscores; and lower-case call notation, a name followed by an opening parenthesis that is empty, closes on one argument without spaces, or holds a comma-separated list. Routes without file extensions, product names such as Node.js, Bun/Node.js and node.js, numeric prose such as 1(retry), and prose in parentheses such as status(retry once) are allowed. camelCase and other ambiguous names require editorial judgment.';

/** Each kind of explicit lexical notation; route, product and prose forms are left to editorial judgment. */
const AGENT_LINE_CODE_NOTATION: readonly RegExp[] = [
  /`/,
  /(?<![\w-])--[A-Za-z][\w-]*/,
  /(?<![\w.~/\\-])(?:~|\.\.?)\/[\w./-]*/,
  /(?<!\w)[A-Za-z]:[\\/][\w.\\/-]*/,
  new RegExp(String.raw`[\w.-]+\/(?:[\w.-]+\/)*(?!${PRODUCT_SCRIPT_NAMES})[a-z0-9_][\w-]*\.[A-Za-z]{1,5}\b`),
  new RegExp(String.raw`(?<![\w./-])(?!${PRODUCT_SCRIPT_NAMES})[a-z0-9][\w.-]*\.(?:tsx?|jsx?|[cm]js|json|ya?ml|py|rs|go|sh|sql)\b`),
  /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/,
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/,
  new RegExp(String.raw`(?<![\w.$])(?!${PRODUCT_SCRIPT_NAMES})[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*\((?:$|\)|[^\s(),]+\)|[^\s(),]+(?:,\s*[^\s(),]+)+\))`),
];

/** The code notation `line` carries first, the whole token, or null. */
export function agentLineNotation(line: string): string | null {
  let first: RegExpExecArray | null = null;
  for (const pattern of AGENT_LINE_CODE_NOTATION) {
    const found = pattern.exec(line);
    if (found !== null && (first === null || found.index < first.index)) first = found;
  }
  return first?.[0] ?? null;
}

/** An agent line as it is stored and counted: one line, runs of whitespace as one space. */
export const normalizeAgentLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

export function admitAgentLine(value: unknown): { line: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'agent_line is missing; expected nonempty text within ' + AGENT_LINE_MAX_CHARS + ' characters' };
  const line = normalizeAgentLine(value);
  return line.length === 0 || line.length > AGENT_LINE_MAX_CHARS
    ? { error: 'agent_line is ' + line.length + ' characters after whitespace normalization; the limit is ' + AGENT_LINE_MAX_CHARS }
    : { line };
}
