#!/usr/bin/env node
import { teamAdopt, teamCreate, teamDestroy, teamExport, teamImport, teamReindexVectors, teamRotateTokens, teamStatus, teamUpgrade, upgradeWorker, reindexWorkerVectors } from './cli.js';
import { migrateTeamsHomeIfNeeded } from '@myco/team/migrate-home.js';

const [command, ...rawArgs] = process.argv.slice(2);
type CommandHandler = (args: string[]) => Promise<void>;

function showHelp(): void {
  console.log(`Usage: myco-team <command>

Commands:
  create [--name "<team name>"] [--domain <zone>]
  upgrade|update --team-id <team_id> [--reindex-vectors] [--observability] [--json]
  status --team-id <team_id>
  rotate-tokens [api|mcp|all] --team-id <team_id>
  reindex-vectors --team-id <team_id>
  destroy --team-id <team_id>
  export --team-id <team_id> [--out <dir-or-file>]
  import <bundle-file>
  adopt --worker-url <url> [--api-key <key>] [--worker-name <name>]

export writes a portable backup bundle (the team's local config + secrets)
that import restores on another machine — no Cloudflare calls. adopt instead
rebuilds local state from a live worker: with --api-key it reads the team
identity from the worker; without one it regenerates the Team key via your
Cloudflare account (re-share the new key with teammates afterwards).

--domain binds the worker to a custom Workers zone (https://<team-slug>.<zone>)
instead of the default *.workers.dev URL.

--observability enables Cloudflare's persistent worker logs for the
deploy. Off by default because logs cost extra; turn it on for
dogfooding instances where tail access matters more than spend.

--json on upgrade emits a single machine-readable result object on stdout
(schema: { success, worker_url?, version?, error? }) and suppresses the
human-readable progress output.

Teams are global, machine-scoped entities — "create" needs no project or
Grove context, and every other command addresses a team by --team-id.
Registrations live in the machine-scoped ~/.myco-team/ directory, shared by
every myco daemon on this machine. Set MYCO_TEAM_HOME to override the
location (used by the test suite).
`);
}

const UPGRADE_FLAGS = new Set(['--reindex-vectors', '--observability', '--json']);
const TEAM_SELECTOR_FLAGS = new Set(['--team-id']);

/** Split `--flag=value` tokens into `['--flag', 'value']` so both flag forms parse uniformly. */
function normalizeFlags(args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq > 2) out.push(arg.slice(0, eq), arg.slice(eq + 1));
    else out.push(arg);
  }
  return out;
}

/**
 * Read the value following `flag` at index i; exit(2) if it is missing, empty,
 * or another flag. Without this a forgotten value (`--api-key` with nothing
 * after it) reads as "flag absent" and silently takes a different branch — e.g.
 * `adopt` would regenerate the Team key, invalidating every teammate.
 */
function requireFlagValue(args: string[], i: number, flag: string): string {
  const value = args[i + 1];
  if (value === undefined || value === '' || value.startsWith('--')) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

function parseTeamSelector(commandArgs: string[]): { teamId?: string; rest: string[] } {
  let teamId: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < commandArgs.length; i += 1) {
    const arg = commandArgs[i];
    if (TEAM_SELECTOR_FLAGS.has(arg)) {
      teamId = requireFlagValue(commandArgs, i, arg);
      i += 1;
      continue;
    }
    rest.push(arg);
  }
  return { teamId, rest };
}

function parseCreateArgs(commandArgs: string[]): { name?: string; domain?: string } {
  let name: string | undefined;
  let domain: string | undefined;
  for (let i = 0; i < commandArgs.length; i += 1) {
    const arg = commandArgs[i];
    if (arg === '--name') { name = requireFlagValue(commandArgs, i, arg); i += 1; continue; }
    if (arg === '--domain') { domain = requireFlagValue(commandArgs, i, arg); i += 1; continue; }
  }
  return { name, domain };
}

function parseExportArgs(commandArgs: string[]): { teamId?: string; out?: string } {
  const { teamId, rest } = parseTeamSelector(commandArgs);
  let out: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--out') { out = requireFlagValue(rest, i, '--out'); i += 1; }
  }
  return { teamId, out };
}

