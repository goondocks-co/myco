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
  join <host> --key <k>    Enroll this machine with a Team Host over the overlay
  leave <host>             Detach this machine from a Team Host
  attach <project> --host <h>   Route a project to a Team Host (going-forward)
  detach <project>         Clear a project's Team Host mapping (resolves local again)
  host <subcommand>        Serve your team from this machine (enable|disable|status|rotate-key)
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
  join: `Usage: myco join <host> --key <one-time-key> [--server-url <headscale-url>]

Enroll this machine with a Team Host over its overlay: provisions a userspace
tailscaled as a per-user service (NO root), joins with the single-use key, then
records the host so attached projects route to it. Re-running converges.

Options:
  --key <k>            REQUIRED. The single-use pre-auth key the host operator minted.
  --server-url <url>   Headscale control-plane URL (required unless already on the overlay).
  --hostname <name>    This member's node name on the tailnet (default: this machine's hostname).
  --overlay-address <100.64.x.y:port>  Host daemon overlay address (until enrollment ships).
  --bearer <serve-bearer>              Shared host serve-bearer (until enrollment ships).
`,
  leave: `Usage: myco leave <host>

Detach this machine from a Team Host: removes the stored host record + bearer
(and its attach refs). When no other host remains, the userspace tailscaled
service is torn down too. Idempotent.
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
  detach: `Usage: myco detach <project>

Clears a project's residency mapping so future requests go back to local-only.
Detach-only: removes the mapping going forward, pulls back NO data.
Idempotent — detaching a project that is not attached is a clean no-op.
`,
  host: `Usage: myco host <command>

Commands:
  enable --server-url <https://host:8080> [--hostname <name>] [--listen-addr <addr>]
                                          [--user <headscale-user>] [--key-expiration <dur>]
                                          [--designate-default] [--emit-join]
                                          [--team-key <key>] [--team-key-provider <anthropic|openai|openrouter>]
                                          [--setup-key-expiration <dur>]
  disable
  status
  rotate-key [--expiration <dur>]        Mint a fresh one-time key to hand a joining team member.

enable turns THIS machine into a Team Host: it provisions the pinned overlay
networking binaries, joins this host to the overlay, and wires the local daemon
to serve your team over it. The networking stack runs unprivileged and entirely
in its own space, so it neither sees nor disturbs a Tailscale you already have
installed. Sudo is needed for one step only — installing the control plane as a
system service — so you may be prompted for your password.
--server-url is the address teammates dial to reach this host.

disable stops serving your team. status prints whether this machine is
currently serving. rotate-key runs ONLY here, on this host's localhost.
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
  // Supervisor lifecycle — manages the platform service + daemon binary, never a
  // project vault. Belongs above the myco.yaml gate alongside daemon/update/remove,
  // so `myco service <verb>` works from any cwd (e.g. a fresh host with no project).
  if (cmd === 'service') return (await import('./cli/service.js')).run(args);

  // Team Host member enrollment — machine-global (writes the ~/.myco-team hosts
  // registry, not a project vault), so it sits above the myco.yaml gate like
  // `service`/`subsystem`. The command name is load-bearing: the affiliation hint
  // tells users to run exactly `myco join <host>`. `resolveVaultDir()` is safe to
  // call unconditionally (falls back to cwd/.myco, never throws) — it's only used
  // to locate the local daemon (`hooks/client.ts` DaemonClient), a machine-global
  // singleton these commands are now a thin fallback wrapper over (Task D-2).
  if (cmd === 'join') return (await import('./cli/join.js')).runJoin(args, resolveVaultDir());
  if (cmd === 'leave') return (await import('./cli/join.js')).runLeave(args, resolveVaultDir());

  // Team Host residency mapping — attach/detach record which host serves a
  // project (machine-global attach registry, not a project vault), so like
  // `join`/`leave` they sit above the myco.yaml gate and work from any cwd.
  if (cmd === 'attach') return (await import('./cli/attach.js')).runAttach(args, resolveVaultDir());
  if (cmd === 'detach') return (await import('./cli/attach.js')).runDetach(args, resolveVaultDir());

  // Team Host operator orchestration — provisions the overlay stack (control
  // plane as a root system service; the networking daemon unprivileged) and
  // writes machine-tier config, not a project vault, so like `join`/`attach` it sits
  // above the myco.yaml gate and works from any cwd.
  if (cmd === 'host') return (await import('./cli/host.js')).runHostCommand(args);

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
