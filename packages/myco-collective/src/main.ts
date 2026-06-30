#!/usr/bin/env node
import { collectiveAddProject, collectiveDestroy, collectiveInstall, collectiveRotateTokens, collectiveStatus, collectiveUpgrade } from './cli.js';
import { applyCloudflareAccountId, extractAccountIdFlag, isValidCloudflareAccountId } from '@myco-deploy/index.js';

const [command, ...rawArgs] = process.argv.slice(2);
type CommandHandler = (args: string[]) => Promise<void>;

function showHelp(): void {
  console.log(`Usage: myco-collective <command>

Commands:
  install [name]
  upgrade [name]
  status [name]
  rotate-tokens [admin|mcp|all] [name]
  add-project <name> <worker_url> <api_key> [collective_name]
  destroy [name]

--account-id <id> (any command) selects which Cloudflare account to operate on
when your wrangler login has access to more than one. Without it, install
prompts you to pick interactively on a terminal, or errors listing the
available accounts when non-interactive. Equivalent to CLOUDFLARE_ACCOUNT_ID.
`);
}

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  install: async (commandArgs) => collectiveInstall(commandArgs[0]),
  upgrade: async (commandArgs) => collectiveUpgrade(commandArgs[0]),
  status: async (commandArgs) => collectiveStatus(commandArgs[0]),
  'rotate-tokens': async (commandArgs) => collectiveRotateTokens(
    commandArgs[1],
    (commandArgs[0] as 'admin' | 'mcp' | 'all' | undefined) ?? 'all',
  ),
  'add-project': async (commandArgs) => {
    if (commandArgs.length < 3) {
      console.error('Usage: myco-collective add-project <name> <worker_url> <api_key> [collective_name]');
      process.exit(1);
    }
    await collectiveAddProject(
      commandArgs[0],
      commandArgs[1],
      commandArgs[2],
      commandArgs[3],
    );
  },
  destroy: async (commandArgs) => collectiveDestroy(commandArgs[0]),
};

if (!command || command === '--help' || command === '-h') {
  showHelp();
  process.exit(0);
}

const handler = COMMAND_HANDLERS[command];
if (!handler) {
  console.error(`Unknown myco-collective command: ${command}`);
  process.exit(1);
}

// A global flag, valid on every command — set CLOUDFLARE_ACCOUNT_ID before any
// wrangler call so a multi-account login resolves deterministically.
const { accountId, rest: commandArgs } = extractAccountIdFlag(rawArgs);
if (accountId !== undefined) {
  if (!isValidCloudflareAccountId(accountId)) {
    console.error(`Invalid --account-id "${accountId}": expected a 32-character hex Cloudflare account ID.`);
    process.exit(2);
  }
  applyCloudflareAccountId(accountId);
}

try {
  await handler(commandArgs);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
