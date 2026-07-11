import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getPluginVersion } from '../version.js';
import { TOOL_CORTEX, type ToolDefinition } from '../tools/definitions.js';
import { type MycoTools } from '../tools/index.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import type { Logger } from '../daemon/logger.js';

/**
 * Redact secret-shaped substrings out of an error message before it
 * reaches the log file. The log persists indefinitely, so a tool that
 * embeds a bearer token in its error message (the daemon's HTTP fetch
 * helpers wrap upstream responses without scrubbing auth headers; the
 * `setup-llm` paths and a few team-sync paths handle bearer tokens
 * directly) would leak the secret to anyone with log-read access.
 *
 * Patterns are common-prefix forms so we redact tokens regardless of
 * which provider produced them. Replacement keeps the prefix so a
 * grep for `Bearer [REDACTED]` still surfaces the shape.
 */
const SECRET_PATTERNS: { re: RegExp; replacement: string }[] = [
  { re: /Bearer\s+[A-Za-z0-9._-]+/g, replacement: 'Bearer [REDACTED]' },
  { re: /sk-[A-Za-z0-9]{20,}/g, replacement: 'sk-[REDACTED]' },
  { re: /ghp_[A-Za-z0-9]{36,}/g, replacement: 'ghp_[REDACTED]' },
  { re: /auth[_-]?token=[A-Za-z0-9._-]+/gi, replacement: 'auth_token=[REDACTED]' },
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const { re, replacement } of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

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
      return {
        content: [{ type: 'text', text: serializeToolResult(name, result) }],
        // Additive, spec-legal field (CallToolResultSchema#structuredContent):
        // most MCP clients ignore it, so agent-facing `content` is unchanged.
        // `myco tool call` (cli/tool.ts) reads this to recover the FULL raw
        // tool result — `content` alone loses fidelity for shapes like
        // myco_cortex digest, where `serializeToolResult` intentionally
        // returns only the human-readable `content` string and drops
        // `tier`/`fallback`/`generated_at`. Wrapped in `{ result }` so the
        // record-typed schema accepts any underlying shape (array, primitive,
        // or object) uniformly.
        structuredContent: { result },
      };
    } catch (err) {
      const error = err as Error;
      logger?.warn(LOG_KINDS.MCP_CALL, 'MCP tool call failed', {
        tool_name: name,
        session_id: sessionId ?? undefined,
        request_id: extra.requestId,
        status: 'error',
        error_class: error?.name ?? 'Error',
        // First line only — keep grep-friendly. Full stack stays out of
        // the log. Secret-shaped substrings (Bearer tokens, sk-, ghp_,
        // auth_token=) are redacted before the message lands on disk
        // so a tool that surfaces an upstream HTTP error verbatim (the
        // daemon's fetch helpers wrap upstream responses without
        // scrubbing auth headers) doesn't leak credentials to log
        // readers.
        error_message: redactSecrets((error?.message ?? String(err)).split('\n', 1)[0]),
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
