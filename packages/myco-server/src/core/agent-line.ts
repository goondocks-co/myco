import { AGENT_LINE_GUIDANCE, AGENT_LINE_MAX_CHARS } from './injection.js';

/** What an agent line is, as every writer of one reads it: extraction, seeding, curation and the spore tools. */
export const AGENT_LINE_RULE = `An agent_line is one line that opens with the situation or symptom in the words of someone who has not read the code, then gives the guidance. An internal term may follow that plain description but never stands in for it, and a version number or product-internal name says what it is. It names no file path, flag or code symbol. ${AGENT_LINE_GUIDANCE}`;

/** The code notation a run's agent line may not carry, as the run reads it. */
export const AGENT_LINE_NOTATION_RULES = 'Deterministic validation rejects backticks; home, dot-relative or drive-rooted paths; slash-separated paths ending in a 1–5-letter extension; lower-case source filenames; lower-case or upper-case words joined by underscores; double-dash flags; and lower-case call notation immediately followed by an opening parenthesis. Routes without file extensions, Node.js(22) and numeric prose such as 1(retry) are allowed. camelCase and other ambiguous names require editorial judgment.';

/** Explicit lexical notation, with route and prose forms left to editorial judgment. */
const AGENT_LINE_CODE_NOTATION = /[\x60]|(?:^|\s)(?:[A-Za-z]:[\\/]|~\/|\.\.?\/|--[A-Za-z])|[\w.-]+\/[\w./-]*\.[A-Za-z]{1,5}\b|(?<![\w.-])[a-z0-9][\w.-]*\.(?:tsx?|jsx?|[cm]js|json|ya?ml|py|rs|go|sh|sql)\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|(?<![\w.])[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*\(/;

/** The first code notation `line` carries, or null. */
export function agentLineNotation(line: string): string | null {
  return AGENT_LINE_CODE_NOTATION.exec(line)?.[0] ?? null;
}

export function admitAgentLine(value: unknown): { line: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'agent_line is missing; expected nonempty text within ' + AGENT_LINE_MAX_CHARS + ' characters' };
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length === 0 || line.length > AGENT_LINE_MAX_CHARS
    ? { error: 'agent_line is ' + line.length + ' characters after whitespace normalization; the limit is ' + AGENT_LINE_MAX_CHARS }
    : { line };
}
