/**
 * The MCP protocol server for one request.
 *
 * `tools/list` answers the definitions as written — every served tool to a
 * member, the allowlisted ones to a grant, a run's task-declared ones to a
 * run. `tools/call` validates the
 * arguments against the definition, resolves the op through the registry, and
 * runs the handler with the caller's context. A failure the caller can act on
 * — bad arguments, an unknown tool, an op not yet served, a storage fault — is
 * a JSON-RPC error whose `data.code` names it; the member-side CLI and bridge
 * classify on that code (`packages/myco/src/cli/tool.ts` `classifyMcpError`).
 * A result carries the serialized text for an agent and the raw value under
 * `structuredContent.result` for a client that wants the shape entire.
 *
 * A grant and a run are judged before validation: a (tool, op) off the
 * principal's allowlist, or a `project` naming any Project but the
 * principal's own, is refused exactly as a tool that does not exist — a
 * probing caller cannot tell "not on this surface" from "not a tool", and the
 * refusal names nothing about any Project. A write that names no Project at
 * all is refused here too, for every principal whose credential is not already
 * bound to one. This is the one chokepoint: no handler judges a principal's
 * surface, or its tenancy, for itself.
 *
 * The low-level `Server` is used deliberately: the SDK's `McpServer` answers a
 * thrown error as an `isError` result, which drops the code the clients key on.
 */
import { ProtocolError, Server, SUPPORTED_PROTOCOL_VERSIONS, type Tool } from '@modelcontextprotocol/server';
import { isServedTool, isWriteOp, PROJECT_PIVOT, type ServedTool } from '../core/tool-catalogue.js';
import { emit } from '../telemetry.js';
import { normalizeRemote, projectForRemote } from '../core/remotes.js';
import { boundProject, namedProject, principalFields, type ToolContext } from './context.js';
import { TOOL_DEFINITIONS, definitionOf, type ToolDefinition } from './definitions.js';
import { externalDefinitions, isExternalCall } from './external.js';
import { entryFor, opOf } from './registry.js';
import { isRunCall, runDefinitions } from './run-surface.js';
import { normalizeInput, ToolError, unknownTool, validateInput, type ToolInput } from './validate.js';

export const SERVER_NAME = 'myco';

/**
 * What the Deployment tells a client about itself at `initialize`.
 *
 * A client reads this once, before any `tools/list`, and it is the only place
 * the tenancy rule can reach an agent that never starts a Myco-hooked session.
 * Held under `SERVER_INSTRUCTIONS_MAX_BYTES` by `mcp.test.ts`: it rides every
 * handshake, and a long one costs the agent context before it has asked
 * anything.
 */
export const SERVER_INSTRUCTIONS = [
  'Myco is this project\'s memory: sessions that happened, spores (durable observations), and plans.',
  '',
  'Tenancy: every tool takes `project` — a project id, or the repository\'s git remote. A read without it uses the project this credential is bound to. A write without it is refused. An argument a tool\'s schema does not declare is refused by name.',
  '',
  'Reach for it when you need why rather than what: a prior decision, a gotcha, how a subsystem came to be this way. Search with `myco_search`, then fetch a hit in full by its id with `myco_spores`, `myco_plans` or `myco_sessions`. Record a durable finding with `myco_spores` op "save"; keep plans current with `myco_plans` op "save".',
  '',
  '`myco_cortex` op "instructions" returns this project\'s standing guidance and its project id.',
].join('\n');

/** The ceiling on what rides every handshake. */
export const SERVER_INSTRUCTIONS_MAX_BYTES = 2048;
/** The JSON-RPC error code every tool failure answers with; `data.code` carries the name. */
export const TOOL_ERROR_CODE = -32000;
/**
 * The first protocol revision of the SDK's modern era. The Deployment serves the
 * revisions before it, by declaration: the low-level `Server` registers a
 * `server/discover` handler exactly when a modern revision is in its list, and
 * a client that hears a discover answer skips the `initialize` handshake and
 * envelopes its requests — a dialect the per-request JSON transport does not
 * speak. The SDK's own default list holds no modern revision today; the filter
 * keeps that true whatever the default becomes, and `mcp.test.ts` pins it.
 */
export const FIRST_MODERN_REVISION = '2026-07-28';
/** Every revision the Deployment serves; a client probing for a later era is answered method-not-found and runs the legacy handshake. */
export const SERVED_PROTOCOL_VERSIONS: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS.filter((v) => v < FIRST_MODERN_REVISION);

