import { AGENT_LINE_MAX_CHARS } from './injection.js';

export function admitAgentLine(value: unknown): { line: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'agent_line is missing; expected nonempty text within ' + AGENT_LINE_MAX_CHARS + ' characters' };
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length === 0 || line.length > AGENT_LINE_MAX_CHARS
    ? { error: 'agent_line is ' + line.length + ' characters after whitespace normalization; the limit is ' + AGENT_LINE_MAX_CHARS }
    : { line };
}
