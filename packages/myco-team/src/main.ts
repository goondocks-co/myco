#!/usr/bin/env node
import { resolveVaultDir } from '@myco/vault/resolve.js';
import { teamDestroy, teamInit, teamReindexVectors, teamRotateTokens, teamStatus, teamUpgrade, upgradeWorker, reindexWorkerVectors } from './cli.js';

const [command, ...args] = process.argv.slice(2);
type CommandHandler = (args: string[]) => Promise<void>;

function showHelp(): void {
  console.log(`Usage: myco-team <command>

Commands:
  install [project_dir] [--name "<team name>"] [--domain <zone>]
  upgrade|update --team-id <team_id> [--reindex-vectors] [--observability] [--json]
  status --team-id <team_id>
  rotate-tokens [api|mcp|all] --team-id <team_id>
  reindex-vectors --team-id <team_id>
  destroy --team-id <team_id>

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
const TEAM_SELECTOR_FLAGS = new Set(['--team-id']);

function parseTeamSelector(commandArgs: string[]): { teamId?: string; rest: string[] } {
  let teamId: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < commandArgs.length; i += 1) {
    const arg = commandArgs[i];
    if (TEAM_SELECTOR_FLAGS.has(arg)) {
      const value = commandArgs[i + 1];
      if (!value) {
        console.error(`${arg} requires a Team ID`);
        process.exit(2);
      }
      teamId = value;
      i += 1;
      continue;
    }
    rest.push(arg);
  }
  return { teamId, rest };
}

function resolveOptionalVaultDir(projectArg?: string): string | null {
  if (projectArg) return resolveVaultDir(projectArg);
  try {
    return resolveVaultDir(process.cwd());
  } catch {
    return null;
  }
}

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
  vaultDir: string | null;
  reindexVectors: boolean;
  observability: boolean;
  json: boolean;
  teamId?: string;
} {
  const { teamId, rest } = parseTeamSelector(commandArgs);
  const reindexVectors = rest.includes('--reindex-vectors');
  const observability = rest.includes('--observability');
  const json = rest.includes('--json');
  const projectArg = rest.find((arg) => !UPGRADE_FLAGS.has(arg));
  return {
    vaultDir: resolveOptionalVaultDir(projectArg),
    reindexVectors,
    observability,
    json,
    teamId,
  };
}

async function runUpgradeJson(
  vaultDir: string | null,
  reindexVectors: boolean,
  observability: boolean,
  teamId?: string,
): Promise<void> {
  const result = upgradeWorker(vaultDir, { observability, teamId });
  if (!result.success) {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(1);
  }
  let reindexResult: { enqueued: number; by_table: Record<string, number> } | undefined;
  if (reindexVectors && result.worker_url) {
    try {
      reindexResult = await reindexWorkerVectors(vaultDir, result.worker_url, { teamId });
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
      await runUpgradeJson(parsed.vaultDir, parsed.reindexVectors, parsed.observability, parsed.teamId);
      return;
    }
    await teamUpgrade(parsed.vaultDir, {
      reindexVectors: parsed.reindexVectors,
      observability: parsed.observability,
      teamId: parsed.teamId,
    });
  },
  update: async (commandArgs) => COMMAND_HANDLERS.upgrade(commandArgs),
  status: async (commandArgs) => {
    const { teamId, rest } = parseTeamSelector(commandArgs);
    return teamStatus(resolveOptionalVaultDir(rest[0]), { teamId });
  },
  'rotate-tokens': async (commandArgs) => {
    const { teamId, rest } = parseTeamSelector(commandArgs);
    const maybeWhich = rest[0] as 'api' | 'mcp' | 'all' | undefined;
    const hasWhich = maybeWhich === 'api' || maybeWhich === 'mcp' || maybeWhich === 'all';
    return teamRotateTokens(
      resolveOptionalVaultDir(hasWhich ? rest[1] : rest[0]),
      hasWhich ? maybeWhich : 'all',
      { teamId },
    );
  },
  'reindex-vectors': async (commandArgs) => {
    const { teamId, rest } = parseTeamSelector(commandArgs);
    return teamReindexVectors(resolveOptionalVaultDir(rest[0]), { teamId });
  },
  destroy: async (commandArgs) => {
    const { teamId, rest } = parseTeamSelector(commandArgs);
    return teamDestroy(resolveOptionalVaultDir(rest[0]), { teamId });
  },
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
