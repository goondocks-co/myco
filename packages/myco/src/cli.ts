#!/usr/bin/env node
import { isHelpRequest, loadEnv } from './cli/shared.js';
import { resolveVaultDir } from './vault/resolve.js';
import { runLaunchPreamble } from './cli/launch-preamble.js';
import fs from 'node:fs';
import path from 'node:path';

loadEnv();

const USAGE = `Usage: myco <command> [args]

Commands:
  grove <subcommand>       Manage local Groves
  subsystem <subcommand>   Claim/release machine-global subsystem ownership (claim|release|list)
  update                   Update vault files and agent registration
  remove [--purge] [--yes]   Remove Myco's machine-wide install (prompts unless --yes;
                             captured data preserved unless --purge)
  remove --project [<path>] | --symbiont <name> | --remove-vault
                             Project-scoped removal (any of these flags switches scope;
                             vault preserved unless --remove-vault)
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
  service <subcommand>     Manage the platform service (install|uninstall|start|stop|restart|status)
  join <host> --key <k> --host-url <url>   Enroll this machine with a Team Host
  leave <host>             Detach this machine from a Team Host
  attach <project> --host <h>   Route a project to a Team Host (going-forward)
  detach <project>         Clear a project's Team Host mapping (resolves local again)
  host <subcommand>        Serve your team from this machine (enable|disable|status|rotate-key|members|revoke)
  member <op>              2.0 member: join | leave | drain | status | refresh
  settings                 Print harness settings for a sandboxed agent (--harness <name> --project <id>)
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
  attach: `Usage: myco attach <project> --host <hostId>

Records a project's residency mapping so future requests route to the host that
serves it, instead of staying local-only. Attach-going-forward only: it does NOT
migrate existing local data (a project that still has local history is refused
with guidance). Idempotent — re-attaching to the same host converges.

