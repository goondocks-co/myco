import fs from 'node:fs';
import { Client, ProtocolError, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DaemonClient } from '@myco/daemon/client.js';
import { buildBridgeRequestHeaders } from '@myco/mcp/stdio-bridge.js';
import { declaredCredentialSource, deploymentTransport, resolveDeploymentUpstream } from '@myco/mcp/deployment-upstream.js';
import { CREDENTIAL_FLAG, type CredentialSource } from '@myco/member/constants.js';
import { getPluginVersion } from '@myco/version.js';

/**
 * `myco tool list` / `myco tool call` — decision-14e572a3: the CLI is a thin
 * MCP client of the LOCAL daemon's `/mcp`, always. It never opens the vault
 * or dispatches tools in-process (that path — `createMycoTools` called
 * directly from this file — silently read the wrong data for an attached
 * project, since the local vault has no knowledge of a host-served Grove;
 * the daemon's `/mcp` handler is the one place that already knows how to
 * route an attached project's calls to its host, `mcp/http.ts`'s
 * `classifyRoute` chokepoint).
 *
 * Transport choice: the standard MCP SDK client (`StreamableHTTPClientTransport`
 * + `Client`) against a fresh connection per invocation — `mcp/http.ts` already
 * builds a stateless `StreamableHTTPServerTransport` per POST, so no hand-rolled
 * JSON-RPC is needed. The one gap the plain SDK client left was fidelity: the
 * standard `content: [{type:'text', ...}]` tool-call reply is intentionally
 * lossy for human/agent consumption (e.g. `myco_cortex` digest returns only the
 * digest text, not `{content, tier, fallback}`), and a thrown `ToolError`'s
 * string `code` doesn't survive the SDK's generic JSON-RPC error mapping.
 * Both gaps are closed with small ADDITIVE changes to the existing `/mcp`
 * surface instead of a bespoke fallback route: `mcp/server.ts` now also sets
 * the spec-legal `structuredContent: { result }` on every successful call
 * (ignored by clients that don't look for it), and `ToolError` now sets a
 * `.data` field the SDK's error-response builder already knows to forward.
 */

interface ToolCliError {
  code: string;
  message: string;
}

interface ToolCliEnvelope {
  ok: boolean;
  tool?: string;
  result?: unknown;
  error?: ToolCliError;
}

interface ParsedCallArgs {
  tool?: string;
  input?: string;
}

const DAEMON_UNAVAILABLE_MESSAGE =
  'The Myco daemon is not running and could not be started automatically. '
  + 'Run `myco doctor` to diagnose, or `myco service start` to start it, then try again.';

/** The credential flag and its value removed from an argument list; the flag names the Deployment path and is no tool argument. */
export function withoutCredentialFlag(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === CREDENTIAL_FLAG) { i++; continue; }
    if (arg.startsWith(`${CREDENTIAL_FLAG}=`)) continue;
    out.push(arg);
  }
  return out;
}

