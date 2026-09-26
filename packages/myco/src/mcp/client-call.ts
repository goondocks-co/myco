/**
 * One MCP client call over a fresh stateless transport, answered as data.
 *
 * `myco tool` and the member read verbs (`search`, `vectors`, `session`,
 * `stats`) call tools through this, so a person at the CLI and an agent over
 * MCP reach the same served tool on the same chokepoint and get the same
 * answer. It holds no transport choice of its own: the caller hands it the
 * transport (the Deployment's `/mcp` over the member credential, or the local
 * daemon's for a 1.4 install), and it imports neither.
 *
 * The standard `content: [{type:'text'}]` reply is lossy, so the full result
 * is read back from `structuredContent.result`, which the served tools set on
 * every successful call. A thrown tool error's string `code` travels in the
 * JSON-RPC error's `data`.
 */
import { Client, ProtocolError, SdkHttpError, type RequestOptions, type StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getPluginVersion } from '../version.js';

export interface ToolCallError {
  code: string;
  message: string;
}

export type ToolCallOutcome<T> = { ok: true; value: T } | { ok: false; error: ToolCallError };

/**
 * Connect over `transport`, run `fn`, and close; a failure is answered as a
 * classified error, never thrown. `options` holds the connection's handshake
 * and is handed to `fn` for its own requests.
 */
export async function withMcpClient<T>(
  transport: StreamableHTTPClientTransport,
  fn: (client: Client, options: RequestOptions) => Promise<T>,
  options: RequestOptions = {},
): Promise<ToolCallOutcome<T>> {
  const client = new Client({ name: 'myco-cli', version: getPluginVersion() });
  try {
    await client.connect(transport, options);
    return { ok: true, value: await fn(client, options) };
  } catch (error) {
    return { ok: false, error: classifyMcpError(error) };
  } finally {
    await client.close().catch(() => { /* the answer is already decided */ });
  }
}

type ToolCallResult = Awaited<ReturnType<Client['callTool']>>;

/** Call one tool and answer its full raw result. */
export function callTool(
  transport: StreamableHTTPClientTransport,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallOutcome<unknown>> {
  return withMcpClient(transport, async (client) => extractStructuredResult(await client.callTool({ name, arguments: args })));
}

/**
 * The tool's full raw result out of a `CallToolResult`: `structuredContent.result`
 * where the server set it, else the text content parsed as JSON, else the text.
 */
export function extractStructuredResult(response: ToolCallResult): unknown {
  const structuredContent = (response as { structuredContent?: Record<string, unknown> }).structuredContent;
  if (structuredContent && 'result' in structuredContent) {
    return structuredContent.result;
  }
  const content = (response as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content?.find((entry) => entry.type === 'text')?.text;
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Team Host refusal codes (`daemon/host-proxy.ts`'s member-side soft-fails)
 * → the retryability hint appended to their already-friendly messages. The
 * proxy's message says what happened and what to do; the hint says whether
 * plain retry is worth it, which the wire envelope's router-route twin
 * carries as `retryable` but the JSON-RPC envelope does not.
 */
const HOST_REFUSAL_HINTS: Record<string, string> = {
  host_unreachable: 'Retryable — the host may be briefly offline; try again shortly.',
  host_auth_rejected: 'Not retryable until this machine re-joins the host.',
  host_protocol_mismatch: 'Not retryable until the version mismatch is resolved.',
};

/**
 * Translate an error thrown by the MCP client into a stable `{code, message}`.
 * Three shapes reach here:
 *
 *   - `ProtocolError` — a JSON-RPC error response from a dispatched tool call
 *     (unknown tool, invalid input, a tool's own failure), OR a member-side
 *     Team Host refusal (`host_unreachable` / `host_auth_rejected` /
 *     `host_protocol_mismatch`). `.data.code` carries the original code (see
 *     `tools/error.ts` and `daemon/host-proxy.ts` `mcpSoftFail`).
 *   - `SdkHttpError` — a non-2xx HTTP response the transport never got to
 *     parse as JSON-RPC: the Deployment pipeline's refusals in the `answered`
 *     shape (`no_project`, `body_cap`, `unavailable`), and the local `/mcp`
 *     handler's pre-dispatch refusals (`legacy_vault` 503 as a JSON-RPC
 *     error body; `foreign_grove` 403 and `unknown_tenancy` 404 as
 *     `{error, message}` — see `mcp/http.ts`). The response body travels as
 *     `data.text`; the structured `{code, message}` is recovered from either
 *     shape. A 401 is the credential itself refused — `unauthorized` — and
 *     anything else a generic `tool_call_failed` with the status.
 *   - anything else — a connection that never opened, answered as
 *     `tool_call_failed` with its message.
 */
export function classifyMcpError(error: unknown): ToolCallError {
  if (error instanceof ProtocolError) {
    const data = error.data as { code?: unknown } | undefined;
    const code = typeof data?.code === 'string' ? data.code : 'tool_call_failed';
    const hint = HOST_REFUSAL_HINTS[code];
    return { code, message: hint ? `${error.message} ${hint}` : error.message };
  }
  if (error instanceof SdkHttpError) {
    const structured = typeof error.data.text === 'string' ? extractStructuredHttpError(error.data.text) : null;
    if (structured) return structured;
    if (error.status === 401) return { code: 'unauthorized', message: 'The upstream refused the credential (HTTP 401).' };
    return {
      code: 'tool_call_failed',
      message: `The upstream rejected the request (HTTP ${error.status}): ${error.message}`,
    };
  }
  return { code: 'tool_call_failed', message: (error as Error)?.message ?? String(error) };
}

/** Recover `{code, message}` from the body the transport surfaced as text for a
 *  non-2xx that never reached the JSON-RPC dispatcher: a JSON-RPC error body
 *  `{error:{message, data:{code}}}`, or the router-route twin `{error, message}`.
 *  Returns null for anything else. */
function extractStructuredHttpError(text: string): ToolCallError | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  try {
    const body = JSON.parse(text.slice(start)) as { error?: string | { message?: string; data?: { code?: unknown } }; message?: string };
    if (typeof body.error === 'string' && typeof body.message === 'string') return { code: body.error, message: body.message };
    const code = typeof body.error === 'object' ? body.error?.data?.code : undefined;
    const msg = typeof body.error === 'object' ? body.error?.message : undefined;
    if (typeof code === 'string' && typeof msg === 'string') return { code, message: msg };
  } catch {
    // Not JSON — the caller takes the generic message.
  }
  return null;
}
