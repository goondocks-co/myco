#!/usr/bin/env node
import { resolveVaultDir } from '@myco/vault/resolve.js';
import { teamDestroy, teamInit, teamRotateTokens, teamStatus, teamUpgrade } from './cli.js';

const [command, ...args] = process.argv.slice(2);
type CommandHandler = (args: string[]) => Promise<void>;

function showHelp(): void {
  console.log(`Usage: myco-team <command>

Commands:
  install [project_dir]
  upgrade [project_dir]
  status
  rotate-tokens [api|mcp|all]
  destroy
`);
}

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  install: async (commandArgs) => teamInit(resolveVaultDir(commandArgs[0] ?? process.cwd())),
  upgrade: async (commandArgs) => teamUpgrade(resolveVaultDir(commandArgs[0] ?? process.cwd())),
  status: async () => teamStatus(),
  'rotate-tokens': async (commandArgs) => teamRotateTokens((commandArgs[0] as 'api' | 'mcp' | 'all' | undefined) ?? 'all'),
  destroy: async () => teamDestroy(),
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
