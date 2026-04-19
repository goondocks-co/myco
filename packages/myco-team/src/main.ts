#!/usr/bin/env node
import { resolveVaultDir } from '@myco/vault/resolve.js';
import { teamDestroy, teamInit, teamReindexVectors, teamRotateTokens, teamStatus, teamUpgrade } from './cli.js';

const [command, ...args] = process.argv.slice(2);
type CommandHandler = (args: string[]) => Promise<void>;

function showHelp(): void {
  console.log(`Usage: myco-team <command>

Commands:
  install [project_dir]
  upgrade [project_dir] [--reindex-vectors]
  status [project_dir]
  rotate-tokens [api|mcp|all] [project_dir]
  reindex-vectors [project_dir]
  destroy [project_dir]
`);
}

function parseUpgradeArgs(commandArgs: string[]): { vaultDir: string; reindexVectors: boolean } {
  const reindexVectors = commandArgs.includes('--reindex-vectors');
  const projectArg = commandArgs.find((arg) => arg !== '--reindex-vectors');
  return {
    vaultDir: resolveVaultDir(projectArg ?? process.cwd()),
    reindexVectors,
  };
}

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  install: async (commandArgs) => teamInit(resolveVaultDir(commandArgs[0] ?? process.cwd())),
  upgrade: async (commandArgs) => {
    const parsed = parseUpgradeArgs(commandArgs);
    await teamUpgrade(parsed.vaultDir, { reindexVectors: parsed.reindexVectors });
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
