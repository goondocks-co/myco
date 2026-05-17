import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getPluginVersion } from '../version.js';
import { TOOL_CORTEX, type ToolDefinition } from '../tools/definitions.js';
import { type MycoTools } from '../tools/index.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import type { Logger } from '../daemon/logger.js';

export interface McpProtocolServerOptions {
  /**
   * Optional structured logger. When provided, every CallTool dispatch
   * leaves at least one info-level entry (success) or warn-level entry
   * (error). Mirrors the `hooks.*` log shape so the same investigation
   * procedure works for /events and /mcp. See issue #288.
   */
  logger?: Logger;
  /** Session id from the request context, surfaced in log payloads. */
  sessionId?: string | null;
}

export function createMcpProtocolServer(tools: MycoTools, options: McpProtocolServerOptions = {}): Server {
  const { logger, sessionId } = options;
  const server = new Server(
    { name: 'myco', version: getPluginVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const listed = (await tools.listTools()) as ToolDefinition[];
    logger?.debug(LOG_KINDS.MCP_LIST, 'MCP tools listed', {
      tool_count: listed.length,
      session_id: sessionId ?? undefined,
      request_id: extra.requestId,
    });
    return { tools: listed };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    // Demoted to debug: the per-call info log was 2 sync fs.writeSync
    // hits on the dispatch hot path (received + completed). The
    // `completed` info log below still carries tool_name + status, so
    // an operator can `grep mcp.call` and see one entry per call.
    // Verbose tracing remains available via debug.
    logger?.debug(LOG_KINDS.MCP_CALL, 'MCP tool call received', {
      tool_name: name,
      session_id: sessionId ?? undefined,
      request_id: extra.requestId,
    });
    try {
      const result = await tools.callTool(name, args);
      logger?.info(LOG_KINDS.MCP_CALL, 'MCP tool call completed', {
        tool_name: name,
        session_id: sessionId ?? undefined,
        request_id: extra.requestId,
        status: 'ok',
      });
      return { content: [{ type: 'text', text: serializeToolResult(name, result) }] };
    } catch (err) {
      const error = err as Error;
      logger?.warn(LOG_KINDS.MCP_CALL, 'MCP tool call failed', {
        tool_name: name,
        session_id: sessionId ?? undefined,
        request_id: extra.requestId,
        status: 'error',
        error_class: error?.name ?? 'Error',
        // First line only — keep grep-friendly. Full stack stays out of the log.
        error_message: (error?.message ?? String(err)).split('\n', 1)[0],
      });
      throw err;
    }
  });

  return server;
}

export function serializeToolResult(name: string, result: unknown): string {
  if (name === TOOL_CORTEX && isDigestResult(result)) return result.content;
  return JSON.stringify(result);
}

function isDigestResult(result: unknown): result is { content: string; tier: number; fallback: boolean } {
  return typeof result === 'object'
    && result !== null
    && typeof (result as { content?: unknown }).content === 'string'
    && typeof (result as { tier?: unknown }).tier === 'number'
    && typeof (result as { fallback?: unknown }).fallback === 'boolean';
}