function parseAdoptArgs(commandArgs: string[]): { workerUrl?: string; apiKey?: string; workerName?: string } {
  let workerUrl: string | undefined;
  let apiKey: string | undefined;
  let workerName: string | undefined;
  for (let i = 0; i < commandArgs.length; i += 1) {
    const arg = commandArgs[i];
    if (arg === '--worker-url') { workerUrl = requireFlagValue(commandArgs, i, arg); i += 1; continue; }
    if (arg === '--api-key') { apiKey = requireFlagValue(commandArgs, i, arg); i += 1; continue; }
    if (arg === '--worker-name') { workerName = requireFlagValue(commandArgs, i, arg); i += 1; continue; }
  }
  return { workerUrl, apiKey, workerName };
}

function parseUpgradeArgs(commandArgs: string[]): {
  reindexVectors: boolean;
  observability: boolean;
  json: boolean;
  teamId?: string;
} {
  const { teamId, rest } = parseTeamSelector(commandArgs);
  return {
    reindexVectors: rest.includes('--reindex-vectors'),
    observability: rest.includes('--observability'),
    json: rest.includes('--json'),
    teamId,
  };
}

async function runUpgradeJson(
  reindexVectors: boolean,
  observability: boolean,
  teamId?: string,
): Promise<void> {
  const result = upgradeWorker({ observability, teamId });
  if (!result.success) {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(1);
  }
  let reindexResult: { enqueued: number; by_table: Record<string, number> } | undefined;
  if (reindexVectors && result.worker_url) {
    try {
      reindexResult = await reindexWorkerVectors(result.worker_url, { teamId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(JSON.stringify({ ...result, success: false, error: message }) + '\n');
      process.exit(1);
    }
  }
  process.stdout.write(JSON.stringify({ ...result, vector_reindex: reindexResult }) + '\n');
}

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  create: async (commandArgs) => {
    const { name, domain } = parseCreateArgs(commandArgs);
    return teamCreate({ name, domain });
  },
  upgrade: async (commandArgs) => {
    const parsed = parseUpgradeArgs(commandArgs);
    if (parsed.json) {
      await runUpgradeJson(parsed.reindexVectors, parsed.observability, parsed.teamId);
      return;
    }
    await teamUpgrade({
      reindexVectors: parsed.reindexVectors,
      observability: parsed.observability,
      teamId: parsed.teamId,
    });
  },
  update: async (commandArgs) => COMMAND_HANDLERS.upgrade(commandArgs),
  status: async (commandArgs) => {
    const { teamId } = parseTeamSelector(commandArgs);
    return teamStatus({ teamId });
  },
  'rotate-tokens': async (commandArgs) => {
    const { teamId, rest } = parseTeamSelector(commandArgs);
    const maybeWhich = rest[0] as 'api' | 'mcp' | 'all' | undefined;
    const hasWhich = maybeWhich === 'api' || maybeWhich === 'mcp' || maybeWhich === 'all';
    return teamRotateTokens(hasWhich ? maybeWhich : 'all', { teamId });
  },
  'reindex-vectors': async (commandArgs) => {
    const { teamId } = parseTeamSelector(commandArgs);
    return teamReindexVectors({ teamId });
  },
  destroy: async (commandArgs) => {
    const { teamId } = parseTeamSelector(commandArgs);
    return teamDestroy({ teamId });
  },
  export: async (commandArgs) => {
    const { teamId, out } = parseExportArgs(commandArgs);
    return teamExport({ teamId, out });
  },
  import: async (commandArgs) => {
    const bundlePath = commandArgs.find((arg) => !arg.startsWith('--'));
    return teamImport(bundlePath ?? '');
  },
  adopt: async (commandArgs) => teamAdopt(parseAdoptArgs(commandArgs)),
};

if (!command || command === '--help' || command === '-h') {
  showHelp();
  process.exit(0);
}

try { migrateTeamsHomeIfNeeded(); } catch { /* best-effort; admin command proceeds on current home */ }

const handler = COMMAND_HANDLERS[command];
if (!handler) {
  console.error(`Unknown myco-team command: ${command}`);
  process.exit(1);
}

try {
  await handler(normalizeFlags(rawArgs));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