/** Every result answers its JSON. */
export function serializeResult(_tool: ServedTool, result: unknown): string {
  return JSON.stringify(result);
}

const toolError = (err: ToolError): ProtocolError => new ProtocolError(TOOL_ERROR_CODE, err.message, { code: err.code });

/**
 * The refusal for a write that names no Project.
 *
 * A member credential reaches every Project of the Deployment and a read falls
 * back to the request's own Project, so an unnamed write would land wherever
 * the transport happened to point. It is the caller's own argument fault and
 * the message says how to fix it, which is what separates it from the
 * `unknown_tool` a caller gets for a surface it may not see.
 */
const missingProject = (tool: string): ToolError =>
  new ToolError('invalid_input', `Missing required argument '${PROJECT_PIVOT}' for tool ${tool}: a write names the project id or the repository's git remote`);

/**
 * Whether a bound principal's tenancy argument names its own Project by the
 * repository's git remote rather than by the id.
 *
 * `SERVER_INSTRUCTIONS` tells every caller a remote is acceptable, so a run or a
 * grant naming its own Project by remote is admitted rather than answered as a
 * tool that does not exist. One primary-key lookup, and only for a bound
 * principal that named something other than its own id.
 */
async function namesBoundProject(ctx: ToolContext, named: unknown, bound: string): Promise<boolean> {
  if (typeof named !== 'string') return false;
  const remote = normalizeRemote(named);
  return remote !== null && (await projectForRemote(ctx.env.db, remote)) === bound;
}

/** The definitions this principal is served. */
export function definitionsFor(ctx: ToolContext): readonly ToolDefinition[] {
  const p = ctx.principal;
  if (p.kind === 'grant') return externalDefinitions();
  if (p.kind === 'run') return runDefinitions(p.allow);
  return TOOL_DEFINITIONS;
}

/** Run one tool call for this context: the principal's surface, validation, op resolution, the handler. Every failure leaves as a `ToolError`. */
export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<{ tool: ServedTool; op: string; result: unknown }> {
  if (!isServedTool(name)) throw unknownTool(name);
  const definition = definitionOf(name)!;
  const input = normalizeInput(args);
  const bound = boundProject(ctx);
  const named = input[PROJECT_PIVOT];
  if (bound !== null && named !== undefined && named !== bound && !(await namesBoundProject(ctx, named, bound))) throw unknownTool(name);
  const op = opOf(name, input);
  if (ctx.principal.kind === 'grant' && !isExternalCall(name, op)) throw unknownTool(name);
  if (ctx.principal.kind === 'run' && !isRunCall(ctx.principal.allow, name, op)) throw unknownTool(name);
  validateInput(definition, input);
  if (isWriteOp(name, op) && bound === null && namedProject(input) === undefined) throw missingProject(name);
  const entry = entryFor(name, op);
  if (entry === undefined) throw new ToolError('invalid_input', `Unknown op '${op}' for tool ${name}`);
  if ('notServed' in entry) {
    throw new ToolError('not_served', entry.notServed === 'never'
      ? `${name} op '${op}' is not offered by a Deployment`
      : `${name} op '${op}' is not yet served by this Deployment (${entry.notServed})`);
  }
  return { tool: name, op, result: await entry.handler(input, ctx) };
}

/**
 * The protocol server for one request. A failure that is not the caller's — a
 * storage fault — is handed to `onFailure` for the pipeline to answer as
 * retryable, with the JSON-RPC error that leaves the transport standing in.
 */
export function createProtocolServer(ctx: ToolContext, version: string, onFailure: (err: unknown) => void): Server {
  const server = new Server(
    { name: SERVER_NAME, version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS, supportedProtocolVersions: [...SERVED_PROTOCOL_VERSIONS] },
  );

  server.setRequestHandler('tools/list', () => ({ tools: definitionsFor(ctx).map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema as unknown as Tool['inputSchema'], annotations: d.annotations })) }));

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const { tool, op, result } = await callTool(ctx, name, args);
      emit({ kind: 'mcp_tool', tool, op, status: 'ok', ...principalFields(ctx) });
      return { content: [{ type: 'text' as const, text: serializeResult(tool, result) }], structuredContent: { result } };
    } catch (err) {
      if (!(err instanceof ToolError)) onFailure(err);
      const failure = err instanceof ToolError ? err : new ToolError('tool_call_failed', 'the Deployment could not complete the call');
      emit({ kind: 'mcp_tool', tool: isServedTool(name) ? name : 'unknown', status: failure.code, ...principalFields(ctx) });
      throw toolError(failure);
    }
  });

  return server;
}
