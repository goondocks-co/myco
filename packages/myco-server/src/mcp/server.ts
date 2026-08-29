/**
 * The MCP protocol server for one request.
 *
 * `tools/list` answers the definitions as written. `tools/call` validates the
 * arguments against the definition, resolves the op through the registry, and
 * runs the handler with the caller's context. A failure the caller can act on
 * — bad arguments, an unknown tool, an op not yet served, a storage fault — is
 * a JSON-RPC error whose `data.code` names it; the member-side CLI and bridge
 * classify on that code (`packages/myco/src/cli/tool.ts` `classifyMcpError`).
 * A result carries the serialized text for an agent and the raw value under
 * `structuredContent.result` for a client that wants the shape entire.
 *
 * The low-level `Server` is used deliberately: the SDK's `McpServer` answers a
 * thrown error as an `isError` result, which drops the code the clients key on.
 */
import { ProtocolError, Server, type Tool } from '@modelcontextprotocol/server';
import { isServedTool, type ServedTool } from '../core/tool-catalogue.js';
import { emit } from '../telemetry.js';
import type { ToolContext } from './context.js';
import { TOOL_DEFINITIONS, definitionOf } from './definitions.js';
import { entryFor, opOf } from './registry.js';
import { normalizeInput, ToolError, validateInput, type ToolInput } from './validate.js';

export const SERVER_NAME = 'myco';
/** The JSON-RPC error code every tool failure answers with; `data.code` carries the name. */
export const TOOL_ERROR_CODE = -32000;

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

/** Run one tool call for this context: validation, op resolution, the handler. Every failure leaves as a `ToolError`. */
export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<{ tool: ServedTool; op: string; result: unknown }> {
  if (!isServedTool(name)) throw new ToolError('unknown_tool', `Unknown tool: ${name}`);
  const definition = definitionOf(name)!;
  const input = declaredOnly(definition, normalizeInput(args));
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
  const server = new Server({ name: SERVER_NAME, version }, { capabilities: { tools: {} } });

  server.setRequestHandler('tools/list', () => ({ tools: TOOL_DEFINITIONS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema as unknown as Tool['inputSchema'], annotations: d.annotations })) }));

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const { tool, op, result } = await callTool(ctx, name, args);
      emit({ kind: 'mcp_tool', tool, op, status: 'ok', memberId: ctx.memberId, tokenId: ctx.tokenId });
      return { content: [{ type: 'text' as const, text: serializeResult(tool, result) }], structuredContent: { result } };
    } catch (err) {
      if (!(err instanceof ToolError)) onFailure(err);
      const failure = err instanceof ToolError ? err : new ToolError('tool_call_failed', 'the Deployment could not complete the call');
      emit({ kind: 'mcp_tool', tool: name, status: failure.code, memberId: ctx.memberId, tokenId: ctx.tokenId });
      throw toolError(failure);
    }
  });

  return server;
}
