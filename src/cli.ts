#!/usr/bin/env node
import { loadEnv } from './cli/shared.js';
import { resolveVaultDir } from './vault/resolve.js';
import fs from 'node:fs';
import path from 'node:path';

loadEnv();

const USAGE = `Usage: myco <command> [args]

Commands:
  init [options]           Initialize a new vault
  update                   Update vault files and symbiont plugins
  config <get|set> [args]  Get or set vault config values
  detect-providers         Detect available LLM/embedding providers (JSON)
  verify                   Test LLM and embedding connectivity
  stats                    Vault health, index counts, vector count
  search <query>           Combined FTS + vector search with scores
  vectors <query>          Raw vector search with similarity scores
  session [id|latest]      Show a session
  logs [options]           View daemon logs
  setup-llm [options]      Configure LLM and embedding providers
  setup-digest [options]   Configure digest and capture settings
  agent [options]          Run the intelligence agent
  task <subcommand>        Manage agent task definitions
  doctor [--fix]          Check vault health and repair issues
  restart                  Restart the daemon
  version                  Show plugin version
  mcp                     Start the MCP stdio server
  hook <name>             Run a hook (session-start, session-end, stop, user-prompt-submit, post-tool-use, post-tool-use-failure, subagent-start, subagent-stop, stop-failure, task-completed, pre-compact, post-compact)
  daemon --vault <dir>    Start the daemon process
`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === 'init') return (await import('./cli/init.js')).run(args);
  if (cmd === 'detect-providers') return (await import('./cli/detect-providers.js')).run(args);
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    const { getPluginVersion } = await import('./version.js');
    console.log(getPluginVersion());
    return;
  }
  if (cmd === 'mcp') return (await import('./mcp/server.js')).main();
  if (cmd === 'hook') {
    const hookName = args[0];
    const HOOK_DISPATCH: Record<string, () => Promise<{ main: () => Promise<void> }>> = {
      'session-start': () => import('./hooks/session-start.js'),
      'session-end': () => import('./hooks/session-end.js'),
      'stop': () => import('./hooks/stop.js'),
      'user-prompt-submit': () => import('./hooks/user-prompt-submit.js'),
      'post-tool-use': () => import('./hooks/post-tool-use.js'),
      'post-tool-use-failure': () => import('./hooks/post-tool-use-failure.js'),
      'subagent-start': () => import('./hooks/subagent-start.js'),
      'subagent-stop': () => import('./hooks/subagent-stop.js'),
      'stop-failure': () => import('./hooks/stop-failure.js'),
      'task-completed': () => import('./hooks/task-completed.js'),
      'pre-compact': () => import('./hooks/pre-compact.js'),
      'post-compact': () => import('./hooks/post-compact.js'),
    };
    const loader = HOOK_DISPATCH[hookName];
    if (!loader) {
      console.error(`Unknown hook: ${hookName}. Available: ${Object.keys(HOOK_DISPATCH).join(', ')}`);
      process.exit(1);
    }
    return (await loader()).main();
  }
  if (cmd === 'daemon') return (await import('./daemon/main.js')).main();

  if (cmd === 'doctor') {
    const vaultDir = resolveVaultDir();
    return (await import('./cli/doctor.js')).run(args, vaultDir);
  }

  if (cmd === 'update') return (await import('./cli/update.js')).run(args);

  const vaultDir = resolveVaultDir();
  if (!fs.existsSync(path.join(vaultDir, 'myco.yaml'))) {
    console.error(`No myco.yaml found in ${vaultDir}. Run 'myco init' first.`);
    process.exit(1);
  }

  switch (cmd) {
    case 'config': return (await import('./cli/config.js')).run(args, vaultDir);
    case 'verify': return (await import('./cli/verify.js')).run(args, vaultDir);
    case 'stats': return (await import('./cli/stats.js')).run(args, vaultDir);
    case 'search': return (await import('./cli/search.js')).run(args, vaultDir);
    case 'vectors': return (await import('./cli/search.js')).runVectors(args, vaultDir);
    case 'session': return (await import('./cli/session.js')).run(args, vaultDir);
    case 'setup-llm': return (await import('./cli/setup-llm.js')).run(args, vaultDir);
    case 'setup-digest': return (await import('./cli/setup-digest.js')).run(args, vaultDir);
    case 'agent': return (await import('./cli/agent-run.js')).run(args, vaultDir);
    case 'task': return (await import('./cli/agent-tasks.js')).run(args, vaultDir);
    case 'restart': return (await import('./cli/restart.js')).run(args, vaultDir);
    case 'logs': return (await import('./cli/logs.js')).run(args, vaultDir);
    default:
      console.error(`Unknown command: ${cmd}`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`myco: ${(err as Error).message}`);
  process.exit(1);
});
