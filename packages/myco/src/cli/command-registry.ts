import { resolveVaultDir } from '../project-root.js';
import { runLaunchPreamble } from './launch-preamble.js';

export interface CommandRegistration {
  group: string;
  usage: string;
  description: string;
  help: string | (() => Promise<string>);
  run: (args: string[]) => Promise<void>;
}

export const COMMANDS: Record<string, CommandRegistration> = {
  setup: {
    group: "Membership",
    usage: "[options]",
    description: "Guide sign-in and runner enrollment; --status reads only",
    help: async () => (await import('./setup.js')).SETUP_HELP,
    run: async args => { process.exitCode = await (await import('./setup.js')).run(args); },
  },
  logout: {
    group: "Membership",
    usage: "<address>",
    description: "Sign this machine out of a Deployment",
    help: async () => (await import('./logout.js')).LOGOUT_HELP,
    run: async args => { if (!await (await import('./logout.js')).run(args)) process.exitCode = 2; },
  },
  cutover: {
    group: "Membership",
    usage: "",
    description: "Move Myco 1.4 data to a Deployment (--dry-run first)",
    help: async () => (await import('./cutover.js')).CUTOVER_HELP,
    run: async args => { if (!await (await import('./cutover.js')).run(args)) process.exitCode = 2; },
  },
  login: {
    group: "Membership",
    usage: "<address-or-invite-link>",
    description: "Sign this machine in through your Myco dashboard",
    help: async () => (await import('./login.js')).LOGIN_HELP,
    run: async args => { if (!await (await import('./login.js')).run(args)) process.exitCode = 2; },
  },
  member: {
    group: "Membership",
    usage: "<op>",
    description: "Connect projects, set up agents and deliver captured sessions",
    help: async () => (await import('./member.js')).MEMBER_HELP,
    run: async args => (await import('./member.js')).run(args),
  },
  import: {
    group: "Membership",
    usage: "",
    description: "Bring this machine's existing agent history to its Deployment",
    help: async () => (await import('./import.js')).IMPORT_HELP,
    run: async args => { if (!await (await import('./import.js')).run(args)) process.exitCode = 2; },
  },
  runner: {
    group: "Membership",
    usage: "<verb>",
    description: "Register and manage a runner for agent work",
    help: async () => (await import('./runner.js')).RUNNER_HELP,
    run: async args => { if (!await (await import('./runner.js')).run(args)) process.exitCode = 2; },
  },
  worker: {
    group: "Membership",
    usage: "[options]",
    description: "Inspect harnesses and manage runner or legacy worker services",
    help: async () => (await import('./worker.js')).WORKER_HELP,
    run: async args => { if (!await (await import('./worker.js')).run(args)) process.exitCode = 2; },
  },
  search: {
    group: "Project intelligence (answered by the Deployment for this project)",
    usage: "<query>",
    description: "Search spores, sessions, plans and prompts",
    help: "Usage: myco search <query> [--credential registry|env]\n\nSearch project intelligence.\n",
    run: async args => { if (!await (await import('./member-dispatch.js')).runMemberVerb('search', args)) process.exitCode = 1; },
  },
  vectors: {
    group: "Project intelligence (answered by the Deployment for this project)",
    usage: "<query>",
    description: "Search by meaning with similarity scores",
    help: "Usage: myco vectors <query> [--credential registry|env]\n\nSearch project intelligence by similarity.\n",
    run: async args => { if (!await (await import('./member-dispatch.js')).runMemberVerb('vectors', args)) process.exitCode = 1; },
  },
  session: {
    group: "Project intelligence (answered by the Deployment for this project)",
    usage: "[id|latest]",
    description: "Show a session",
    help: "Usage: myco session [<id>|latest] [--credential registry|env]\n\nShow a project session and its batches.\n",
    run: async args => { if (!await (await import('./member-dispatch.js')).runMemberVerb('session', args)) process.exitCode = 1; },
  },
  stats: {
    group: "Project intelligence (answered by the Deployment for this project)",
    usage: "",
    description: "This project on its Deployment: sessions, activity, agent runs",
    help: "Usage: myco stats [--credential registry|env]\n\nShow project sessions, activity and agent runs.\n",
    run: async args => { if (!await (await import('./member-dispatch.js')).runMemberVerb('stats', args)) process.exitCode = 1; },
  },
  tool: {
    group: "Project intelligence (answered by the Deployment for this project)",
    usage: "<list|call>",
    description: "List or call Myco tools as JSON",
    help: "Usage: myco tool list | call <tool-name> --json --input <json|@file> [--credential registry|env]\n\nList or call Myco tools as JSON.\n",
    run: async args => { runLaunchPreamble('tool', args); await (await import('./tool.js')).run(args, resolveVaultDir()); },
  },
  open: {
    group: "Project intelligence (answered by the Deployment for this project)",
    usage: "",
    description: "Open the Deployment dashboard in your browser",
    help: "Usage: myco open\n\nOpen the Deployment dashboard in your browser.\n",
    run: async args => { if (!await (await import('./open.js')).run(args)) process.exitCode = 1; },
  },
  doctor: {
    group: "This machine",
    usage: "",
    description: "Check membership, capture, spool, MCP, worker and Deployment reachability",
    help: "Usage: myco doctor\n\nCheck member wiring and Deployment reachability.\n",
    run: async args => { if (!await (await import('./member-dispatch.js')).runMemberVerb('doctor', args)) process.exitCode = 1; },
  },
  logs: {
    group: "This machine",
    usage: "[--tail N]",
    description: "Show the worker's logs and the events the Deployment refused",
    help: "Usage: myco logs [--tail|-n <lines>]\n\nShow worker logs and refused events.\n",
    run: async args => { if (!await (await import('./member-dispatch.js')).runMemberVerb('logs', args)) process.exitCode = 1; },
  },
  config: {
    group: "This machine",
    usage: "get [<leaf>]",
    description: "Show Deployment Settings (written in the dashboard)",
    help: "Usage: myco config get [<dot.path.key>]\n\nJoined projects read Deployment Settings; use the dashboard to change them.\n",
    run: async args => { if (!await (await import('./member-dispatch.js')).runMemberVerb('config', args)) process.exitCode = 1; },
  },
  settings: {
    group: "This machine",
    usage: "",
    description: "Print harness settings for a sandboxed agent (--harness <name> --project <id>)",
    help: async () => (await import('./settings.js')).SETTINGS_HELP,
    run: async args => (await import('./settings.js')).run(args),
  },
  update: {
    group: "This machine",
    usage: "(alias: upgrade)",
    description: "Update Myco within its recorded channel; refresh member agents",
    help: async () => (await import('./update.js')).UPDATE_HELP,
    run: async args => (await import('./update.js')).run(args),
  },
  remove: {
    group: "This machine",
    usage: "[--purge] [--allow-deployment-loss]",
    description: "Remove member integrations; optionally purge owned 2.0 data",
    help: async () => (await import('./remove.js')).USAGE,
    run: async args => (await import('./remove.js')).run(args),
  },
  version: {
    group: "This machine",
    usage: "",
    description: "Show the installed version",
    help: "Usage: myco version\n\nShow the installed Myco version.\n",
    run: async () => { console.log((await import('../version.js')).getPluginVersion()); },
  },
  server: {
    group: "Self-hosting",
    usage: "<subcommand>",
    description: "Create, run and manage a Deployment on this machine",
    help: async () => (await import('./server.js')).SERVER_HELP,
    run: async args => (await import('./server.js')).run(args),
  },
  upgrade: {
    group: "This machine",
    usage: "[options]",
    description: "Alias for update",
    help: async () => (await import('./update.js')).UPDATE_HELP,
    run: async args => (await import('./upgrade.js')).run(args),
  },
  hook: {
    group: "Agent integration",
    usage: "<name>",
    description: "Run a capture hook using JSON input from the agent",
    help: "Usage: myco hook <name>\n\nRun a harness hook using its JSON input on stdin.\n",
    run: async args => (await import('../hooks/entry.js')).runHook(args),
  },
  mcp: {
    group: "Agent integration",
    usage: "--credential registry",
    description: "Serve the configured MCP connection",
    help: "Usage: myco mcp --credential registry\n\nServe the configured MCP stdio surface.\n",
    run: async args => { runLaunchPreamble('mcp', args); await (await import('../mcp/stdio-bridge.js')).main(); },
  },

};

