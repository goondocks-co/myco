import path from 'node:path';
import { resolveMycoHome } from '@myco/paths/home.js';
import { normalizeMemberServerAddress } from '@myco/member/server-url.js';
import { parseJoinCode } from '@myco/member/join-code.js';
import { repoVerdict } from '@myco/member/git-verdict.js';
import { UNUSUAL } from '@myco/utils/git-files.js';
import { runGitAnswer } from '@myco/utils/git.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { runnerServerUrl, RUNNER_NAME_PATTERN } from '@myco/cli/runner-deps.js';
import { applyObservedSetupJourney, readSetupFile, saveSetupFile, setupCloudflareUrl, type SetupAnswers } from '@myco/setup/answers.js';
import { observeSetupJourneys, observeSetupStatus, setupExitCode } from '@myco/setup/observe.js';
import { readDefaultDeployment } from '@myco/member/default-deployment.js';
import { deploymentUrl, readRegistryEntryResult, registryEntryPath } from '@myco/member/registry.js';
import { renderSetupStatus } from '@myco/cli/setup-status.js';
import { setupChecks } from '@myco/cli/member-doctor.js';
import { conductSetup, type SetupDeps } from '@myco/setup/steps.js';
import { askOnTerminal, askRequired } from '@myco/setup/prompt.js';
import { APP_NAME_MAX } from '@myco/server/github-app.js';
import { parseArgs as parseCutoverArgs } from '@myco/cli/cutover.js';
import { legacyMigrationState } from '@myco/member/legacy-migration.js';

