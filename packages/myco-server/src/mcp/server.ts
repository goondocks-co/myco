/**
 * The MCP protocol server for one request.
 *
 * `tools/list` answers the definitions as written — every served tool to a
 * member, the allowlisted ones to a grant. `tools/call` validates the
 * arguments against the definition, resolves the op through the registry, and
 * runs the handler with the caller's context. A failure the caller can act on
 * — bad arguments, an unknown tool, an op not yet served, a storage fault — is
 * a JSON-RPC error whose `data.code` names it; the member-side CLI and bridge
 * classify on that code (`packages/myco/src/cli/tool.ts` `classifyMcpError`).
 * A result carries the serialized text for an agent and the raw value under
 * `structuredContent.result` for a client that wants the shape entire.
 *
 * A grant is judged before validation: a (tool, op) off the external
 * allowlist, or a `project_id` naming any Project but the grant's own, is
 * refused exactly as a tool that does not exist — a probing caller cannot
 * tell "not on this surface" from "not a tool", and the refusal names nothing
 * about any Project.
 *
 * The low-level `Server` is used deliberately: the SDK's `McpServer` answers a
 * thrown error as an `isError` result, which drops the code the clients key on.
 */
import { ProtocolError, Server, SUPPORTED_PROTOCOL_VERSIONS, type Tool } from '@modelcontextprotocol/server';
import { isServedTool, type ServedTool } from '../core/tool-catalogue.js';
import { emit } from '../telemetry.js';
import { principalFields, type ToolContext } from './context.js';
import { TOOL_DEFINITIONS, definitionOf, type ToolDefinition } from './definitions.js';
import { externalDefinitions, isExternalCall } from './external.js';
import { entryFor, opOf } from './registry.js';
import { normalizeInput, ToolError, unknownTool, validateInput, type ToolInput } from './validate.js';

export const SERVER_NAME = 'myco';
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

/** A digest result answers its text alone; every other result answers its JSON. */
export function serializeResult(tool: ServedTool, result: unknown): string {
  if (tool === 'myco_cortex' && isDigest(result)) return result.content;
  return JSON.stringify(result);
}

const isDigest = (r: unknown): r is { content: string; tier: number; fallback: boolean } =>
  typeof r === 'object' && r !== null
  && typeof (r as { content?: unknown }).content === 'string'
  && typeof (r as { tier?: unknown }).tier === 'number'
  && typeof (r as { fallback?: unknown }).fallback === 'boolean';

const toolError = (err: ToolError): ProtocolError => new ProtocolError(TOOL_ERROR_CODE, err.message, { code: err.code });

/** The arguments the definition declares; an undeclared key never reaches a handler, so no tool answers to an argument its schema does not name. */
const declaredOnly = (definition: { inputSchema: { properties: Record<string, unknown> } }, input: ToolInput): ToolInput =>
  Object.fromEntries(Object.entries(input).filter(([key]) => key in definition.inputSchema.properties));

/** The definitions this principal is served. */
export function definitionsFor(ctx: ToolContext): readonly ToolDefinition[] {
  return ctx.principal.kind === 'grant' ? externalDefinitions() : TOOL_DEFINITIONS;
}

/** Run one tool call for this context: the grant's surface, validation, op resolution, the handler. Every failure leaves as a `ToolError`. */
export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<{ tool: ServedTool; op: string; result: unknown }> {
  if (!isServedTool(name)) throw unknownTool(name);
  const definition = definitionOf(name)!;
  const raw = normalizeInput(args);
  const external = ctx.principal.kind === 'grant';
  if (external && raw.project_id !== undefined && raw.project_id !== ctx.projectId) throw unknownTool(name);
  const input = declaredOnly(definition, raw);
  if (external && !isExternalCall(name, opOf(name, input))) throw unknownTool(name);
  validateInput(definition, input);
  const op = opOf(name, input);
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
  const server = new Server({ name: SERVER_NAME, version }, { capabilities: { tools: {} }, supportedProtocolVersions: [...SERVED_PROTOCOL_VERSIONS] });

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
