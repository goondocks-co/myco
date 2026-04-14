#!/usr/bin/env node
import { collectiveAddProject, collectiveDestroy, collectiveInstall, collectiveRotateTokens, collectiveStatus, collectiveUpgrade } from './cli.js';

const [command, ...args] = process.argv.slice(2);
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

await handler(args);
