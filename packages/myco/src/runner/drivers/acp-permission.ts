/**
 * An agent's permission question, answered from the run's grant.
 *
 * Nobody is at a terminal to answer, so the run's grant does: a call inside it
 * is allowed once, and anything else is rejected once. Neither answer is one
 * the agent may remember, so a choice made for one run never reaches another.
 *
 * A permission request carries its tool call as an update, holding only the
 * fields that changed, so a call is read as everything the agent has said
 * about it: the session's updates for that call first, and the request's own
 * fields over them.
 *
 * The call is then named in the grant's vocabulary before the grant is asked:
 * - a file read is `Read`, and a command is `Bash` with the command it runs,
 *   refused whatever it runs when the directory it names to run in is outside
 *   the run's own;
 * - a search is `Grep` when it searches for a pattern, and is outside the grant
 *   when it has a query, a URL or a web call id instead;
 * - a call of no narrower kind is a tool of the run's server when it names one
 *   of the tools the server lists for the run: as Cursor does, by the server
 *   and tool it gives in its input; by the grant's own `mcp__<server>__<tool>`;
 *   or by the `<server>_<tool>` OpenCode gives an MCP tool, each part with
 *   every character outside `[A-Za-z0-9_-]` replaced by `_`.
 * Nothing else is in the grant.
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MCP_SERVER_NAME } from '../mcp-config.js';
import { grantsCall, SERVER_GRANT, SHELL_TOOL, type RunGrant } from './grant.js';
import { recordOf, stringOf } from './stream.js';

/** The protocol's kind for a call it has no narrower kind for, which is the kind an MCP tool's call carries. */
const UNKINDED = 'other';

/** The prefix of the call id Cursor gives a web call. */
const WEB_CALL_PREFIX = 'web_';

/** The protocol's option kinds for an answer that holds for this call only. */
const ALLOW_ONCE = 'allow_once';
const REJECT_ONCE = 'reject_once';

/** Why a call was refused. */
const OUTSIDE_GRANT = 'outside the run\'s grant';
const NO_ALLOW_ONCE = 'the agent offered no way to allow the call once';
const OUTSIDE_RUN_DIR = 'the command would run outside the run\'s directory';

/** The input fields an agent names a command's working directory in: OpenCode reports the directory a command runs in as `cwd`, and the one the agent asked for as `workdir`. */
const WORKING_DIRECTORY_FIELDS = ['cwd', 'workdir'] as const;

/** The protocol's answer to a permission request. */
export type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

/** How OpenCode spells a server or tool name inside an MCP tool's name. */
const openCodeName = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_');

/** What the agent has said about each of its calls in this session. */
export class ToolCalls {
  private readonly known = new Map<string, Record<string, unknown>>();

  /** A session update's fields, kept for its call. */
  saw(update: Record<string, unknown>): void {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
    const id = stringOf(update.toolCallId);
    if (id !== null) this.known.set(id, this.merged(update));
  }

  /**
   * The call as everything said about it, these fields over what was said
   * before. A field that is absent or null is unchanged, and so is each field of
   * the call's input: an agent that reports only part of the input later has
   * not withdrawn the rest.
   */
  merged(toolCall: Record<string, unknown>): Record<string, unknown> {
    const id = stringOf(toolCall.toolCallId);
    const known = id === null ? {} : this.known.get(id) ?? {};
    const changed = present(toolCall);
    const input = recordOf(changed.rawInput);
    return { ...known, ...changed, ...(input === null ? {} : { rawInput: { ...recordOf(known.rawInput), ...present(input) } }) };
  }
}

/** A record's fields that hold a value. */
const present = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null));

/** The physical path, where it exists. */
const physical = (path: string): string => (existsSync(path) ? realpathSync(path) : path);

/** Whether every working directory a command's input names is inside the run's directory. */
function runsInside(toolCall: Record<string, unknown>, runDir: string): boolean {
  const input = recordOf(toolCall.rawInput);
  const root = physical(runDir);
  return WORKING_DIRECTORY_FIELDS.every((field) => {
    const named = stringOf(input?.[field]);
    if (named === null) return true;
    const path = relative(root, physical(resolve(root, named)));
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  });
}

