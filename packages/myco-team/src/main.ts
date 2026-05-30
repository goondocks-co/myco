#!/usr/bin/env node
import { resolveVaultDir } from '@myco/vault/resolve.js';
import { teamDestroy, teamInit, teamReindexVectors, teamRotateTokens, teamStatus, teamUpgrade, upgradeWorker, reindexWorkerVectors } from './cli.js';

const [command, ...args] = process.argv.slice(2);
type CommandHandler = (args: string[]) => Promise<void>;

function showHelp(): void {
  console.log(`Usage: myco-team <command>

Commands:
  install [project_dir] [--name "<team name>"] [--domain <zone>]
  upgrade [project_dir] [--reindex-vectors] [--observability] [--json]
  status [project_dir]
  rotate-tokens [api|mcp|all] [project_dir]
  reindex-vectors [project_dir]
  destroy [project_dir]

--observability enables Cloudflare's persistent worker logs for the
deploy. Off by default because logs cost extra; turn it on for
dogfooding instances where tail access matters more than spend.

--json on upgrade emits a single machine-readable result object on stdout
(schema: { success, worker_url?, version?, error? }) and suppresses the
human-readable progress output. Used by the myco daemon's one-click
"Update Worker" handler to drive the upgrade without importing myco-team
internals.
`);
}

const UPGRADE_FLAGS = new Set(['--reindex-vectors', '--observability', '--json']);

function parseInstallArgs(commandArgs: string[]): {
  vaultDir: string;
  name?: string;
  domain?: string;
} {
  let name: string | undefined;
  let domain: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < commandArgs.length; i += 1) {
    const arg = commandArgs[i];
    if (arg === '--name') {
      name = commandArgs[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--domain') {
      domain = commandArgs[i + 1];
      i += 1;
      continue;
    }
    positional.push(arg);
  }
  return {
    vaultDir: resolveVaultDir(positional[0] ?? process.cwd()),
    name,
    domain,
  };
}

function parseUpgradeArgs(commandArgs: string[]): {
  vaultDir: string;
  reindexVectors: boolean;
  observability: boolean;
  json: boolean;
} {
  const reindexVectors = commandArgs.includes('--reindex-vectors');
  const observability = commandArgs.includes('--observability');
  const json = commandArgs.includes('--json');
  const projectArg = commandArgs.find((arg) => !UPGRADE_FLAGS.has(arg));
  return {
    vaultDir: resolveVaultDir(projectArg ?? process.cwd()),
    reindexVectors,
    observability,
    json,
  };
}

async function runUpgradeJson(
  vaultDir: string,
  reindexVectors: boolean,
  observability: boolean,
): Promise<void> {
  const result = upgradeWorker(vaultDir, { observability });
  if (!result.success) {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(1);
  }
  let reindexResult: { enqueued: number; by_table: Record<string, number> } | undefined;
  if (reindexVectors && result.worker_url) {
    try {
      reindexResult = await reindexWorkerVectors(vaultDir, result.worker_url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(JSON.stringify({ ...result, success: false, error: message }) + '\n');
      process.exit(1);
    }
  }
  process.stdout.write(JSON.stringify({ ...result, vector_reindex: reindexResult }) + '\n');
}

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  install: async (commandArgs) => {
    const { vaultDir, name, domain } = parseInstallArgs(commandArgs);
    return teamInit(vaultDir, { name, domain });
  },
  upgrade: async (commandArgs) => {
    const parsed = parseUpgradeArgs(commandArgs);
    if (parsed.json) {
      await runUpgradeJson(parsed.vaultDir, parsed.reindexVectors, parsed.observability);
      return;
    }
    await teamUpgrade(parsed.vaultDir, {
      reindexVectors: parsed.reindexVectors,
      observability: parsed.observability,
    });
  },
  status: async (commandArgs) => teamStatus(resolveVaultDir(commandArgs[0] ?? process.cwd())),
  'rotate-tokens': async (commandArgs) => teamRotateTokens(
    resolveVaultDir(commandArgs[1] ?? process.cwd()),
    (commandArgs[0] as 'api' | 'mcp' | 'all' | undefined) ?? 'all',
  ),
  'reindex-vectors': async (commandArgs) => teamReindexVectors(resolveVaultDir(commandArgs[0] ?? process.cwd())),
  destroy: async (commandArgs) => teamDestroy(resolveVaultDir(commandArgs[0] ?? process.cwd())),
};

if (!command || command === '--help' || command === '-h') {
  showHelp();
  process.exit(0);
}

const handler = COMMAND_HANDLERS[command];
if (!handler) {
  console.error(`Unknown myco-team command: ${command}`);
  process.exit(1);
}

await handler(args);