export function renderTopLevelHelp(): string {
  const groups = new Map<string, string[]>();
  for (const [name, command] of Object.entries(COMMANDS)) {
    const lines = groups.get(command.group) ?? [];
    lines.push("  " + [name, command.usage].filter(Boolean).join(" ").padEnd(48) + " " + command.description);
    groups.set(command.group, lines);
  }
  return "Usage: myco <command> [args]\n\n" + [...groups].map(([group, lines]) => group + ":\n" + lines.join("\n")).join("\n\n") + "\n";
}

/** Retired launch compatibility is separate from the public 2.0 commands. */
export const COMPATIBILITY_COMMANDS: Record<string, Pick<CommandRegistration, 'help' | 'run'>> = {
  daemon: {
    help: "Usage: myco daemon [kill]\n\nAcknowledge a retired daemon launch without starting a runtime.\n",
    run: async () => (await import('./daemon-guard.js')).main(),
  },
};

export async function helpForCommand(command: string): Promise<string> {
  const registration = Object.hasOwn(COMMANDS, command) ? COMMANDS[command]
    : Object.hasOwn(COMPATIBILITY_COMMANDS, command) ? COMPATIBILITY_COMMANDS[command] : undefined;
  if (!registration) return `Usage: myco ${command} [args]\n\nRun \`myco --help\` for the full command list.\n`;
  return typeof registration.help === 'string' ? registration.help : await registration.help();
}
