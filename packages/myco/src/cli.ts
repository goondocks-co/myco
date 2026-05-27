#!/usr/bin/env node
import { isHelpRequest, loadEnv } from './cli/shared.js';
import { resolveVaultDir } from './vault/resolve.js';
import { activateDevBuildModeIfDetected } from './daemon/update-checker.js';
import fs from 'node:fs';
import path from 'node:path';

loadEnv();
activateDevBuildModeIfDetected();

const USAGE = `Usage: myco <command> [args]

Commands:
  grove <subcommand>       Manage local Groves
  backup <subcommand>      Snapshot and restore a project's Grove data
  update                   Update vault files and agent registration
  remove [--remove-vault]    Remove Myco from this project (vault preserved by default)
  remove --symbiont <name>   Unregister a single agent and remove from config
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
  tool <list|call>         List or call Myco tools as JSON
  doctor [--fix]          Check vault health and repair issues
  open                     Open the dashboard in your browser
  restart                  Restart the daemon
  version                  Show plugin version
  mcp                     Start the MCP stdio server
  hook <name>             Run a hook (session-start, session-end, stop, user-prompt-submit, pre-tool-use, post-tool-use, post-tool-use-failure, subagent-start, subagent-stop, stop-failure, task-completed, pre-compact, post-compact, error-occurred, notification)
  daemon                   Start the daemon for the current project

Myco installs globally and registers projects automatically on first agent
hook. There is no \`myco init\` command — project setup is fully automatic.
To commit per-project Myco config to a repo (portable Grove identity,
dogfood binary pinning) use the dashboard's Symbionts page.
`;

const COMMAND_HELP: Record<string, string> = {
  agent: `Usage: myco agent [--task NAME] [--instruction TEXT] [--dry-run]

Options:
  --task NAME          Run a specific agent task. Defaults to the configured default task.
  --instruction TEXT  Additional instruction to pass to the agent run.
  --dry-run           Record intended writes without mutating vault state.
  -h, --help          Show this help
`,
  task: `Usage: myco task <subcommand> [args]

Subcommands:
  list [--source built-in|user]   List all tasks
  show <name>                     Show task details and phases
  create <name> --from <template> Copy a task template to your user dir
  delete <name>                   Delete a user task
  run <name> [--instruction TEXT] [--dry-run] Run a task via the agent
`,
  'task run': `Usage: myco task run <name> [--instruction TEXT] [--dry-run]

Options:
  --instruction TEXT  Additional instruction to pass to the agent run.
  --dry-run           Record intended writes without mutating vault state.
  -h, --help          Show this help
`,
};

function helpForCommand(command: string, args: readonly string[] = []): string {
  const nestedCommand = args[0] ? `${command} ${args[0]}` : command;
  if (COMMAND_HELP[nestedCommand]) return COMMAND_HELP[nestedCommand];
  return COMMAND_HELP[command] ?? `Usage: myco ${command} [args]\n\nRun \`myco --help\` for the full command list.\n`;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  if (isHelpRequest(args)) {
    process.stdout.write(helpForCommand(cmd, args));
    return;
  }

  if (cmd === 'init') {
    console.error(
      '`myco init` was removed in v0.26. Global install registers projects automatically on first agent hook.\n' +
      'To commit per-project Myco config to a repo, use the dashboard\'s Symbionts page (`myco open`).',
    );
    process.exit(1);
  }
  if (cmd === 'grove') return (await import('./cli/grove.js')).run(args);
  if (cmd === 'backup') return (await import('./cli/backup.js')).run(args);
  if (cmd === 'detect-providers') return (await import('./cli/detect-providers.js')).run(args);
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    const { getPluginVersion } = await import('./version.js');
    console.log(getPluginVersion());
    return;
  }
  if (cmd === 'mcp') return (await import('./mcp/stdio-bridge.js')).main();
  if (cmd === 'hook') {
    const hookName = args[0];
    const HOOK_DISPATCH: Record<string, () => Promise<{ main: () => Promise<void> }>> = {
      'session-start': () => import('./hooks/session-start.js'),
      'session-end': () => import('./hooks/session-end.js'),
      'stop': () => import('./hooks/stop.js'),
      'user-prompt-submit': () => import('./hooks/user-prompt-submit.js'),
      'pre-tool-use': () => import('./hooks/pre-tool-use.js'),
      'post-tool-use': () => import('./hooks/post-tool-use.js'),
      'post-tool-use-failure': () => import('./hooks/post-tool-use-failure.js'),
      'subagent-start': () => import('./hooks/subagent-start.js'),
      'subagent-stop': () => import('./hooks/subagent-stop.js'),
      'stop-failure': () => import('./hooks/stop-failure.js'),
      'task-completed': () => import('./hooks/task-completed.js'),
      'pre-compact': () => import('./hooks/pre-compact.js'),
      'post-compact': () => import('./hooks/post-compact.js'),
      'error-occurred': () => import('./hooks/error-occurred.js'),
      'notification': () => import('./hooks/notification.js'),
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
  if (cmd === 'remove') return (await import('./cli/remove.js')).run(args);

  const vaultDir = resolveVaultDir();
  if (!fs.existsSync(path.join(vaultDir, 'myco.yaml'))) {
    console.error(
      `No myco.yaml found in ${vaultDir}. ` +
      `Open the dashboard (\`myco open\`) and commit Myco config to this project from the Symbionts page.`,
    );
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
    case 'agent': {
      if (args[0] === 'eval') {
        console.error(
          'The `agent eval` command has been retired. Use the Compare Runs flow in the daemon UI.',
        );
        process.exit(2);
      }
      return (await import('./cli/agent-run.js')).run(args, vaultDir);
    }
    case 'task': return (await import('./cli/agent-tasks.js')).run(args, vaultDir);
    case 'tool': return (await import('./cli/tool.js')).run(args, vaultDir);
    case 'open': return (await import('./cli/open.js')).run(args, vaultDir);
    case 'restart': return (await import('./cli/restart.js')).run(args, vaultDir);
    case 'service': return (await import('./cli/service.js')).run(args, vaultDir);
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