Options:
  --host <hostId>       The joined host that will serve this project (falls back to the
                        checkout's project.toml Team Host hint).
  --project-id <proj_…> Override the project id (default: the checkout's project.toml).

The host's team storage is used automatically — there is no id to supply for it.
`,
  detach: `Usage: myco detach <project> [--allow-no-pull]

Brings a project home from its Team Host: pulls the project's knowledge back
into the local Grove in the background, then clears the residency mapping so
future requests resolve locally. Requires a host that serves the residency
protocol; pass --allow-no-pull to detach WITHOUT pulling data back (the
history stays on the host).
Idempotent — detaching a project that is not attached is a clean no-op.
`,
};

/**
 * Commands whose help lives WITH their parser, not in the map above.
 *
 * These commands print their own help on a usage error, so a copy here would be
 * a second copy of the same text — free to disagree with the flags the parser
 * actually accepts. Delegating keeps the text a user reads and the flags that
 * parse it in one file. Any command that owns a help constant belongs here.
 */
const DELEGATED_HELP: Record<string, () => Promise<string>> = {
  join: async () => (await import('./cli/join.js')).JOIN_HELP,
  leave: async () => (await import('./cli/join.js')).LEAVE_HELP,
  host: async () => (await import('./cli/host.js')).HOST_HELP,
  member: async () => (await import('./cli/member.js')).MEMBER_HELP,
  settings: async () => (await import('./cli/settings.js')).SETTINGS_HELP,
  server: async () => (await import('./cli/server.js')).SERVER_HELP,
};

async function helpForCommand(command: string, args: readonly string[] = []): Promise<string> {
  const nestedCommand = args[0] ? `${command} ${args[0]}` : command;
  const delegated = DELEGATED_HELP[nestedCommand] ?? DELEGATED_HELP[command];
  if (delegated) return await delegated();
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
    process.stdout.write(await helpForCommand(cmd, args));
    return;
  }

  // Commands below can open and MIGRATE a Grove DB in-process (grove
  // activation, `myco update` project fan-out, provisioning via
  // ensureGroveDatabase) — so the pre-migration checkpoint must be
  // registered in THIS process too, not only in the daemon, or a CLI-run
  // migration is exactly the unprotected schema jump the checkpoint
  // exists to close (the rollback refusal would then point at a backup
  // that was never taken). `hook`/`mcp` are excluded deliberately: they
  // reach the vault only through the daemon's HTTP surface (never an
  // in-process createSchema) and are latency-sensitive per agent event,
  // so they skip the import cost.
  if (cmd !== 'hook' && cmd !== 'mcp') {
    const { installPreMigrationCheckpoint } = await import('./backup/pre-migration-checkpoint.js');
    const { resolveMycoHome } = await import('./grove/paths.js');
    installPreMigrationCheckpoint({ mycoHome: resolveMycoHome() });
  }

  if (cmd === 'init') {
    console.error(
      '`myco init` was removed in v0.26. Global install registers projects automatically on first agent hook.\n' +
      'To commit per-project Myco config to a repo, use the dashboard\'s Symbionts page (`myco open`).',
    );
    process.exit(1);
  }
  if (cmd === 'grove') return (await import('./cli/grove.js')).run(args);
  // Declare which daemon variant owns a machine-global subsystem (e.g.
  // symbiont-config) so a coexisting peer daemon defers — operator-driven,
  // durable, contributor-only. Belongs above the myco.yaml gate like `grove`
  // since it manages machine state, not a project vault.
  if (cmd === 'subsystem') return (await import('./cli/subsystem.js')).run(args);
  // Internal: spawned by the daemon to run a heavy restore out-of-process
  // (see backup/restore-runner.ts). Intentionally absent from the help text.
  if (cmd === '__restore-backup') return (await import('./cli/restore-backup.js')).run(args);
  // Internal: spawned detached by the daemon to run the cross-platform update/
  // restart orchestration after the daemon exits (see upgrade/orchestrator.ts).
  if (cmd === '__apply-update') return (await import('./upgrade/orchestrator.js')).run(args);
  // Internal: spawned detached (from a temp-copy binary) by `myco remove --purge`
  // to delete the managed install dir once this process releases its exe lock.
  if (cmd === '__finish-uninstall') return (await import('./cli/finish-uninstall.js')).run(args);
  if (cmd === 'detect-providers') return (await import('./cli/detect-providers.js')).run(args);
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    const { getPluginVersion } = await import('./version.js');
    console.log(getPluginVersion());
    return;
  }
  if (cmd === 'mcp') {
    runLaunchPreamble('mcp', args);
    return (await import('./mcp/stdio-bridge.js')).main();
  }
  if (cmd === 'hook') {
    runLaunchPreamble('hook', args);
    const hookName = args[0];
    const HOOK_DISPATCH: Record<string, () => Promise<{ main: (opts: import('./member/capture.js').HookMainOptions) => Promise<void> }>> = {
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
    // The credential source is declared on the hook command (`--credential
    // registry|env`) and handed down; a hook never infers it.
    const { parseCredentialFlag } = await import('./member/credential.js');
    return (await loader()).main({ credential: parseCredentialFlag(args) });
  }
  if (cmd === 'daemon') return (await import('./daemon/main.js')).main();
  // Supervisor lifecycle — manages the platform service + daemon binary, never a
  // project vault. Belongs above the myco.yaml gate alongside daemon/update/remove,
  // so `myco service <verb>` works from any cwd (e.g. a fresh host with no project).
  if (cmd === 'service') return (await import('./cli/service.js')).run(args);

  // Team Host member enrollment — machine-global (writes the ~/.myco-team hosts
  // registry, not a project vault), so it sits above the myco.yaml gate like
  // `service`/`subsystem`. The command name is load-bearing: the affiliation hint
  // tells users to run exactly `myco join <host>`. `resolveVaultDir()` is safe to
  // call unconditionally (falls back to cwd/.myco, never throws) — it's only used
  // to locate the local daemon (`daemon/client.ts` DaemonClient), a machine-global
  // singleton these commands are now a thin fallback wrapper over (Task D-2).
  if (cmd === 'join') return (await import('./cli/join.js')).runJoin(args, resolveVaultDir());
  if (cmd === 'leave') return (await import('./cli/join.js')).runLeave(args, resolveVaultDir());

  // Team Host residency mapping — attach/detach record which host serves a
  // project (machine-global attach registry, not a project vault), so like
  // `join`/`leave` they sit above the myco.yaml gate and work from any cwd.
  if (cmd === 'attach') return (await import('./cli/attach.js')).runAttach(args, resolveVaultDir());
  if (cmd === 'detach') return (await import('./cli/attach.js')).runDetach(args, resolveVaultDir());

  // Team Host operator orchestration — enables serving (the daemon binds a
  // local team listener and publishes it through the operator's Tailscale
  // Funnel) and writes machine-tier config, not a project vault, so like
  // `join`/`attach` it sits above the myco.yaml gate and works from any cwd.
  if (cmd === 'host') return (await import('./cli/host.js')).runHostCommand(args);

  // 2.0 member operations — registry and spool under MYCO_HOME, never a project
  // vault, so they sit above the myco.yaml gate and work from any cwd.
  if (cmd === 'member') return (await import('./cli/member.js')).run(args);

  // Self-hosted Deployment lifecycle — a Compose bundle under MYCO_HOME, no
  // project vault, so it sits above the myco.yaml gate and works from any cwd.
  if (cmd === 'server') return (await import('./cli/server.js')).run(args);

  // The sandbox settings emitter reads no vault and writes nothing.
  if (cmd === 'settings') return (await import('./cli/settings.js')).run(args);

  if (cmd === 'doctor') {
    const vaultDir = resolveVaultDir();
    return (await import('./cli/doctor.js')).run(args, vaultDir);
  }

  if (cmd === 'update') return (await import('./cli/update.js')).run(args);
  if (cmd === 'upgrade') return (await import('./cli/upgrade.js')).run(args);
  if (cmd === 'remove') return (await import('./cli/remove.js')).run(args);

  // open and restart target the global daemon and require no project myco.yaml.
  if (cmd === 'open') {
    return (await import('./cli/open.js')).run(args);
  }
  if (cmd === 'restart') {
    const vaultDir = resolveVaultDir();
    return (await import('./cli/restart.js')).run(args, vaultDir);
  }

  // Honor the runtime pin before the myco.yaml gate so a pinned binary is
  // re-exec'd even on a host with no project vault; the pinned binary owns the
  // gate decision after re-exec.
  if (cmd === 'tool') runLaunchPreamble('tool', args);
  // A tool call that declares a credential source reaches the Deployment over
  // the member credential and reads no project vault, so it sits above the
  // myco.yaml gate like every other member operation.
  if (cmd === 'tool' && (await import('./mcp/deployment-upstream.js')).credentialFlagPresent(args)) {
    return (await import('./cli/tool.js')).run(args, resolveVaultDir());
  }

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
