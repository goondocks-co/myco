import { HOOK_CONFIG } from './hook-config.generated.js';

/** The Deployment transcript reader owns prompts and replies; tools and delegations have their own producer. */
export function transcriptWritesTurnRows(agent: string): boolean {
  return HOOK_CONFIG[agent]?.capabilities.turnRowSource === 'transcript';
}

/**
 * Whether this symbiont's tool calls reach the Deployment from its hooks.
 *
 * True for a symbiont whose hooks write every turn row, and for one whose
 * transcript the server parses but which carries no tool calls to parse: the
 * hook is then the only source of the row, and a tool call it does not ship
 * is a tool call nobody records.
 */
export function hookShipsToolCalls(agent: string): boolean {
  const capabilities = HOOK_CONFIG[agent]?.capabilities;
  return capabilities === undefined || capabilities.turnRowSource === 'hook' || capabilities.transcriptFidelity === 'no_tool_results';
}

/** The producer of delegation starts is declared independently of prompt and reply capture. */
export function hookShipsSubagentStarts(agent: string): boolean {
  const capabilities = HOOK_CONFIG[agent]?.capabilities;
  return (capabilities?.subagentRowSource ?? capabilities?.turnRowSource ?? 'hook') === 'hook';
}
