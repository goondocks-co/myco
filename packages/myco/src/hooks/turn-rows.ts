import { HOOK_CONFIG } from './hook-config.generated.js';

/**
 * Whether this symbiont's transcript is the only writer of its turn rows.
 *
 * A symbiont whose runtime keeps a transcript the server parses has its
 * prompts, responses, tool calls and subagent starts derived from that
 * transcript. A hook that also shipped them would mint a second event for the
 * same row: the ids never meet on the raw insert, so the projection key
 * absorbs one write and the other is left over as a conflict on every turn.
 *
 * Read by every hook that writes a turn row, so the answer is one declaration
 * rather than a condition repeated per hook.
 */
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
