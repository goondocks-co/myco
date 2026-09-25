import fs from 'node:fs';
import { StreamableHTTPClientTransport, type Client } from '@modelcontextprotocol/client';
import { DaemonClient } from '@myco/daemon/client.js';
import { buildBridgeRequestHeaders } from '@myco/mcp/stdio-bridge.js';
import { declaredCredentialSource, deploymentTransport, resolveDeploymentUpstream, withoutCredentialFlag } from '@myco/mcp/deployment-upstream.js';
import { extractStructuredResult, withMcpClient as withTransportClient, type ToolCallError, type ToolCallOutcome } from '@myco/mcp/client-call.js';
import { CREDENTIAL_FLAG, type CredentialSource } from '@myco/member/constants.js';

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

type ToolCliError = ToolCallError;

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
    const result = extractStructuredResult(called.value);
    await writeEnvelope({ ok: true, tool, result });
    return;
  }

  await writeEnvelope({ ok: false, error: { code: 'unknown_command', message: 'Usage: tool <list|call> [args]' } });
  process.exitCode = 1;
}

/**
 * The transport for this invocation: the Deployment when a credential source
 * is declared, the local daemon otherwise. The daemon is `ensureRunning()`
 * first (spawned or recovered like every other daemon-backed CLI path), and a
 * daemon that still does not answer is a clear error rather than a hung
 * connection attempt.
 */
async function transportFor(vaultDir: string, source: CredentialSource | null): Promise<{ ok: true; transport: StreamableHTTPClientTransport } | { ok: false; error: ToolCliError }> {
  if (source !== null) {
    const upstream = resolveDeploymentUpstream(source, { cwd: process.cwd(), env: process.env, invokedBy: 'tool' });
    if (!upstream) return { ok: false, error: { code: 'credential_unavailable', message: `No member credential resolves for ${CREDENTIAL_FLAG} ${source}; the reason is on stderr.` } };
    return { ok: true, transport: deploymentTransport(upstream) };
  }
  const daemonClient = new DaemonClient(vaultDir);
  const ready = await daemonClient.ensureRunning();
  const info = daemonClient.getInfo();
  if (!ready || !info) return { ok: false, error: { code: 'daemon_unavailable', message: DAEMON_UNAVAILABLE_MESSAGE } };
  const headers = buildBridgeRequestHeaders(vaultDir, process.env, info.auth_token);
  return { ok: true, transport: new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.port}/mcp`), { requestInit: { headers } }) };
}

/** Run `fn` against a fresh client over this invocation's transport, and close. */
async function withMcpClient<T>(
  vaultDir: string,
  source: CredentialSource | null,
  fn: (client: Client) => Promise<T>,
): Promise<ToolCallOutcome<T>> {
  const resolved = await transportFor(vaultDir, source);
  if (!resolved.ok) return resolved;
  return withTransportClient(resolved.transport, fn);
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