export async function run(args: string[], vaultDir: string): Promise<void> {
  let source: CredentialSource | null;
  try {
    source = declaredCredentialSource(args);
  } catch (error) {
    await writeEnvelope({ ok: false, error: { code: 'invalid_arguments', message: (error as Error).message } });
    process.exitCode = 1;
    return;
  }
  const [subcommand, ...rest] = withoutCredentialFlag(args);
  const json = rest.includes('--json');

  if (subcommand === 'list') {
    const listed = await withMcpClient(vaultDir, source, (client) => client.listTools());
    if (!listed.ok) {
      await writeEnvelope({ ok: false, error: listed.error });
      process.exitCode = 1;
      return;
    }
    const definitions = listed.value.tools;
    if (json) {
      await writeEnvelope({ ok: true, result: definitions });
      return;
    }
    for (const definition of definitions) console.log(definition.name);
    return;
  }

  if (subcommand === 'call') {
    let parsed: ParsedCallArgs;
    try {
      parsed = parseCallArgs(rest);
    } catch (error) {
      await writeEnvelope({ ok: false, error: { code: 'invalid_arguments', message: (error as Error).message } });
      process.exitCode = 1;
      return;
    }
    const tool = parsed.tool;
    if (!tool) {
      await writeEnvelope({ ok: false, error: { code: 'missing_tool', message: 'Usage: tool call <tool-name> --json --input <json|@file>' } });
      process.exitCode = 1;
      return;
    }

    let input: unknown;
    try {
      input = parseInput(parsed.input ?? '{}');
    } catch (error) {
      await writeEnvelope({ ok: false, tool, error: { code: 'invalid_json', message: (error as Error).message } });
      process.exitCode = 1;
      return;
    }
    // Parity with the shared dispatcher's `normalizeInput` (tools/index.ts):
    // `--input null` has always meant "no arguments" ({}), exactly like an
    // omitted --input. Only a non-null non-object (string, number, array)
    // is invalid.
    if (input === null) input = {};
    // The wire contract (both the MCP `arguments` record schema and the
    // shared dispatcher's own `normalizeInput`) requires a JSON object.
    // Checked here — rather than round-tripped to the daemon — because the
    // MCP SDK client validates outgoing `arguments` against a strict
    // `record` schema; sending a non-object would fail as a generic
    // transport/schema error, losing the specific `invalid_input` code the
    // in-process dispatcher produced for the same input.
    if (typeof input !== 'object' || Array.isArray(input)) {
      await writeEnvelope({
        ok: false,
        tool,
        error: { code: 'invalid_input', message: 'Tool arguments must be a JSON object' },
      });
      process.exitCode = 1;
      return;
    }

    const called = await withMcpClient(vaultDir, source, (client) =>
      client.callTool({ name: tool, arguments: input as Record<string, unknown> }));
    if (!called.ok) {
      await writeEnvelope({ ok: false, tool, error: called.error });
      process.exitCode = 1;
      return;
    }
    let result = extractStructuredResult(called.value);
    // The Deployment serves instructions bare; how this host reaches the
    // tools is this host's own knowledge, so the CLI renders the directive.
    if (source !== null && tool === 'myco_cortex' && (input as { op?: unknown }).op === 'instructions') result = await withCliTransportDirective(result);
    await writeEnvelope({ ok: true, tool, result });
    return;
  }

  await writeEnvelope({ ok: false, error: { code: 'unknown_command', message: 'Usage: tool <list|call> [args]' } });
  process.exitCode = 1;
}

/**
 * Connect to the LOCAL daemon's `/mcp` over a fresh stateless transport, run
 * `fn`, and close. Daemon-down UX per decision-14e572a3: `ensureRunning()`
 * first (spawns/recovers exactly like every other daemon-backed CLI path),
 * then a clear, actionable error instead of a hung connection attempt.
 */
/** Prefix an instructions result with the CLI transport directive, the way the daemon does for a CLI caller. */
async function withCliTransportDirective(result: unknown): Promise<unknown> {
  if (!result || typeof result !== 'object') return result;
  const body = result as { content?: unknown };
  if (typeof body.content !== 'string' || !body.content.trim()) return result;
  const { cliToolTransportDirective } = await import('@myco/context/cortex-injection-context.js');
  const { resolveBinary } = await import('@myco/runtime/binary-resolution.js');
  return { ...body, content: `${cliToolTransportDirective(resolveBinary('instruction', { kind: 'machine' }).path)}\n\n${body.content}` };
}