/** The name of one of the run's listed tools that this call names, or null. */
function runToolOf(toolCall: Record<string, unknown>, names: ReadonlySet<string>): string | null {
  const input = recordOf(toolCall.rawInput);
  const provided = stringOf(input?.toolName);
  if (input?.providerIdentifier === MCP_SERVER_NAME && provided !== null && names.has(provided)) return provided;
  const name = stringOf(toolCall.name) ?? stringOf(toolCall.title);
  if (name === null) return null;
  return [...names].find((tool) => name === `${SERVER_GRANT}__${tool}` || name === `${openCodeName(MCP_SERVER_NAME)}_${openCodeName(tool)}`) ?? null;
}

/** Whether a search call searches files for a pattern, rather than the web or a service for a query. */
function searchesFiles(toolCall: Record<string, unknown>): boolean {
  const input = recordOf(toolCall.rawInput);
  return stringOf(input?.pattern) !== null && input?.query === undefined && input?.url === undefined
    && !(stringOf(toolCall.toolCallId) ?? '').startsWith(WEB_CALL_PREFIX);
}

/** A call as the grant names it, or why it names nothing the grant can hold. */
function grantCallOf(toolCall: Record<string, unknown>, tools: ReadonlySet<string>, runDir: string): { tool: string; command: string | null } | { unnamed: string } {
  switch (stringOf(toolCall.kind) ?? UNKINDED) {
    case 'read': return { tool: 'Read', command: null };
    case 'execute':
      if (!runsInside(toolCall, runDir)) return { unnamed: OUTSIDE_RUN_DIR };
      return { tool: SHELL_TOOL, command: stringOf(stringOf(recordOf(toolCall.rawInput)?.command)?.trim()) };
    case 'search': return searchesFiles(toolCall) ? { tool: 'Grep', command: null } : { unnamed: OUTSIDE_GRANT };
    case UNKINDED: {
      const tool = runToolOf(toolCall, tools);
      return tool === null ? { unnamed: OUTSIDE_GRANT } : { tool: `${SERVER_GRANT}__${tool}`, command: null };
    }
    default: return { unnamed: OUTSIDE_GRANT };
  }
}

/** The id of the first option of this kind the agent offered. */
function optionOf(options: unknown, kind: string): string | null {
  const offered = Array.isArray(options) ? options.map(recordOf) : [];
  return stringOf(offered.find((option) => option?.kind === kind)?.optionId);
}

/**
 * How to answer a permission request, and why the call was refused where it was.
 *
 * `toolCall` is the call as the agent has described it across the session. A
 * request for another session, or one that offers no way to allow the call
 * once, is refused. A refusal selects the agent's reject-once option, and
 * cancels the request when the agent offers none.
 */
export function answerPermission(
  grant: Pick<RunGrant, 'rules' | 'runDir'>,
  tools: ReadonlySet<string>,
  sessionId: string | null,
  params: Record<string, unknown>,
  toolCall: Record<string, unknown>,
): { outcome: PermissionOutcome; refusal: string | null } {
  const refusal = ((): string | null => {
    if (sessionId === null || params.sessionId !== sessionId) return OUTSIDE_GRANT;
    const call = grantCallOf(toolCall, tools, grant.runDir);
    if ('unnamed' in call) return call.unnamed;
    if (!grantsCall(grant.rules, call.tool, call.command)) return OUTSIDE_GRANT;
    return optionOf(params.options, ALLOW_ONCE) === null ? NO_ALLOW_ONCE : null;
  })();
  if (refusal === null) return { outcome: { outcome: 'selected', optionId: optionOf(params.options, ALLOW_ONCE)! }, refusal };
  const reject = optionOf(params.options, REJECT_ONCE);
  return { outcome: reject === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: reject }, refusal };
}
