#!/usr/bin/env node
import { isHelpRequest } from './cli/flags.js';
import { loadEnv } from './cli/env-file.js';
import { resolveVaultDir } from './project-root.js';
import { runLaunchPreamble } from './cli/launch-preamble.js';
import { isMemberVerb } from './cli/member-verbs.js';
import { keepLoopbackOffProxy } from './cli/loopback-proxy.js';
import { isRetiredVerb, retiredVerbMessage } from './cli/retired-verbs.js';

loadEnv();

const COMMAND_HELP: Record<string, string> = {
  config: "Usage: myco config get [<dot.path.key>]\n\nJoined projects read Deployment Settings; use the dashboard to change them.\n",
  stats: "Usage: myco stats [--credential registry|env]\n\nShow project sessions, activity and agent runs.\n",
  search: "Usage: myco search <query> [--credential registry|env]\n\nSearch project intelligence.\n",
  vectors: "Usage: myco vectors <query> [--credential registry|env]\n\nSearch project intelligence by similarity.\n",
  session: "Usage: myco session [<id>|latest] [--credential registry|env]\n\nShow a project session and its batches.\n",
  tool: "Usage: myco tool list | call <tool-name> --json --input <json|@file> [--credential registry|env]\n\nList or call Myco tools as JSON.\n",
  logs: "Usage: myco logs [--tail|-n <lines>]\n\nShow worker logs and refused events.\n",
  open: "Usage: myco open\n\nOpen the Deployment dashboard in your browser.\n",
  doctor: "Usage: myco doctor [--fix]\n\nCheck member wiring and Deployment reachability.\n",
  version: "Usage: myco version\n\nShow the installed Myco version.\n",
  mcp: "Usage: myco mcp --credential registry\n\nServe the configured MCP stdio surface.\n",
  hook: "Usage: myco hook <name>\n\nRun a harness hook using its JSON input on stdin.\n",
  daemon: "Usage: myco daemon [kill]\n\nAcknowledge a retired daemon launch without starting a runtime.\n",

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
  setup: async () => (await import('./cli/setup.js')).SETUP_HELP,
  update: async () => (await import('./cli/update.js')).UPDATE_HELP,
  upgrade: async () => (await import('./cli/update.js')).UPDATE_HELP,
  cutover: async () => (await import('./cli/cutover.js')).CUTOVER_HELP,
  remove: async () => (await import('./cli/remove.js')).USAGE,

  member: async () => (await import('./cli/member.js')).MEMBER_HELP,
  login: async () => (await import('./cli/login.js')).LOGIN_HELP,
  logout: async () => (await import('./cli/logout.js')).LOGOUT_HELP,
  import: async () => (await import('./cli/import.js')).IMPORT_HELP,
  settings: async () => (await import('./cli/settings.js')).SETTINGS_HELP,
  server: async () => (await import('./cli/server.js')).SERVER_HELP,
  worker: async () => (await import('./cli/worker.js')).WORKER_HELP,
  runner: async () => (await import('./cli/runner.js')).RUNNER_HELP,
};

async function helpForCommand(command: string, args: readonly string[] = []): Promise<string> {
  const nestedCommand = args[0] ? `${command} ${args[0]}` : command;
  const delegated = DELEGATED_HELP[nestedCommand] ?? DELEGATED_HELP[command];
  if (delegated) return await delegated();
  if (COMMAND_HELP[nestedCommand]) return COMMAND_HELP[nestedCommand];
  return COMMAND_HELP[command] ?? `Usage: myco ${command} [args]\n\nRun \`myco --help\` for the full command list.\n`;
}

async function main(): Promise<void> {
  keepLoopbackOffProxy();
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write((await import('./cli/member-dispatch.js')).helpText());
    return;
  }
  if (isRetiredVerb(cmd)) {
    console.error(await retiredVerbMessage(cmd));
    process.exitCode = 1;
    return;
  }
  if (isHelpRequest(args)) {
    process.stdout.write(await helpForCommand(cmd, args));
    return;
  }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log((await import('./version.js')).getPluginVersion());
    return;
  }
  if (cmd === 'mcp') {
    runLaunchPreamble('mcp', args);
    return (await import('./mcp/stdio-bridge.js')).main();
  }
  if (cmd === 'hook') return (await import('./hooks/entry.js')).runHook(args);
  if (cmd === 'daemon') return (await import('./cli/daemon-guard.js')).main();
  if (cmd === 'member') return (await import('./cli/member.js')).run(args);
  if (cmd === 'server') return (await import('./cli/server.js')).run(args);
  if (cmd === 'setup') {
    process.exitCode = await (await import('./cli/setup.js')).run(args);
    return;
  }
  if (cmd === 'import') {
    if (!await (await import('./cli/import.js')).run(args)) process.exitCode = 2;
    return;
  }
  if (cmd === 'cutover') {
    if (!await (await import('./cli/cutover.js')).run(args)) process.exitCode = 2;
    return;
  }
  if (cmd === 'login') {
    if (!await (await import('./cli/login.js')).run(args)) process.exitCode = 2;
    return;
  }
  if (cmd === 'logout') {
    if (!await (await import('./cli/logout.js')).run(args)) process.exitCode = 2;
    return;
  }
  if (cmd === 'worker') {
    if (!await (await import('./cli/worker.js')).run(args)) process.exitCode = 2;
    return;
  }
  if (cmd === 'runner') {
    if (!await (await import('./cli/runner.js')).run(args)) process.exitCode = 2;
    return;
  }
  if (cmd === 'settings') return (await import('./cli/settings.js')).run(args);
  if (isMemberVerb(cmd)) {
    if (!await (await import('./cli/member-dispatch.js')).runMemberVerb(cmd, args)) process.exitCode = 1;
    return;
  }
  if (cmd === 'update') return (await import('./cli/update.js')).run(args);
  if (cmd === 'upgrade') return (await import('./cli/upgrade.js')).run(args);
  if (cmd === 'remove') return (await import('./cli/remove.js')).run(args);
  if (cmd === 'open') {
    if (!await (await import('./cli/open.js')).run(args)) process.exitCode = 1;
    return;
  }
  if (cmd === 'tool') {
    runLaunchPreamble('tool', args);
    return (await import('./cli/tool.js')).run(args, resolveVaultDir());
  }
  console.error(`Unknown command: ${cmd}`);
  process.stdout.write((await import('./cli/member-dispatch.js')).helpText());
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`myco: ${(err as Error).message}`);
  process.exitCode = 1;
});
