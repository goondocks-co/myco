#!/usr/bin/env node
import { collectiveAddProject, collectiveDestroy, collectiveInstall, collectiveRotateTokens, collectiveStatus, collectiveUpgrade } from './cli.js';

const [command, ...args] = process.argv.slice(2);
type CommandHandler = (args: string[]) => Promise<void>;

function showHelp(): void {
  console.log(`Usage: myco-collective <command>

Commands:
  install [name]
  upgrade
  status
  rotate-tokens [admin|mcp|all]
  add-project <name> <worker_url> <api_key>
  destroy
`);
}

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  install: async (commandArgs) => collectiveInstall(commandArgs[0]),
  upgrade: async () => collectiveUpgrade(),
  status: async () => collectiveStatus(),
  'rotate-tokens': async (commandArgs) => collectiveRotateTokens((commandArgs[0] as 'admin' | 'mcp' | 'all' | undefined) ?? 'all'),
  'add-project': async (commandArgs) => {
    if (commandArgs.length < 3) {
      console.error('Usage: myco-collective add-project <name> <worker_url> <api_key>');
      process.exit(1);
    }
    await collectiveAddProject(commandArgs[0], commandArgs[1], commandArgs[2]);
  },
  destroy: async () => collectiveDestroy(),
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
