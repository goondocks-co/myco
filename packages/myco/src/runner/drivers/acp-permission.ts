/**
 * An agent's permission question, answered from the run's grant.
 *
 * Nobody is at a terminal to answer, so the run's grant does: a call inside it
 * is allowed once, and anything else is rejected once. Neither answer is one
 * the agent may remember, so a choice made for one run never reaches another.
 *
 * A call is named in the grant's vocabulary before the grant is asked. A file
 * read, a search and a command are named by the kind the protocol gives them,
 * a command with the command it runs. A call of no narrower kind is named by
 * the tool name the agent gives it, and is a tool of the run's server when that
 * name is the grant's own `mcp__<server>__<tool>` or the `<server>_<tool>` form
 * OpenCode gives an MCP tool. Nothing else is in the grant.
 */
import { MCP_SERVER_NAME } from '../mcp-config.js';
import { grantsCall, SERVER_GRANT, SHELL_TOOL } from './grant.js';
import { recordOf, stringOf } from './stream.js';

/** The grant's tool for each protocol tool kind the grant can hold. */
const KIND_TOOLS: Readonly<Record<string, string>> = { read: 'Read', search: 'Grep', execute: SHELL_TOOL };

/** The protocol's kind for a call it has no narrower kind for, which is the kind an MCP tool's call carries. */
const UNKINDED = 'other';

/** A tool's name, as distinct from a title that describes a path, a command or a pattern. */
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/** The prefixes an agent names a tool of the run's server with, and the grant's own. */
const SERVER_PREFIXES = [`${SERVER_GRANT}__`, `${MCP_SERVER_NAME}_`] as const;

/** The protocol's option kinds for an answer that holds for this call only. */
const ALLOW_ONCE = 'allow_once';
const REJECT_ONCE = 'reject_once';

/** The protocol's answer to a permission request. */
export type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

/** A call as the grant names it, or null when it names nothing the grant can hold. */
function grantCallOf(toolCall: Record<string, unknown>): { tool: string; command: string | null } | null {
  const kind = stringOf(toolCall.kind) ?? UNKINDED;
  if (Object.hasOwn(KIND_TOOLS, kind)) {
    const tool = KIND_TOOLS[kind]!;
    return { tool, command: tool === SHELL_TOOL ? stringOf(stringOf(recordOf(toolCall.rawInput)?.command)?.trim()) : null };
  }
  if (kind !== UNKINDED) return null;
  const name = stringOf(toolCall.name) ?? stringOf(toolCall.title);
  if (name === null || !TOOL_NAME.test(name)) return null;
  const prefix = SERVER_PREFIXES.find((p) => name.startsWith(p) && name.length > p.length);
  return prefix === undefined ? null : { tool: `${SERVER_GRANT}__${name.slice(prefix.length)}`, command: null };
}

/** The id of the first option of this kind the agent offered. */
function optionOf(options: unknown, kind: string): string | null {
  const offered = Array.isArray(options) ? options.map(recordOf) : [];
  return stringOf(offered.find((option) => option?.kind === kind)?.optionId);
}

/**
 * How to answer a permission request, and whether the call was allowed.
 *
 * A request for another session, or one that offers no way to allow the call
 * once, is not allowed. A refusal selects the agent's reject-once option, and
 * cancels the request when the agent offers none.
 */
export function answerPermission(grant: readonly string[], sessionId: string | null, params: Record<string, unknown>): { outcome: PermissionOutcome; allowed: boolean } {
  const toolCall = recordOf(params.toolCall);
  const call = toolCall === null ? null : grantCallOf(toolCall);
  const allow = optionOf(params.options, ALLOW_ONCE);
  if (sessionId !== null && params.sessionId === sessionId && call !== null && allow !== null && grantsCall(grant, call.tool, call.command)) {
    return { outcome: { outcome: 'selected', optionId: allow }, allowed: true };
  }
  const reject = optionOf(params.options, REJECT_ONCE);
  return { outcome: reject === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: reject }, allowed: false };
}
