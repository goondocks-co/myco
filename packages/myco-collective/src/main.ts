#!/usr/bin/env node
import { resolveVaultDir } from '@myco/vault/resolve.js';
import { collectiveAddProject, collectiveDestroy, collectiveInstall, collectiveRotateTokens, collectiveStatus, collectiveUpgrade } from './cli.js';

const [command, ...args] = process.argv.slice(2);
type CommandHandler = (args: string[]) => Promise<void>;

function showHelp(): void {
  console.log(`Usage: myco-collective <command>

Commands:
  install [name] [project_dir]
  upgrade [project_dir]
  status [project_dir]
  rotate-tokens [admin|mcp|all] [project_dir]
  add-project <name> <worker_url> <api_key> [project_dir]
  destroy [project_dir]
`);
}

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  install: async (commandArgs) => collectiveInstall(
    resolveVaultDir(commandArgs[1] ?? process.cwd()),
    commandArgs[0],
  ),
  upgrade: async (commandArgs) => collectiveUpgrade(resolveVaultDir(commandArgs[0] ?? process.cwd())),
  status: async (commandArgs) => collectiveStatus(resolveVaultDir(commandArgs[0] ?? process.cwd())),
  'rotate-tokens': async (commandArgs) => collectiveRotateTokens(
    resolveVaultDir(commandArgs[1] ?? process.cwd()),
    (commandArgs[0] as 'admin' | 'mcp' | 'all' | undefined) ?? 'all',
  ),
  'add-project': async (commandArgs) => {
    if (commandArgs.length < 3) {
      console.error('Usage: myco-collective add-project <name> <worker_url> <api_key> [project_dir]');
      process.exit(1);
    }
    await collectiveAddProject(
      resolveVaultDir(commandArgs[3] ?? process.cwd()),
      commandArgs[0],
      commandArgs[1],
      commandArgs[2],
    );
  },
  destroy: async (commandArgs) => collectiveDestroy(resolveVaultDir(commandArgs[0] ?? process.cwd())),
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