/** The transport for this invocation: the Deployment when a credential source is declared, the local daemon otherwise. */
async function transportFor(vaultDir: string, source: CredentialSource | null): Promise<{ ok: true; transport: StreamableHTTPClientTransport } | { ok: false; error: ToolCliError }> {
  if (source !== null) {
    const upstream = resolveDeploymentUpstream(source, { env: process.env });
    if (!upstream) return { ok: false, error: { code: 'credential_unavailable', message: `No member credential resolves for ${CREDENTIAL_FLAG} ${source}; the reason is on stderr.` } };
    return { ok: true, transport: deploymentTransport(upstream, { 'x-myco-tool-transport': 'cli' }) };
  }
  const daemonClient = new DaemonClient(vaultDir);
  const ready = await daemonClient.ensureRunning();
  const info = daemonClient.getInfo();
  if (!ready || !info) return { ok: false, error: { code: 'daemon_unavailable', message: DAEMON_UNAVAILABLE_MESSAGE } };
  const headers = {
    ...buildBridgeRequestHeaders(vaultDir, process.env, info.auth_token),
    // Marks this /mcp caller as shell-CLI so tool responses that carry
    // transport guidance (myco_cortex op:instructions) render the CLI form.
    'x-myco-tool-transport': 'cli',
  };
  return { ok: true, transport: new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.port}/mcp`), { requestInit: { headers } }) };
}

async function withMcpClient<T>(
  vaultDir: string,
  source: CredentialSource | null,
  fn: (client: Client) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: ToolCliError }> {
  const resolved = await transportFor(vaultDir, source);
  if (!resolved.ok) return resolved;
  const transport = resolved.transport;
  const client = new Client({ name: 'myco-cli', version: getPluginVersion() });
  try {
    await client.connect(transport);
    const value = await fn(client);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: classifyMcpError(error) };
  } finally {
    await client.close().catch(() => { /* best-effort */ });
  }
}

/** Pull the daemon's full raw tool result back out of a `CallToolResult`.
 *  `structuredContent.result` is the primary path (set by `mcp/server.ts`
 *  for every successful call). Falls back to parsing the human-readable
 *  `content` text — reached only against an older daemon build (e.g. an
 *  attached project's host mid-upgrade) that predates the
 *  `structuredContent` addition. */
type ToolCallResult = Awaited<ReturnType<Client['callTool']>>;

function extractStructuredResult(response: ToolCallResult): unknown {
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
 * Translate an error thrown by the MCP client into the CLI's stable error
 * envelope. Three shapes reach here:
 *
 *   - `ProtocolError` — a JSON-RPC error response from a dispatched tool call
 *     (unknown tool, invalid input, a tool's own failure), OR a member-side
 *     Team Host refusal (`host_unreachable` / `host_auth_rejected` /
 *     `host_protocol_mismatch` — schema-valid since the proxy echoes the
 *     request id, so the SDK classifies them as proper JSON-RPC errors).
 *     `.data.code` carries the original code (see `tools/error.ts` and
 *     `daemon/host-proxy.ts` `mcpSoftFail`).
 *   - `SdkHttpError` — a non-2xx HTTP response the transport never got to
 *     parse as JSON-RPC: the Deployment pipeline's refusals in the `answered`
 *     shape (`no_project`, `body_cap`, `unavailable`), and the local `/mcp`
 *     handler's pre-dispatch refusals (`legacy_vault` 503, `foreign_grove`
 *     403, `unknown_tenancy` 404 — see `mcp/http.ts`). The response body
 *     travels as `data.text`; the same structured `{code, message}` is
 *     recovered from it. A 401 is the credential itself refused —
 *     `unauthorized` — and anything else a generic `tool_call_failed` with
 *     the status.
 */
function classifyMcpError(error: unknown): ToolCliError {
  if (error instanceof ProtocolError) {
    const data = error.data as { code?: unknown } | undefined;
    const code = typeof data?.code === 'string' ? data.code : 'tool_call_failed';
    const message = error.message.replace(/^MCP error -?\d+: /, '');
    const hint = HOST_REFUSAL_HINTS[code];
    return { code, message: hint ? `${message} ${hint}` : message };
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

/** Recover `{code, message}` from a JSON-RPC error body the transport surfaced
 *  as text for a non-2xx that never reached the JSON-RPC dispatcher. Returns
 *  null when the body isn't the expected `{error:{message, data:{code}}}` shape. */
function extractStructuredHttpError(text: string): ToolCliError | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  try {
    const body = JSON.parse(text.slice(start)) as { error?: { message?: string; data?: { code?: unknown } } };
    const code = body.error?.data?.code;
    const msg = body.error?.message;
    if (typeof code === 'string' && typeof msg === 'string') return { code, message: msg };
  } catch {
    // Not JSON — fall through to the generic message.
  }
  return null;
}

function parseCallArgs(args: string[]): ParsedCallArgs {
  const parsed: ParsedCallArgs = {};
  for (let idx = 0; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === '--json') continue;
    if (arg === '--input') {
      const value = args[idx + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --input');
      }
      parsed.input = value;
      idx++;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (parsed.tool) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    parsed.tool = arg;
  }
  return parsed;
}

function parseInput(value: string): unknown {
  const raw = value.startsWith('@')
    ? fs.readFileSync(value.slice(1), 'utf-8')
    : value;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON input: ${(error as Error).message}`);
  }
}

function writeEnvelope(envelope: ToolCliEnvelope): Promise<void> {
  return writeStdout(`${JSON.stringify(envelope, null, 2)}\n`);
}

function writeStdout(output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
