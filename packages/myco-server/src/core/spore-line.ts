import { oneLine } from './injection.js';

/** A spore's one line: its agent line, or where it has none, the first line of its body without Markdown markers. */
export function sporeLine(agentLine: string | null, content: string): string {
  if (agentLine !== null && agentLine.trim() !== '') return oneLine(agentLine);
  const opening = content.split('\n').map((line) => line.replace(/^[\s#>*-]+/, '').trim()).find((line) => line.length > 0);
  return oneLine(opening ?? content);
}