export const SETUP_HELP = `Usage: myco setup [options]

Guide this machine through starting or joining a Myco, or becoming a runner.
Run again to resume from observed state, including moving Myco 1.4.
Use myco cutover --dry-run for the manual migration path.

  --create cloudflare|local     Start a Deployment (local is loopback only)
  --account-id <id>             Cloudflare account (32 hexadecimal characters)
  --url https://<host>          Custom domain; omit for workers.dev
  --org <name>                 GitHub organization owning the sign-in app
  --app-name <name>             Sign-in app name (default: derived from the host)
  --port <n>                   Local port (default: 8787)
  --serve service|terminal      Start at login, or run in a separate terminal
  --join <host-or-invite-link>   Sign this machine in, then connect a project
  --project <id|name> | --new [name]   Choose or create the project
  --root <dir>                  Repository to connect (default: current repository)
  --default | --keep-default    Choose the default for new repositories
  --no-agents                   Leave agent setup declined
  --cutover | --no-cutover       Move 1.4 after preview, or leave it pending
  --route <projectId>=<url>      Choose a legacy project's destination; repeat
  --skip <projectId>            Leave a legacy project's history on disk; repeat
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
    if (seen.has(arg) && arg !== '--route' && arg !== '--skip') throw new Error(`duplicate option ${arg}`);
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
      case '--create': {
        const target = value();
        if (target !== 'cloudflare' && target !== 'local') throw new Error('--create needs cloudflare or local');
        options.answers.role = 'create'; options.answers.target = target; break;
      }
      case '--account-id': {
        const id = value();
        if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('--account-id needs 32 hexadecimal characters');
        options.answers.accountId = id; break;
      }
      case '--url': {
        options.answers.customUrl = setupCloudflareUrl(value()); options.answers.addressChoice = 'custom'; break;
      }
      case '--org': {
        const org = value();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(org)) throw new Error('--org needs a GitHub organization name');
        options.answers.org = org; break;
      }
      case '--app-name': {
        const name = value().trim();
        if (name.length === 0 || name.length > APP_NAME_MAX) throw new Error(`--app-name needs 1 to ${APP_NAME_MAX} characters`);
        options.answers.appName = name; break;
      }
      case '--port': {
        const port = value();
        if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('--port needs an integer from 1 to 65535');
        options.answers.port = Number(port); break;
      }
      case '--serve': {
        const serve = value();
        if (serve !== 'service' && serve !== 'terminal') throw new Error('--serve needs service or terminal');
        options.answers.serve = serve; break;
      }
      case '--cutover': options.answers.cutover = true; break;
      case '--no-cutover': options.answers.cutover = false; break;
      case '--route': case '--skip': {
        const parsed = parseCutoverArgs([arg, value()]);
        if (parsed.error) throw new Error(parsed.error);
        if (arg === '--route') {
          options.answers.routes ??= {};
          for (const [id, url] of parsed.routes) {
            const origin = runnerServerUrl(url);
            if (origin === null) throw new Error('--route needs <projectId>=<Deployment origin>, with no account, password, path or query');
            if (options.answers.routes[id] !== undefined && options.answers.routes[id] !== origin) throw new Error(`${id} has conflicting --route values`);
            options.answers.routes[id] = origin;
          }
        } else options.answers.skips = [...new Set([...(options.answers.skips ?? []), ...parsed.skips])];
        break;
      }
      default: throw new Error('unknown setup option; run myco setup --help');
    }
  }
  for (const [a, b] of [['--join', '--runner'], ['--create', '--join'], ['--create', '--runner'], ['--project', '--new'], ['--default', '--keep-default'], ['--run-work', '--no-runner'], ['--status', '--change']]) exclusive(a, b);
  validateCreationOptions(options.answers);
  exclusive('--cutover', '--no-cutover');
  for (const id of options.answers.skips ?? []) if (options.answers.routes?.[id] !== undefined) throw new Error(`${id}: choose exactly one of --route or --skip`);
  if ((options.json || options.checkRemote) && !options.status) throw new Error('--json and --check-remote require --status');
  return options;
}

function validateCreationOptions(answers: SetupAnswers): void {
  if (answers.target === 'local' && (answers.customUrl || answers.accountId || answers.org)) throw new Error('Local setup is loopback only; use --port and --serve, without --url, --account-id or --org.');
  if (answers.target === 'cloudflare' && (answers.port !== undefined || answers.serve !== undefined)) throw new Error('Cloudflare setup uses --account-id and --url, without --port or --serve.');
  if (answers.role && answers.role !== 'create' && [answers.target, answers.customUrl, answers.accountId, answers.org, answers.appName, answers.port, answers.serve].some(value => value !== undefined)) throw new Error('Creation options require --create cloudflare or --create local.');
}

export async function run(args: readonly string[], deps: SetupDeps = {}): Promise<number> {
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(SETUP_HELP); return 0; }
  try {
    const options = parseSetupOptions(args);
    const home = deps.mycoHome ?? resolveMycoHome();
    const file = readSetupFile(home);
    const changedTarget = (options.answers.url !== undefined && (options.answers.url !== file.answers.url || options.answers.role !== file.answers.role))
      || (options.answers.role === 'create' && (file.answers.role !== 'create' || options.answers.target !== file.answers.target));
    const newProjectChanged = options.answers.newProject !== undefined && (options.answers.newProject !== file.answers.newProject
      || changedTarget || (options.answers.root !== undefined && options.answers.root !== file.answers.root));
    const previousAnswers = options.change || changedTarget ? {} : file.answers;
    file.answers = { ...previousAnswers, ...options.answers };
    validateCreationOptions(file.answers);
    if (options.answers.project !== undefined) delete file.answers.newProject;
    if (options.answers.newProject !== undefined) delete file.answers.project;
    if (options.answers.routes) {
      file.answers.routes = { ...previousAnswers.routes, ...options.answers.routes };
      file.answers.skips = previousAnswers.skips?.filter(id => options.answers.routes![id] === undefined);
    }
    if (options.answers.skips) {
      file.answers.skips = [...new Set([...(file.answers.skips ?? previousAnswers.skips ?? []), ...options.answers.skips])];
      file.answers.routes = { ...previousAnswers.routes, ...file.answers.routes };
      for (const id of options.answers.skips) delete file.answers.routes?.[id];
    }
    if (options.status) {
      file.answers.root = options.answers.root ?? statusRepository(deps.cwd ?? process.cwd());
      const observations = await observeSetupStatus(home, file.answers, { ...deps, legacyHomeDir: deps.legacyHomeDir ?? deps.cutoverDeps?.env?.HOME, checkRemote: options.checkRemote }, options.answers.role !== undefined);
      const agents = observations.find((fact) => fact.id === 'machine.agents');
      if (agents !== undefined) {
        const checks = setupChecks(home);
        if (checks.some((check) => check.toolsDeployment !== undefined)) {
          agents.informational = checks.every((check) => check.status === 'ok');
          Object.assign(agents, { agentHealth: true });
          agents.state = checks.every((check) => check.status === 'ok') ? 'complete' : 'incomplete';
          agents.detail = checks.map((check) => check.detail).join('\n');
        }
      }
      if (options.json) out(JSON.stringify({ observations }, null, 2));
      else for (const line of renderSetupStatus(observations)) out(line);
      return setupExitCode(observations);
    }
    const ask = deps.ask ?? askOnTerminal;
    const migration = legacyMigrationState(home);
    if (migration.state === 'unavailable') throw new Error(`Legacy migration state unavailable: ${migration.detail}. Restore access, then run myco setup again.`);
    if (migration.state !== 'none' && migration.state !== 'moved') out(`Myco 1.4 sources found (${migration.state}). Setup will preview moving them after sign-in. No legacy binary is executed.`);
    if (!file.answers.role && !options.change) {
      const { guidedJourneys: journeys, failures, inferenceFailures } = observeSetupJourneys(home);
      if (failures.length > 0 || inferenceFailures.length > 0) throw new Error(`${[...failures.map(fact => fact.detail), ...inferenceFailures].join('\n')} Restore access, or pass --join, --create or --runner.`);
      const root = resolveMemberProjectRoot(file.answers.root ?? deps.cwd);
      const binding = journeys.some(journey => journey.role === 'join') ? readRegistryEntryResult(root, home) : { status: 'missing' } as const;
      if (binding.status === 'unavailable') throw new Error(`Repository binding could not be read: ${registryEntryPath(root, home)}. Run myco doctor.`);
      const bound = binding.status === 'present' ? journeys.find(journey => journey.role === 'join' && journey.url === deploymentUrl(binding.entry.serverUrl)) : undefined;
      const defaultUrl = !bound && journeys.length > 1 ? readDefaultDeployment(home, { strict: true })?.serverUrl : undefined;
      let journey = bound ?? (journeys.length === 1 ? journeys[0] : journeys.find(journey => journey.role === 'join' && journey.url === defaultUrl));
      let answered = false;
      if (!journey && journeys.length > 1) {
        const choices = journeys.map((journey, index) => `${index + 1}) ${setupJourneyWords(journey)}`);
        const answer = await askRequired(ask, `Which Myco should setup continue with?\n${choices.join('\n')}\n${journeys.length + 1}) Something else`, '--create cloudflare|local, --join <address> or --runner <address>');
        const index = Number(answer) - 1;
        if (!Number.isInteger(index) || index < 0 || index > journeys.length) throw new Error(`Choose a number from 1 to ${journeys.length + 1}; run myco setup --help for the available choices.`);
        journey = journeys[index];
        answered = true;
      }
      if (journey) {
        if (answered) file.answers = { ...file.answers, ...journey };
        else applyObservedSetupJourney(file, journey);
        validateCreationOptions(file.answers);
        out(bound === journey ? `This repository sends to ${journey.url}; continuing.` : `This machine ${setupJourneyWords(journey)}; continuing.`);
        saveSetupFile(home, file);
      }
    }
    if (!file.answers.role) {
      const role = await askRequired(ask, 'What should this machine do? 1) Start a new Myco 2) Join a Myco 3) Run Myco’s work', '--create cloudflare|local, --join <address> or --runner <address>');
      if (!['1', '2', '3'].includes(role)) throw new Error('Choose 1, 2 or 3; run myco setup --help for the available choices.');
      file.answers.role = role === '1' ? 'create' : role === '2' ? 'join' : 'runner';
      validateCreationOptions(file.answers);
      saveSetupFile(home, file);
    }
    if (!file.answers.url && file.answers.role !== 'create') {
      const address = await askRequired(ask, 'What is your Myco’s address?', file.answers.role === 'join' ? '--join <address>' : '--runner <address>');
      const selected = parseSetupOptions([file.answers.role === 'join' ? '--join' : '--runner', address]);
      file.answers.url = selected.answers.url;
      options.address = address;
      options.answers.role = selected.answers.role;
    }
    validateCreationOptions(file.answers);
    if (file.answers.role === 'join') file.answers.root ??= resolveMemberProjectRoot(deps.cwd);
    if (file.answers.role === 'create') file.answers.root ??= statusRepository(deps.cwd ?? process.cwd());
    saveSetupFile(home, file);
    await conductSetup(home, file, { ...deps, loginAddress: options.address }, { yes: options.yes, explicitJoin: options.answers.role === 'join', explicitLegacyPlacement: args.includes('--route') || args.includes('--skip'), explicitDefault: args.includes('--default'), explicitProject: args.includes('--project'), newProjectChanged });
    return 0;
  } catch (error) {
    err(`myco setup: ${error instanceof Error ? error.message : String(error)}`);
    return args.includes('--status') ? 4 : 2;
  }
}

function setupJourneyWords(journey: SetupAnswers): string {
  if (journey.role === 'join') return `joins ${journey.url}`;
  if (journey.role === 'runner') return `runs Myco’s work for ${journey.url}`;
  return journey.url ? `starts Myco at ${journey.url}` : journey.target === 'local' ? 'starts Myco on this machine' : 'starts Myco on Cloudflare';
}

/** Repository identity follows capture's common-directory rule without keeping a git verdict. */
function statusRepository(cwd: string): string | undefined {
  const verdict = repoVerdict(cwd, process.env, { mycoHome: null });
  if (verdict === null) return undefined;
  if (runGitAnswer(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') return undefined;
  if (verdict === UNUSUAL) return path.resolve(cwd, runGitAnswer(['rev-parse', '--git-common-dir'], cwd), '..');
  return verdict.from === 'files' ? path.dirname(verdict.layout.commonDir) : verdict.root;
}
