import path from 'node:path';
import { resolveMycoHome } from '@myco/paths/home.js';
import { normalizeMemberServerAddress } from '@myco/member/server-url.js';
import { parseJoinCode } from '@myco/member/join-code.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { runnerServerUrl, RUNNER_NAME_PATTERN } from '@myco/cli/runner-deps.js';
import { readSetupFile, saveSetupFile, type SetupAnswers } from '@myco/setup/answers.js';
import { observeSetup, setupExitCode } from '@myco/setup/observe.js';
import { conductSetup, type SetupDeps } from '@myco/setup/steps.js';
import { askOnTerminal, askRequired } from '@myco/setup/prompt.js';

export const SETUP_HELP = `Usage: myco setup [options]

Guide this machine through joining a Myco or becoming a runner. Run again to
resume from observed state. Creating a Deployment and guided legacy migration
are not available here yet; use myco server create or myco cutover --dry-run.

  --join <host-or-invite-link>   Sign this machine in, then connect a project
  --project <id|name> | --new [name]   Choose or create the project
  --root <dir>                  Repository to connect (default: current repository)
  --default | --keep-default    Choose the default for new repositories
  --no-agents                   Leave agent setup declined
  --run-work | --no-runner       Choose whether a joining machine also runs work
  --runner <host>               Register an always-on runner (no membership needed)
  --runner-name <name>          Name for a new runner
  --runner-service install|skip Start at login, or keep service setup declined
  --yes                         Approve a printed first plan; changed plans ask again
  --change                      Ask for choices again; observed progress is kept
  --status [--json] [--check-remote]
                                Read only; remote checks never renew credentials

Status exits: 0 complete, 3 steps remain, 4 an observation is unavailable.
Browser approvals always require a person, including with --yes.
`;

interface Options {
  answers: SetupAnswers;
  address?: string;
  status: boolean;
  json: boolean;
  checkRemote: boolean;
  yes: boolean;
  change: boolean;
}

export function parseSetupOptions(args: readonly string[]): Options {
  const options: Options = { answers: {}, status: false, json: false, checkRemote: false, yes: false, change: false };
  const seen = new Set<string>();
  const exclusive = (a: string, b: string) => { if (seen.has(a) && seen.has(b)) throw new Error(`${a} and ${b} cannot be combined`); };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error(`duplicate option ${arg}`);
    seen.add(arg);
    const value = (): string => {
      const next = args[++index];
      if (next === undefined || next.startsWith('-')) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case '--join': case '--runner': {
        const address = value();
        const url = normalizeMemberServerAddress(address);
        if (!url) throw new Error(`${arg} needs a valid Deployment address`);
        if (arg === '--runner' && !runnerServerUrl(address)) throw new Error('--runner needs a Deployment origin, with no path, query or fragment');
        if (arg === '--join' && (url.pathname !== '/' || url.hash || url.search)) {
          if ('error' in parseJoinCode(url.href)) throw new Error('--join needs a Deployment address or a valid invite link');
        }
        options.answers.role = arg === '--join' ? 'join' : 'runner';
        options.answers.url = url.origin;
        options.address = address;
        break;
      }
      case '--project': options.answers.project = value(); break;
      case '--root': options.answers.root = path.resolve(value()); break;
      case '--runner-name': {
        const name = value();
        if (!RUNNER_NAME_PATTERN.test(name)) throw new Error('--runner-name needs 1 to 64 letters, digits, dots, underscores or dashes');
        options.answers.runnerName = name; break;
      }
      case '--runner-service': {
        const service = value();
        if (service !== 'install' && service !== 'skip') throw new Error('--runner-service needs install or skip');
        options.answers.runnerService = service; break;
      }
      case '--new': options.answers.newProject = args[index + 1] && !args[index + 1].startsWith('-') ? args[++index] : true; break;
      case '--no-agents': options.answers.noAgents = true; break;
      case '--default': options.answers.makeDefault = true; break;
      case '--keep-default': options.answers.makeDefault = false; break;
      case '--run-work': options.answers.runWork = true; break;
      case '--no-runner': options.answers.runWork = false; break;
      case '--status': options.status = true; break;
      case '--json': options.json = true; break;
      case '--check-remote': options.checkRemote = true; break;
      case '--yes': options.yes = true; break;
      case '--change': options.change = true; break;
      case '--help': case '-h': break;
      case '--create': throw new Error('Guided Deployment creation is not available here yet; use myco server create --target cloudflare|local.');
      case '--cutover': case '--no-cutover': case '--route': case '--skip': throw new Error('Guided migration is not available here yet; use myco cutover --dry-run.');
      default: throw new Error('unknown setup option; run myco setup --help');
    }
  }
  for (const [a, b] of [['--join', '--runner'], ['--project', '--new'], ['--default', '--keep-default'], ['--run-work', '--no-runner'], ['--status', '--change']]) exclusive(a, b);
  if ((options.json || options.checkRemote) && !options.status) throw new Error('--json and --check-remote require --status');
  return options;
}

export async function run(args: readonly string[], deps: SetupDeps = {}): Promise<number> {
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(SETUP_HELP); return 0; }
  try {
    const options = parseSetupOptions(args);
    const home = deps.mycoHome ?? resolveMycoHome();
    const file = readSetupFile(home);
    const changedTarget = options.answers.url !== undefined && (options.answers.url !== file.answers.url || options.answers.role !== file.answers.role);
    const newProjectChanged = options.answers.newProject !== undefined && (options.answers.newProject !== file.answers.newProject
      || changedTarget || (options.answers.root !== undefined && options.answers.root !== file.answers.root));
    file.answers = { ...(options.change || changedTarget ? {} : file.answers), ...options.answers };
    if (options.answers.project !== undefined) delete file.answers.newProject;
    if (options.answers.newProject !== undefined) delete file.answers.project;
    if (options.status) {
      const observations = await observeSetup(home, file.answers, { ...deps, checkRemote: options.checkRemote });
      if (options.json) out(JSON.stringify({ observations }, null, 2));
      else for (const fact of observations) out(`${fact.id} [${fact.scope}]: ${fact.state} — ${fact.detail}`);
      return setupExitCode(observations);
    }
    const ask = deps.ask ?? askOnTerminal;
    if (!file.answers.role) {
      const role = await askRequired(ask, 'What should this machine do? 1) Join a Myco 2) Run Myco’s work', '--join <address> or --runner <address>');
      if (role !== '1' && role !== '2') throw new Error('Choose 1 or 2; use myco server create to create a Deployment.');
      file.answers.role = role === '1' ? 'join' : 'runner';
    }
    if (!file.answers.url) {
      const address = await askRequired(ask, 'What is your Myco’s address?', file.answers.role === 'join' ? '--join <address>' : '--runner <address>');
      const selected = parseSetupOptions([file.answers.role === 'join' ? '--join' : '--runner', address]);
      file.answers.url = selected.answers.url;
      options.address = address;
      options.answers.role = selected.answers.role;
    }
    if (file.answers.role === 'join') file.answers.root ??= resolveMemberProjectRoot(deps.cwd);
    saveSetupFile(home, file);
    await conductSetup(home, file, { ...deps, loginAddress: options.address }, { yes: options.yes, explicitJoin: options.answers.role === 'join', explicitDefault: args.includes('--default'), explicitProject: args.includes('--project'), newProjectChanged });
    return 0;
  } catch (error) {
    err(`myco setup: ${error instanceof Error ? error.message : String(error)}`);
    return args.includes('--status') ? 4 : 2;
  }
}
