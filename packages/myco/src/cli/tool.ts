import fs from 'node:fs';
import { StreamableHTTPClientTransport, type Client } from '@modelcontextprotocol/client';
import { credentialRequiredError } from '@myco/mcp/credential-refusal.js';
import { declaredCredentialSource, deploymentTransport, resolveDeploymentUpstream, withoutCredentialFlag } from '@myco/mcp/deployment-upstream.js';
import { extractStructuredResult, withMcpClient as withTransportClient, type ToolCallError, type ToolCallOutcome } from '@myco/mcp/client-call.js';
import { CREDENTIAL_FLAG, type CredentialSource } from '@myco/member/constants.js';

/** CLI client of the member's Deployment MCP surface. */

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

export async function run(args: string[], _vaultDir: string): Promise<void> {
  let source: CredentialSource | null;
  try {
    source = declaredCredentialSource(args);
  } catch (error) {
    await writeEnvelope({ ok: false, error: { code: 'invalid_arguments', message: (error as Error).message } });
    process.exitCode = 1;
    return;
  }
  if (source === null) {
    await writeEnvelope({ ok: false, error: credentialRequiredError('tool') });
    process.exitCode = 1;
    return;
  }
  const [subcommand, ...rest] = withoutCredentialFlag(args);
  const json = rest.includes('--json');

  if (subcommand === 'list') {
    const listed = await withMcpClient(source, (client) => client.listTools());
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
    // Null input is an empty argument object.
    if (input === null) input = {};
    // MCP arguments must be an object.
    if (typeof input !== 'object' || Array.isArray(input)) {
      await writeEnvelope({
        ok: false,
        tool,
        error: { code: 'invalid_input', message: 'Tool arguments must be a JSON object' },
      });
      process.exitCode = 1;
      return;
    }

    const called = await withMcpClient(source, (client) =>
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

async function transportFor(source: CredentialSource): Promise<{ ok: true; transport: StreamableHTTPClientTransport } | { ok: false; error: ToolCliError }> {
  const upstream = resolveDeploymentUpstream(source, { cwd: process.cwd(), env: process.env, invokedBy: 'tool' });
  if (!upstream) return { ok: false, error: { code: 'credential_unavailable', message: `No member credential resolves for ${CREDENTIAL_FLAG} ${source}; the reason is on stderr.` } };
  return { ok: true, transport: deploymentTransport(upstream) };
}

/** Run `fn` against a fresh client over this invocation's transport, and close. */
async function withMcpClient<T>(
  source: CredentialSource,
  fn: (client: Client) => Promise<T>,
): Promise<ToolCallOutcome<T>> {
  const resolved = await transportFor(source);
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
