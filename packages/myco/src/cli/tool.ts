import fs from 'node:fs';
import { DaemonClient } from '@myco/hooks/client.js';
import { createMycoTools } from '@myco/tools/index.js';

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
  const tools = createMycoTools(vaultDir, new DaemonClient(vaultDir));

  if (subcommand === 'list') {
    const definitions = await tools.listTools();
    if (json) {
      console.log(JSON.stringify({ ok: true, result: definitions }, null, 2));
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
      writeEnvelope({ ok: false, error: { code: 'invalid_arguments', message: (error as Error).message } });
      process.exitCode = 1;
      return;
    }
    const tool = parsed.tool;
    if (!tool) {
      writeEnvelope({ ok: false, error: { code: 'missing_tool', message: 'Usage: tool call <tool-name> --json --input <json|@file>' } });
      process.exitCode = 1;
      return;
    }

    try {
      const input = parseInput(parsed.input ?? '{}');
      const result = await tools.callTool(tool, input);
      writeEnvelope({ ok: true, tool, result });
    } catch (error) {
      writeEnvelope({
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

  writeEnvelope({ ok: false, error: { code: 'unknown_command', message: 'Usage: tool <list|call> [args]' } });
  process.exitCode = 1;
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

function writeEnvelope(envelope: ToolCliEnvelope): void {
  console.log(JSON.stringify(envelope, null, 2));
}

function classifyError(error: unknown): string {
  const message = (error as Error).message ?? '';
  if (message.startsWith('Invalid JSON input')) return 'invalid_json';
  if (message.startsWith('Unknown tool')) return 'unknown_tool';
  if (message.startsWith('Tool unavailable')) return 'tool_unavailable';
  if (message.startsWith('Missing required argument')) return 'invalid_input';
  if (message.startsWith('Invalid argument')) return 'invalid_input';
  if (message.startsWith('Tool arguments must be a JSON object')) return 'invalid_input';
  return 'tool_call_failed';
}
