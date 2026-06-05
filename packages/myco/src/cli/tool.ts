import fs from 'node:fs';
import { DaemonClient } from '@myco/hooks/client.js';
import { COLLECTIVE_TOOL_DEFINITIONS, TOOL_DEFINITIONS } from '@myco/tools/definitions.js';
import { isToolError } from '@myco/tools/error.js';
import { requestContextFromEnvironment } from '@myco/grove/request-context.js';
import { isCollectiveEnabled } from '@myco/tools/shared.js';

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

export async function run(args: string[], vaultDir: string): Promise<void> {
  const [subcommand, ...rest] = args;
  const json = rest.includes('--json');

  if (subcommand === 'list') {
    const definitions = await listToolDefinitions(vaultDir);
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

    try {
      const input = parseInput(parsed.input ?? '{}');
      const { createMycoTools } = await import('@myco/tools/index.js');
      // Launch-context tenancy: `vaultDir` was resolved by walking up from the
      // caller's cwd to this project's `.myco`, so a registered Grove-bound
      // manifest here is the caller asserting THIS project — accepted by the
      // tenancy guard without any env from the agent or user. Falls back to
      // 'synthesized' (→ rejected) for an unregistered/unbound launch context.
      const requestContext = requestContextFromEnvironment(process.env, vaultDir, {
        launchContextTenancy: true,
      });
      const tools = createMycoTools(vaultDir, new DaemonClient(vaultDir), { requestContext });
      const result = await tools.callTool(tool, input);
      await writeEnvelope({ ok: true, tool, result });
    } catch (error) {
      await writeEnvelope({
        ok: false,
        tool,
        error: {
          code: classifyError(error),
          message: (error as Error).message,
        },
      });
      process.exitCode = 1;
    }
    return;
  }

  await writeEnvelope({ ok: false, error: { code: 'unknown_command', message: 'Usage: tool <list|call> [args]' } });
  process.exitCode = 1;
}

async function listToolDefinitions(vaultDir: string) {
  return await isCollectiveEnabled(new DaemonClient(vaultDir))
    ? [...TOOL_DEFINITIONS, ...COLLECTIVE_TOOL_DEFINITIONS]
    : TOOL_DEFINITIONS;
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
    throw new ToolJsonError(`Invalid JSON input: ${(error as Error).message}`);
  }
}

class ToolJsonError extends Error {}

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

function classifyError(error: unknown): string {
  if (isToolError(error)) return error.code;
  if (error instanceof ToolJsonError) return 'invalid_json';
  return 'tool_call_failed';
}
