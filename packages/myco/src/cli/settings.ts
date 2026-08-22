/**
 * `myco settings --harness <name> --project <id>` prints the harness settings
 * block a sandbox launch hands to `--settings`: the member's hooks, declaring
 * `--credential env`, and nothing else. It is the `member-project` install
 * scope's emitter run print-only, so a sandbox and a laptop can differ only in
 * where the credential comes from.
 *
 * Nothing is written and no token is read: the sandbox supplies
 * `MYCO_SERVER_URL` + `MYCO_MEMBER_TOKEN` + `MYCO_PROJECT` in the environment
 * of the process it launches.
 */
import { PROJECT_ID_PATTERN } from '../member/constants.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { SymbiontInstaller } from '../symbionts/installer.js';

export const SETTINGS_HELP = `Usage: myco settings --harness <name> --project <id>

Prints the harness settings for a sandboxed agent that reports to a Myco server.
Pass it to the agent's own settings flag, and give the process MYCO_SERVER_URL,
MYCO_MEMBER_TOKEN and MYCO_PROJECT — the settings carry no credential.

Options:
  --harness <name>   The agent to emit settings for (e.g. claude-code).
  --project <id>     The project the sandbox reports to; the same id the launch exports as MYCO_PROJECT.
`;

export interface SettingsCliDeps {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

function flagValue(args: readonly string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
}

export function run(args: readonly string[], deps: SettingsCliDeps = {}): void {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  const harness = flagValue(args, '--harness');
  const project = flagValue(args, '--project');
  if (!harness || !project) {
    err(SETTINGS_HELP.trimEnd());
    process.exitCode = 2;
    return;
  }
  if (!PROJECT_ID_PATTERN.test(project)) {
    err(`myco settings: ${project} is not a project id`);
    process.exitCode = 2;
    return;
  }
  const manifest = loadManifests().find((m) => m.name === harness);
  if (!manifest) {
    err(`myco settings: unknown agent "${harness}"`);
    process.exitCode = 2;
    return;
  }
  const installer = new SymbiontInstaller(manifest, deps.cwd ?? process.cwd(), resolvePackageRoot(), false, undefined, null, 'member-project');
  const hooks = installer.renderMemberHooks('env');
  if (hooks === null) {
    err(`myco settings: ${manifest.displayName} cannot report to a server from a sandbox`);
    process.exitCode = 2;
    return;
  }
  out(JSON.stringify({ hooks }, null, 2));
}
