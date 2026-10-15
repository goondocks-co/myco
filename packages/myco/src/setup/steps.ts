import { hostname } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SIGN_IN_WAIT, SETUP_CREATE_GUIDANCE } from '@goondocks/myco-shared/setup-guidance';
import { run as login, type LoginDeps } from '@myco/cli/login.js';
import { runJoin, runDrain, provisionDetectedAgents, detectedProvisionLines, recordNoAgents, type MemberCliDeps } from '@myco/cli/member.js';
import { registerRunner } from '@myco/cli/runner-register.js';
import { defaultRunnerName, runnerServerUrl } from '@myco/cli/runner-deps.js';
import { legacyWorkerInventory, preflightRunnerService, runnerServiceContact, runRunnerService, type RunnerServiceDeps } from '@myco/cli/runner-service.js';
import { executorServiceTarget } from '@myco/cli/worker-service.js';
import { harnessDirectories, workerServiceStatus, workerServiceUnit, workerServiceSpec } from '@myco/runner/service.js';
import { servicePaths } from '@myco/server/service.js';
import { openBrowser } from '@goondocks/myco-shared';
import { assertWranglerReady, ensureCommandDir, peekCommandDir, operatorLogin, listAccounts, peekDeploymentRecord, WranglerNotSignedIn, type OperatorLogin } from '@myco/server/cloudflare.js';
import { createCloudflareDeployment, planCloudflareDeployment } from '@myco/server/cloudflare-lifecycle.js';
import { cloudflareOwnerLinked, setupCloudflareOwner } from '@myco/server/cloudflare-owner.js';
import { registerGitHubApp, defaultAppName, hasPendingSignIn, type RegisterOptions, type SignInTarget } from '@myco/server/github-app.js';
import { DEFAULT_LOCAL_PORT, peekLocalPaths, readLocalRecord } from '@myco/server/local.js';
import { prepareLocal, recoverLocalOwnerLink, localServiceSpec, LOCAL_SCHEMA_BEHIND, type LocalPrepareDeps, type LocalPreparePlan } from '@myco/server/local-lifecycle.js';
import { localOwnerLinked, waitForOwnerLink, type LocalOwnerLink } from '@myco/server/local-owner.js';
import { carriedNative } from '@myco/server/local-run.js';
import { runOrThrow, systemRunner } from '@myco/server/runner.js';
import { readRunnerRecord } from '@myco/runner/runner-registry.js';
import { readDefaultDeployment, recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { deploymentUrl, listDeploymentMembershipsResult, listRegistryEntriesResult } from '@myco/member/registry.js';
import { canonicalPlan, planFingerprint, saveSetupFile, setupCloudflareUrl, type SetupFile, type SetupPlan } from '@myco/setup/answers.js';
import { observeSetup, type Observation, type ObserveDeps } from '@myco/setup/observe.js';
import { askOnTerminal, askRequired, confirm, type Ask } from '@myco/setup/prompt.js';
import { planCutover, runCutover, cutoverSourcePlan, cutoverReconciliation, type CutoverDeps, type CutoverPlan } from '@myco/cli/cutover.js';
import { legacyMigrationState } from '@myco/member/legacy-migration.js';
import { observeLegacyMigration, legacyConfirmationObserver } from '@myco/cli/cutover.js';

const OFFER_WAIT_MS = 2 * 60_000;
const OFFER_POLL_MS = 1000;

export interface SetupDeps extends ObserveDeps {
  cutoverDeps?: CutoverDeps;
  planCutover?: typeof planCutover;
  runCutover?: typeof runCutover;
  local?: Partial<LocalPrepareDeps>;
  planCloudflare?: typeof planCloudflareDeployment;
  createCloudflare?: typeof createCloudflareDeployment;
  prepareLocal?: typeof prepareLocal;
  recoverLocal?: typeof recoverLocalOwnerLink;
  registerApp?: typeof registerGitHubApp;
  github?: Pick<RegisterOptions, 'fetchImpl' | 'timeoutMs' | 'existing'>;
  openUrl?: (url: string) => void | Promise<void>;
  loginAddress?: string;
  mycoHome?: string;
  cwd?: string;
  ask?: Ask;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  login?: typeof login;
  loginDeps?: LoginDeps;
  join?: typeof runJoin;
  memberDeps?: MemberCliDeps;
  register?: typeof registerRunner;
  service?: typeof runRunnerService;
  runnerDeps?: RunnerServiceDeps;
}

interface Context {
  home: string;
  file: SetupFile;
  deps: SetupDeps;
  yes: boolean;
  explicitJoin: boolean;
  explicitLegacyPlacement: boolean;
  explicitDefault: boolean;
  explicitProject: boolean;
  newProjectChanged: boolean;
  ask: Ask;
  out: (line: string) => void;
  facts: Observation[];
  ownerLink?: LocalOwnerLink | null;
  ownerLogin?: { accountId: string; login: OperatorLogin };
  legacySummary?: string;
}
interface SetupStep {
  id: string;
  requires: readonly string[];
  applies: (ctx: Context) => boolean;
  act: (ctx: Context) => Promise<void>;
}

const chosen = (ctx: Context) => {
  const { url, role } = ctx.file.answers;
  if (!url || !role) throw new Error('Choose --create cloudflare|local, --join <address> or --runner <address>.');
  return { ...ctx.file.answers, url, role };
};
const fact = (ctx: Context, id: string) => ctx.facts.find((value) => value.id === id);
const isCreate = (ctx: Context) => ctx.file.answers.role === 'create';
const isCloudflare = (ctx: Context) => isCreate(ctx) && ctx.file.answers.target === 'cloudflare';
const isLocal = (ctx: Context) => isCreate(ctx) && ctx.file.answers.target === 'local';
const isMember = (ctx: Context) => ctx.file.answers.role === 'join' || isCreate(ctx);
const isRunner = (ctx: Context) => chosen(ctx).role === 'runner' || chosen(ctx).runWork === true;
const runnerDeps = (ctx: Context): RunnerServiceDeps => ({
  ...ctx.deps.worker, ...ctx.deps.runnerDeps, mycoHome: ctx.home, fetch: ctx.deps.fetch,
  stdout: ctx.out, stderr: ctx.deps.stderr, now: ctx.deps.now, sleep: ctx.deps.sleep,
});

/** Changed plans always need a new answer, including a rerun with --yes. */
export async function consentToPlan(input: {
  home: string; file: SetupFile; id: string; plan: SetupPlan; question: string;
  ask: Ask; out: (line: string) => void; yes: boolean;
}): Promise<void> {
  const fingerprint = planFingerprint(input.plan);
  const previous = input.file.consented[input.id];
  if (previous === fingerprint) return;
  input.out(`${input.question}\n${canonicalPlan(input.plan)}`);
  if (previous !== undefined) input.out('This plan changed; its previous consent no longer applies.');
  if (!(previous === undefined && input.yes)
    && !await confirm(input.ask, 'Approve this plan?', previous === undefined ? '--yes or an interactive terminal' : 'an interactive terminal (changed plans require fresh consent)')) {
    throw new Error('Plan declined; run myco setup again when ready.');
  }
  input.file.consented[input.id] = fingerprint;
  saveSetupFile(input.home, input.file);
}
const consent = (ctx: Context, id: string, plan: SetupPlan, question: string, yes = ctx.yes) =>
  consentToPlan({ ...ctx, id, plan, question, yes });

const hostedOptions = (ctx: Context) => {
  const accountId = ctx.file.answers.accountId ?? peekDeploymentRecord(ctx.home)?.accountId ?? '';
  const options = { ...ctx.deps.cloudflare, mycoHome: ctx.home, accountId, report: ctx.out, signInFetch: ctx.deps.fetch };
  if (accountId && ctx.ownerLogin?.accountId !== accountId) ctx.ownerLogin = { accountId, login: options.login ?? operatorLogin({ ...options, configDir: peekCommandDir(ctx.home) }) };
  return { ...options, ...(ctx.ownerLogin ? { login: ctx.ownerLogin.login } : {}) };
};
const openUrl = async (ctx: Context, url: string) => {
  try { await (ctx.deps.openUrl ?? openBrowser)(url); }
  catch (error) {
    ctx.deps.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    ctx.out('The browser could not open. Open the printed link in your browser.');
  }
};
const consentToOccurrence = async (ctx: Context, question: string): Promise<void> => {
  if (!ctx.yes && !await confirm(ctx.ask, question, '--yes or an interactive terminal')) throw new Error('Plan declined; run myco setup again when ready.');
};
const localDeps = (ctx: Context): LocalPrepareDeps => ({
  ...ctx.deps.local, native: ctx.deps.local?.native ?? carriedNative(), fetchImpl: ctx.deps.fetch ?? ctx.deps.local?.fetchImpl,
  now: ctx.deps.now, sleep: ctx.deps.sleep, signal: ctx.deps.signal, log: ctx.out,
  registerSignIn: ctx.deps.registerApp ?? ctx.deps.local?.registerSignIn,
  confirmStop: async () => { await consentToOccurrence(ctx, 'This stops your Myco for a moment. Continue?'); return true; },
});
const localPlan = (ctx: Context, signIn: RegisterOptions | 'skip'): LocalPreparePlan => ({
  retryCommand: 'myco setup', port: ctx.file.answers.port!, signIn, owner: 'mint', serve: ctx.file.answers.serve!,
});

/** Consent names source content and placement, independently of completed handover actions. */
export function cutoverConsentPlan(plan: CutoverPlan): SetupPlan {
  return cutoverSourcePlan(plan);
}

const LEGACY_COPY = {
  unmoved: 'Myco 1.4 history has not moved. Next, setup previews moving it over.',
  changed: 'Myco 1.4 wrote more data after migration. Keep the 1.4 files; run myco setup --cutover to review the new data.',
  partial: 'Some history or transcripts remain unfinished. Setup resumes accepted imports from their ledger; keep all 1.4 data.',
  'needs-destination': 'Confirm where each project goes. Projects without a destination need --route <projectId>=<url> or --skip <projectId>.',
  'handover-pending': 'The agent and service handover is unfinished. Setup previews the remaining handover and imports.',
} as const;

function showCutoverPreview(ctx: Context, plan: CutoverPlan): void {
  ctx.out('Myco 1.4 cutover preview (dry run):');
  ctx.out(`  Capture agents: ${plan.agents.join(', ') || 'declined or none detected'}`);
  for (const vault of plan.vaults) ctx.out(`  Vault ${vault.vault}: ${JSON.stringify(vault.counts)}; digest ${vault.digest}`);
  for (const project of plan.projects) ctx.out(`  ${project.vault} :: ${project.projectId}: ${project.destination.kind === 'destination' ? project.destination.serverUrl : project.destination.kind}${project.fallback ? ` (${project.fallback === 'default' ? 'default Deployment' : '--server'}; no repository route)` : ''}; folder ${project.root ?? '(absent)'}; ${JSON.stringify(project.counts)}`);
  for (const step of plan.handover) for (const action of step.actions) ctx.out(`  ${action.would}`);
  for (const copy of plan.copies) ctx.out(`  ${copy.reused ? 'Reuse verified copy' : 'Copy and verify'} ${copy.vault} at ${copy.copy}`);
  ctx.out(`1.4 vaults and history stay on disk: ${plan.vaults.map(vault => vault.vault).join(', ')}. Verified copies and settings backups are retained.`);
}

async function conductLegacy(ctx: Context): Promise<void> {
  const migration = await (ctx.deps.legacyObserver ?? observeLegacyMigration)(ctx.home, { fetch: ctx.deps.fetch ?? ctx.deps.cutoverDeps?.fetch, now: ctx.deps.now, homeDir: ctx.deps.legacyHomeDir, homes: ctx.deps.legacyHomes });
  if (migration.state === 'unavailable') throw new Error(`Legacy migration state unavailable: ${migration.detail}. Restore access, then run myco setup again.`);
  if (migration.state === 'none' || (migration.state === 'moved' && !ctx.explicitLegacyPlacement)) return;
  if (migration.state !== 'moved') ctx.out(migration.state === 'unmoved' && migration.legacyOwnsCapture === true
    ? 'Myco 1.4 still captures your agents here. Next, setup previews moving it over.' : LEGACY_COPY[migration.state]);
  if (ctx.file.answers.cutover === false) throw new Error('Myco 1.4 migration remains pending; keep its data. Run myco setup --cutover when ready, or preview manually with myco cutover --dry-run.');
  const deps: CutoverDeps = {
    ...ctx.deps.cutoverDeps, mycoHome: ctx.home, fetch: ctx.deps.fetch ?? ctx.deps.cutoverDeps?.fetch,
    agents: ctx.file.answers.noAgents ? () => [] : ctx.deps.agents ?? ctx.deps.cutoverDeps?.agents,
    packageRoot: ctx.deps.packageRoot ?? ctx.deps.cutoverDeps?.packageRoot,
    stdout: ctx.out, stderr: ctx.deps.stderr, now: ctx.deps.now, sleep: ctx.deps.sleep, signal: ctx.deps.signal,
    onStoppedSource: async stopped => {
      ctx.file.consented.cutover = planFingerprint(cutoverConsentPlan(stopped));
      saveSetupFile(ctx.home, ctx.file);
    },
  };
  const preview = () => (ctx.deps.planCutover ?? planCutover)(ctx.home, {
    routes: new Map(Object.entries(ctx.file.answers.routes ?? {})), skips: new Set(ctx.file.answers.skips ?? []),
    dryRun: true, requireSourceMatch: true, homeDir: ctx.deps.legacyHomeDir ?? deps.env?.HOME, legacyHomes: ctx.deps.legacyHomes,
  }, deps);
  let plan = preview();
  showCutoverPreview(ctx, plan);
  const memberships = listDeploymentMembershipsResult(ctx.home);
  if (!memberships.readable || memberships.unavailableEntries > 0) throw new Error('Deployment memberships could not all be read; restore access before cutover.');
  const needsChoice = (project: CutoverPlan['projects'][number]) => project.destination.kind === 'undecided' || (memberships.memberships.length > 1 && project.fallback !== undefined);
  while (plan.projects.some(needsChoice)) {
    for (const id of new Set(plan.projects.filter(needsChoice).map(project => project.projectId))) {
      const answer = await askRequired(ctx.ask, `${id}: destination URL, or skip to leave its history on disk?`, `--route ${id}=<url> or --skip ${id}`);
      if (answer === 'skip') ctx.file.answers.skips = [...new Set([...(ctx.file.answers.skips ?? []), id])];
      else {
        const url = runnerServerUrl(answer);
        if (url === null) throw new Error(`Use --route ${id}=<Deployment origin> or --skip ${id}.`);
        ctx.file.answers.routes = { ...ctx.file.answers.routes, [id]: url };
      }
      saveSetupFile(ctx.home, ctx.file);
    }
    plan = preview();
    showCutoverPreview(ctx, plan);
  }
  if (plan.blockers.length > 0) throw new Error(`${plan.blockers.join('\n')}\nNothing was moved. Resolve these choices, then run myco setup --cutover again.`);
  const reconciliation = cutoverReconciliation(ctx.home);
  if (reconciliation && ctx.file.consented.cutover === planFingerprint(JSON.parse(reconciliation.before))
    && planFingerprint(cutoverConsentPlan(plan)) === planFingerprint(JSON.parse(reconciliation.after))) {
    ctx.file.consented.cutover = planFingerprint(cutoverConsentPlan(plan));
    saveSetupFile(ctx.home, ctx.file);
  }
  await consent(ctx, 'cutover', cutoverConsentPlan(plan), 'Move now? This backs up and changes agent settings, stops 1.4 and imports to the destinations above. Safe to stop and run again.');
  const execution = (ctx.deps.planCutover ?? planCutover)(ctx.home, { ...plan.options, dryRun: false }, deps, plan.plannedAt);
  if (planFingerprint(cutoverConsentPlan(execution)) !== planFingerprint(cutoverConsentPlan(plan))) throw new Error('The cutover plan changed after consent. Run myco setup --cutover again to review it.');
  const result = await (ctx.deps.runCutover ?? runCutover)(execution, deps);
  const after = legacyMigrationState(ctx.home, { homeDir: ctx.deps.legacyHomeDir, homes: ctx.deps.legacyHomes });
  if (!result.ok || after.state !== 'moved') throw new Error(`Myco 1.4 migration remains ${after.state}. Keep the 1.4 data; resolve the reported problems and run myco setup --cutover again to resume.${after.state === 'unavailable' ? ` ${after.detail}` : after.state === 'changed' ? ` ${after.warning}` : ''}`);
  const added = cutoverReconciliation(ctx.home)?.sessionsAdded ?? 0;
  ctx.legacySummary = `Moved to 2.0.${added > 0 ? ` 1.4 captured ${added} more session${added === 1 ? '' : 's'} before it stopped; they moved too.` : ''} 1.4 data kept at ${plan.vaults.map(vault => vault.vault).join(', ')}. Start a new agent session; an already-open session keeps its earlier Myco connection.`;
  ctx.out(ctx.legacySummary);
}
const signInTarget = (ctx: Context): SignInTarget => {
  if (!isCloudflare(ctx)) return { kind: 'local', paths: peekLocalPaths(ctx.home) };
  const record = peekDeploymentRecord(ctx.home);
  if (!record) throw new Error('No Cloudflare Deployment recorded; run myco setup again to create it.');
  return { kind: 'cloudflare', record, mycoHome: ctx.home };
};
async function signInOptions(ctx: Context): Promise<RegisterOptions> {
  const answers = chosen(ctx);
  const name = answers.appName ?? defaultAppName(answers.url);
  const owner = answers.org ?? 'your account';
  await consent(ctx, 'signin', { url: answers.url, owner, name }, `Register a GitHub sign-in app named ${JSON.stringify(name)}, owned by ${owner}?`);
  if (!ctx.yes && !hasPendingSignIn(signInTarget(ctx), answers.url) && await confirm(ctx.ask, 'Do you already have a GitHub sign-in app for this address?', '--yes to register a new app')) {
    const createFirst = isLocal(ctx) && fact(ctx, 'deployment.create')?.state !== 'complete' ? 'Run myco server create --target local first. ' : '';
    throw new Error(`${createFirst}Use myco server github-app --target ${answers.target} --url ${answers.url} --existing --client-id <id> --client-secret-stdin with its regenerated secret, then run myco setup again.`);
  }
  return {
    ...ctx.deps.github, url: answers.url, name, org: answers.org, runner: ctx.deps.cloudflare?.runner,
    fetchImpl: ctx.deps.github?.fetchImpl ?? ctx.deps.fetch, log: ctx.out, openUrl: async url => { await openUrl(ctx, url); },
    target: signInTarget(ctx),
  };
}

const CREATE_STEPS: readonly SetupStep[] = [
  {
    id: 'create.choice', requires: [], applies: isCreate,
    act: async ctx => {
      if (!ctx.file.answers.target) {
        const target = await askRequired(ctx.ask, 'Where should your Myco run? 1) Cloudflare 2) On this machine (only this machine can reach it)', '--create cloudflare or --create local');
        if (target !== '1' && target !== '2') throw new Error('Choose 1 or 2; pass --create cloudflare or --create local.');
        ctx.file.answers.target = target === '1' ? 'cloudflare' : 'local';
        saveSetupFile(ctx.home, ctx.file);
      }
    },
  },
  {
    id: 'cloudflare.account', requires: ['deployment.create'], applies: isCloudflare,
    act: async ctx => {
      const cwd = ensureCommandDir(ctx.home);
      const runner = ctx.deps.cloudflare?.runner ?? systemRunner();
      const readiness = { runner, cwd, report: ctx.out };
      try { await assertWranglerReady(readiness); }
      catch (error) {
        if (!(error instanceof WranglerNotSignedIn)) throw error;
        await consentToOccurrence(ctx, 'Sign in to Cloudflare (opens your browser, runs wrangler login)?');
        await runOrThrow(runner, 'npx', ['--no-install', 'wrangler', 'login'], { cwd, stdio: 'inherit', signal: ctx.deps.signal });
        await assertWranglerReady(readiness);
      }
      const answers = ctx.file.answers;
      answers.accountId ??= peekDeploymentRecord(ctx.home)?.accountId;
      if (!answers.accountId) {
        const accounts = await listAccounts(runner, ctx.home);
        if (accounts.length === 1) answers.accountId = accounts[0].id;
        else {
          accounts.forEach(account => ctx.out(`${account.name}: ${account.id}`));
          const id = await askRequired(ctx.ask, 'Which Cloudflare account id?', '--account-id <id>');
          if (!accounts.some(account => account.id === id)) throw new Error('Choose a listed Cloudflare account with --account-id <id>.');
          answers.accountId = id;
        }
      }
      saveSetupFile(ctx.home, ctx.file);
    },
  },
  {
    id: 'cloudflare.address', requires: ['deployment.create'], applies: isCloudflare,
    act: async ctx => {
      const answers = ctx.file.answers;
      const recorded = peekDeploymentRecord(ctx.home)?.url;
      if (recorded && answers.customUrl && recorded !== answers.customUrl) {
        delete answers.customUrl;
        delete answers.addressChoice;
        saveSetupFile(ctx.home, ctx.file);
        throw new Error(`This Deployment's address is ${recorded}; rerun myco setup without --url, or move it with myco server create --target cloudflare --account-id ${answers.accountId} --url <new>, then register sign-in again.`);
      }
      if (!answers.addressChoice) {
        if (recorded || ctx.yes) answers.addressChoice = 'workers.dev';
        else {
          const address = await askRequired(ctx.ask, 'Choose the address: 1) workers.dev 2) A custom domain on your Cloudflare account', '--url https://<host>, or --yes for workers.dev');
          if (address !== '1' && address !== '2') throw new Error('Choose 1 or 2; pass --url https://<host> for a custom domain.');
          answers.addressChoice = address === '1' ? 'workers.dev' : 'custom';
        }
      }
      if (answers.addressChoice === 'custom' && !answers.customUrl) {
        const value = await askRequired(ctx.ask, 'What is the custom domain URL?', '--url https://<host>');
        answers.customUrl = setupCloudflareUrl(value);
      }
      if (answers.customUrl) ctx.out('Changing the address later means registering sign-in again and signing every machine in again. Cloudflare zone security rules apply to this custom domain.');
      saveSetupFile(ctx.home, ctx.file);
    },
  },
  {
    id: 'cloudflare.create', requires: ['deployment.create'], applies: isCloudflare,
    act: async ctx => {
      if (fact(ctx, 'deployment.create')?.state !== 'complete') {
        const options = { ...hostedOptions(ctx), url: ctx.file.answers.customUrl };
        const plan = await (ctx.deps.planCloudflare ?? planCloudflareDeployment)(options);
        await consent(ctx, 'create', { accountId: plan.accountId, url: plan.url, steps: plan.steps.map(({ kind, name }) => ({ kind, name })) }, 'Create these Cloudflare resources and deploy your Myco?');
        await (ctx.deps.createCloudflare ?? createCloudflareDeployment)(options);
      }
      const record = peekDeploymentRecord(ctx.home);
      if (!record?.url) throw new Error(SETUP_CREATE_GUIDANCE.addressMissing);
      ctx.file.answers.url = new URL(record.url).origin;
      saveSetupFile(ctx.home, ctx.file);
    },
  },
  {
    id: 'cloudflare.signin', requires: ['deployment.create', 'deployment.health', 'deployment.signin'], applies: isCloudflare,
    act: async ctx => {
      if (fact(ctx, 'deployment.signin')?.state === 'complete' && !hasPendingSignIn(signInTarget(ctx), chosen(ctx).url)) return;
      const result = await (ctx.deps.registerApp ?? registerGitHubApp)(await signInOptions(ctx));
      if (!result.verified.ok) throw new Error(SETUP_CREATE_GUIDANCE.signInPending);
    },
  },
  {
    id: 'local.plan', requires: ['deployment.create', 'deployment.signin', 'deployment.owner'], applies: isLocal,
    act: async ctx => {
      if (fact(ctx, 'deployment.create')?.detail === 'behind') throw new Error(LOCAL_SCHEMA_BEHIND);
      const answers = ctx.file.answers;
      const paths = peekLocalPaths(ctx.home);
      const record = fs.existsSync(paths.recordFile) ? readLocalRecord(paths) : null;
      if (record && (record.origin || record.sourceFrom !== 'socket')) throw new Error(SETUP_CREATE_GUIDANCE.loopbackOnly);
      if (record && answers.port && answers.port !== record.port) throw new Error(`This Deployment uses port ${record.port}; run myco setup --port ${record.port}.`);
      if (!answers.port) {
        const question = `Only this machine can reach it. Port [${DEFAULT_LOCAL_PORT}]:`;
        const answer = record || ctx.yes ? null : await ctx.ask(`${question} `);
        if (!record && !ctx.yes && answer === null) throw new Error(`no terminal to ask "${question}"; pass --port <n>`);
        if (answer?.trim() && !/^\d+$/.test(answer.trim())) throw new Error('--port needs an integer from 1 to 65535');
        const port = record?.port ?? Number(answer?.trim() || DEFAULT_LOCAL_PORT);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port needs an integer from 1 to 65535');
        answers.port = port;
      }
      answers.url = `http://127.0.0.1:${answers.port}`;
      if (!answers.serve) {
        const serve = await askRequired(ctx.ask, 'How should it run? 1) Start whenever you log in 2) I’ll run it myself in another terminal', '--serve service|terminal');
        if (serve !== '1' && serve !== '2') throw new Error('Choose 1 or 2; pass --serve service|terminal.');
        answers.serve = serve === '1' ? 'service' : 'terminal';
      }
      saveSetupFile(ctx.home, ctx.file);
    },
  },
  {
    id: 'local.prepare', requires: ['deployment.create', 'deployment.signin', 'deployment.owner'], applies: isLocal,
    act: async ctx => {
      const answers = chosen(ctx);
      if (fact(ctx, 'deployment.create')?.state !== 'complete') await consent(ctx, 'create', { url: answers.url, port: answers.port!, home: ctx.home, action: 'Create local Deployment' }, 'Create your Myco on this machine?');
      const signin = fact(ctx, 'deployment.signin')?.state === 'complete' && !hasPendingSignIn(signInTarget(ctx), answers.url) ? 'skip' : await signInOptions(ctx);
      if (fact(ctx, 'deployment.owner')?.state !== 'complete') await consent(ctx, 'owner', { url: answers.url }, 'Next you become its owner. Open your private owner link? It works once and expires in 15 minutes.');
      if (answers.serve === 'service') {
        const deps = localDeps(ctx);
        const spec = localServiceSpec(ctx.home, deps);
        await consent(ctx, 'local.service', { unit: spec.unit.label, binary: spec.binaryPath, home: ctx.home, url: answers.url }, 'Install and start your Myco whenever you log in?');
      }
      const plan = localPlan(ctx, signin);
      if (fact(ctx, 'deployment.owner')?.detail === 'pending-link') plan.owner = 'skip';
      const result = await (ctx.deps.prepareLocal ?? prepareLocal)(ctx.home, plan, localDeps(ctx));
      ctx.ownerLink = result.ownerLink;
    },
  },
  {
    id: 'create.owner', requires: ['deployment.create', 'deployment.signin', 'deployment.owner'], applies: isCreate,
    act: async ctx => {
      if (fact(ctx, 'deployment.owner')?.state === 'complete') return;
      const url = chosen(ctx).url;
      await consent(ctx, 'owner', { url }, 'Open your private owner link? It works once and expires in 15 minutes.');
      const linked = () => isLocal(ctx) ? localOwnerLinked(peekLocalPaths(ctx.home), localDeps(ctx).native) : cloudflareOwnerLinked(hostedOptions(ctx));
      while (true) {
        if (await linked()) return;
        if (!ctx.ownerLink) {
          if (isLocal(ctx)) {
            if (!ctx.yes && !await confirm(ctx.ask, 'Make a fresh link? This stops your Myco for a moment.', '--yes')) throw new Error(SETUP_CREATE_GUIDANCE.ownerPending);
            ctx.ownerLink = (await (ctx.deps.recoverLocal ?? recoverLocalOwnerLink)(ctx.home, localPlan(ctx, 'skip'), localDeps(ctx))).ownerLink;
          } else ctx.ownerLink = await setupCloudflareOwner(hostedOptions(ctx));
        }
        if (!ctx.ownerLink) throw new Error(SETUP_CREATE_GUIDANCE.ownerMissing);
        ctx.out(`Owner link: ${ctx.ownerLink.url}\nExpires: ${new Date(ctx.ownerLink.expiresAt).toISOString()}; works once; keep it private.`);
        await openUrl(ctx, ctx.ownerLink.url);
        ctx.out('Waiting for you to confirm in the browser…');
        const state = await waitForOwnerLink(ctx.ownerLink.expiresAt, { linked, now: ctx.deps.now, sleep: ctx.deps.sleep, signal: ctx.deps.signal });
        if (state === 'linked') { ctx.out('Your GitHub account is linked as the owner.'); return; }
        ctx.ownerLink = null;
        if (!ctx.yes && !await confirm(ctx.ask, 'The owner link expired. Make a fresh link?', '--yes')) throw new Error(SETUP_CREATE_GUIDANCE.ownerExpired);
      }
    },
  },
];

const STEPS: readonly SetupStep[] = [
  ...CREATE_STEPS,
  {
    id: 'machine.signin', requires: ['deployment.health', 'deployment.signin', 'machine.signin', 'machine.credential'], applies: isMember,
    act: async (ctx) => {
      const answers = chosen(ctx);
      const credential = fact(ctx, 'machine.credential');
      if (fact(ctx, 'machine.signin')?.state === 'complete' && credential?.state !== 'incomplete') return;
      await consent(ctx, 'device', { url: answers.url, action: 'Sign this machine in' }, 'Sign this machine in through device approval?', ctx.explicitJoin || ctx.yes);
      ctx.out(SIGN_IN_WAIT);
      const ok = await (ctx.deps.login ?? login)([ctx.deps.loginAddress ?? answers.url], {
        ...ctx.deps.loginDeps, mycoHome: ctx.home, cwd: answers.root, fetch: ctx.deps.fetch, provision: 'defer',
        stdout: ctx.out, stderr: ctx.deps.stderr, now: ctx.deps.now, sleep: ctx.deps.sleep,
      });
      if (!ok) throw new Error('Sign-in did not finish; run myco setup again to resume.');
    },
  },
  {
    id: 'default', requires: ['default'], applies: isMember,
    act: async (ctx) => {
      const answers = chosen(ctx);
      const previous = readDefaultDeployment(ctx.home, { strict: true });
      if (!previous || previous.serverUrl === answers.url) return;
      ctx.out('On a machine with two Deployments, Myco tools may still point to the other Deployment until per-project MCP routing is available (#1724).');
      const plan = { from: previous.serverUrl, to: answers.url };
      if (answers.makeDefault === undefined) {
        ctx.file.answers.makeDefault = await confirm(ctx.ask, `Should new repositories join ${answers.url} instead of ${previous.serverUrl}?`, '--default or --keep-default');
        if (ctx.file.answers.makeDefault) ctx.file.consented.default = planFingerprint(plan);
        saveSetupFile(ctx.home, ctx.file);
      }
      if (ctx.file.answers.makeDefault) {
        await consent(ctx, 'default', plan, 'Change the Default Deployment for new repositories?', ctx.explicitDefault);
        recordDefaultDeployment(answers.url, { mycoHome: ctx.home, replace: true });
      }
    },
  },
  {
    id: 'legacy', requires: ['legacy', 'machine.signin', 'machine.credential'], applies: isMember,
    act: conductLegacy,
  },
  {
    id: 'machine.agents', requires: ['machine.signin', 'machine.agents'], applies: isMember,
    act: async (ctx) => {
      const answers = chosen(ctx);
      if (answers.noAgents) { recordNoAgents(ctx.home, answers.url); return; }
      const result = provisionDetectedAgents(ctx.home, answers.url, answers.root ?? null, { agents: ctx.deps.agents, packageRoot: ctx.deps.packageRoot, preserveOtherMemberTools: true });
      detectedProvisionLines(result).forEach(ctx.out);
      if (result.skipped.length > 0) throw new Error('Some agents could not be set up; resolve the reported ownership, then run myco setup again.');
    },
  },
  {
    id: 'project', requires: ['deployment.health', 'machine.signin', 'machine.credential', 'project'], applies: isMember,
    act: async (ctx) => {
      if (isCreate(ctx) && !ctx.file.answers.root) return;
      if (fact(ctx, 'project')?.state === 'complete') {
        if (ctx.newProjectChanged) throw new Error('This repository already has a Project. Choose another --root for --new, or use myco member join to change its connection.');
        if (!ctx.explicitProject) return;
      }
      const answers = chosen(ctx);
      if (fact(ctx, 'project')?.detail.startsWith('bound-elsewhere')) throw new Error(`This repository is ${fact(ctx, 'project')!.detail}. Its binding was kept; choose another --root.`);
      const args = [answers.url, '--no-worker', '--no-agents', '--root', answers.root!];
      if (answers.project) args.push('--project', answers.project);
      if (answers.newProject !== undefined) args.push('--new', ...(answers.newProject === true ? [] : [answers.newProject]));
      const entry = await (ctx.deps.join ?? runJoin)(args, {
        ...ctx.deps.memberDeps, mycoHome: ctx.home, cwd: answers.root, fetch: ctx.deps.fetch, ask: ctx.ask,
        stdout: ctx.out, stderr: ctx.deps.stderr, now: ctx.deps.now,
      });
      if (entry === null) throw new Error('Project connection did not finish; run myco setup --project <id|name> or myco setup --new [name] to resume.');
    },
  },
  {
    id: 'machine.backlog', requires: [], applies: isMember,
    act: async (ctx) => {
      const entries = listRegistryEntriesResult(ctx.home);
      if (!entries.readable || entries.unavailableEntries > 0) {
        ctx.out('Warning: some repository bindings could not be read. Inspect them and run myco member drain to retry capture delivery.');
      }
      try {
        await runDrain(['--all'], { ...ctx.deps.memberDeps, mycoHome: ctx.home, fetch: ctx.deps.fetch, now: ctx.deps.now,
          stdout: ctx.out, stderr: ctx.deps.stderr, signInCapture: { serverUrl: chosen(ctx).url } });
      } catch (error) {
        ctx.out(`Warning: capture delivery could not finish: ${error instanceof Error ? error.message : String(error)}. Run myco member drain to retry.`);
      }
    },
  },
  {
    id: 'runner.choice', requires: [], applies: isMember,
    act: async (ctx) => {
      if (ctx.file.answers.runWork !== undefined) return;
      if (isLocal(ctx)) {
        const answer = await askRequired(ctx.ask, 'Your Myco does no agent work by itself. Make this machine its runner? [y/n]', '--run-work or --no-runner');
        if (!/^(y|yes|n|no)$/i.test(answer)) throw new Error('Answer yes or no; pass --run-work or --no-runner.');
        ctx.file.answers.runWork = /^(y|yes)$/i.test(answer);
      } else ctx.file.answers.runWork = await confirm(ctx.ask, 'Make this machine a runner?', '--run-work or --no-runner');
      saveSetupFile(ctx.home, ctx.file);
    },
  },
  {
    id: 'runner.preview', requires: [], applies: isRunner,
    act: async (ctx) => {
      const deps = runnerDeps(ctx);
      const preview = await preflightRunnerService(executorServiceTarget(chosen(ctx).url, deps, 'runner'), (deps.harnessDirs ?? harnessDirectories)(), deps);
      ctx.out('Coding agents this runner would offer (preview; confirmed after it starts):');
      if (preview) for (const harness of preview.harnesses) ctx.out(`  ${harness.id}: ${!harness.installed ? 'not installed' : !harness.authenticated ? 'not signed in' : 'signed in'}`);
      if (preview && !preview.codex.ok) ctx.out(`  Codex: ${preview.codex.directory}: ${preview.codex.rule}`);
    },
  },
  {
    id: 'runner.enrollment', requires: ['deployment.health', 'runner.enrollment'], applies: isRunner,
    act: async (ctx) => {
      if (fact(ctx, 'runner.enrollment')?.state === 'complete') return;
      const answers = chosen(ctx);
      const name = answers.runnerName ?? defaultRunnerName(hostname());
      await consent(ctx, 'runner', { url: answers.url, name }, 'Run Myco’s work here and register this runner?');
      if (!await (ctx.deps.register ?? registerRunner)([answers.url, '--name', name], runnerDeps(ctx))) throw new Error('Runner enrollment did not finish; run myco setup again to resume.');
    },
  },
  {
    id: 'runner.authority', requires: ['deployment.health', 'runner.enrollment'], applies: isRunner,
    act: async (ctx) => {
      const answer = await runnerServiceContact(chosen(ctx).url, { ...runnerDeps(ctx), renew: false });
      const runner = answer.class === 'acked' ? answer.body.runner : null;
      const state = runner !== null && typeof runner === 'object' ? Reflect.get(runner, 'state') : undefined;
      if (state !== 'enabled') throw new Error(`Runner authority is ${typeof state === 'string' ? state : answer.class}; resume it on the dashboard’s Runners page, or use myco runner register ${chosen(ctx).url} --replace to replace removed access with explicit approval.`);
      const legacy = await legacyWorkerInventory(runnerDeps(ctx));
      if (legacy.length > 0) throw new Error(`This machine runs Myco’s work the older way. Let it become idle (see the dashboard’s Runners page), then retire it:\n${legacy.join('\n')}\nRun myco setup again. No service was changed.`);
    },
  },
  {
    id: 'runner.service', requires: ['runner.enrollment', 'runner.service'], applies: isRunner,
    act: async (ctx) => {
      if (ctx.file.answers.runnerService === undefined) {
        ctx.file.answers.runnerService = await confirm(ctx.ask, 'Start the runner whenever you log in?', '--runner-service install|skip', true) ? 'install' : 'skip';
        saveSetupFile(ctx.home, ctx.file);
      }
      if (ctx.file.answers.runnerService === 'skip') { ctx.out(`Runner service declined. Start it when ready: myco runner run --server ${chosen(ctx).url}`); return; }
      const deps = runnerDeps(ctx);
      const url = chosen(ctx).url;
      const target = executorServiceTarget(url, deps, 'runner');
      const plan = { unit: workerServiceSpecForConsent(target), binary: target.binaryPath, home: target.mycoHome, url };
      await consent(ctx, 'service', plan, 'Install and start this runner service?');
      const before = workerServiceStatus(target, { runner: deps.runner, lockDir: deps.lockDir });
      const unitFile = servicePaths(workerServiceSpec(target, []), target.platform).unitFile;
      let startedAt = Math.max(before.installed ? fs.statSync(unitFile).mtimeMs : Infinity,
        before.serving && before.serving.startedAt > 0 ? before.serving.startedAt * 1000 : (ctx.deps.now ?? Date.now)());
      if (!before.running || !before.loaded || !before.installed) {
        startedAt = (ctx.deps.now ?? Date.now)();
        if (!await (ctx.deps.service ?? runRunnerService)('install', ['--server', url], deps)) throw new Error('Runner enrollment is kept; fix the service failure, then run myco setup again.');
      }
      ctx.out('Waiting for the runner’s first check-in…');
      const deadline = (ctx.deps.now ?? Date.now)() + OFFER_WAIT_MS;
      while (true) {
        ctx.deps.signal?.throwIfAborted();
        const offer = readRunnerRecord(url, ctx.home)?.lastOffer;
        if (offer && offer.observedAt >= startedAt && offer.offered.length > 0) {
          ctx.out(`Runner offering ${offer.offered.join(', ')} (checked ${new Date(offer.observedAt).toISOString()}).`);
          return;
        }
        if ((ctx.deps.now ?? Date.now)() >= deadline) throw new Error(`No current runner offer; check myco runner status --server ${url} and the dashboard’s Runners page. On Linux, loginctl enable-linger <user> keeps a user service available after logout.`);
        await (ctx.deps.sleep ?? delay)(OFFER_POLL_MS);
      }
    },
  },
];

const workerServiceSpecForConsent = (target: ReturnType<typeof executorServiceTarget>) => workerServiceUnit(target.serverUrl, target.mycoHome, 'runner').label;

export async function conductSetup(home: string, file: SetupFile, deps: SetupDeps, options: { yes: boolean; explicitJoin: boolean; explicitLegacyPlacement: boolean; explicitDefault: boolean; explicitProject: boolean; newProjectChanged: boolean }): Promise<void> {
  deps = { ...deps, legacyHomeDir: deps.legacyHomeDir ?? deps.cutoverDeps?.env?.HOME, legacyObserver: deps.legacyObserver ?? legacyConfirmationObserver() };
  let capture: Observation[] = [];
  const ctx: Context = {
    home, file, deps, ...options, ask: deps.ask ?? askOnTerminal, facts: [],
    out: deps.stdout ?? console.log,
  };
  const observe = async (includeCapture = false) => {
    deps.signal?.throwIfAborted();
    const legacy = await observeSetup(home, {}, deps);
    const failure = legacy.find((entry) => entry.id === 'legacy' && entry.state !== 'complete');
    if (failure?.state === 'unavailable') throw new Error(`Legacy migration state unavailable: ${failure.detail}`);
    if (failure && file.answers.role === 'runner') throw new Error('Myco 1.4 migration is pending. Run `myco setup --join <address> --cutover` first, or use `myco cutover --dry-run`. No legacy binary was executed.');
    ctx.facts = legacy;
    const observed = await observeSetup(home, file.answers, { ...deps, ...(isCloudflare(ctx) ? { cloudflare: hostedOptions(ctx) } : {}), checkRemote: true, includeCapture });
    if (includeCapture) {
      capture = observed.filter((entry) => entry.id.startsWith('machine.') && entry.informational);
      for (const entry of capture.filter((entry) => entry.state !== 'complete')) ctx.out(`Warning: ${entry.id} (${entry.scope}): ${entry.detail}`);
    }
    ctx.facts = [...observed.filter((entry) => !capture.includes(entry)), ...capture];
  };
  for (const step of STEPS) {
    if (!step.applies(ctx)) continue;
    await observe(step.id === 'machine.backlog');
    const unavailable = ctx.facts.find((entry) => entry.state === 'unavailable' && step.requires.includes(entry.id));
    if (unavailable) throw new Error(`${unavailable.id} (${unavailable.scope}) unavailable: ${unavailable.detail.replace(/\.$/, '')}. Restore access, then run myco setup again.`);
    await step.act(ctx);
  }
  await observe();
  const remaining = ctx.facts.find((entry) => !entry.informational && entry.state !== 'complete');
  if (remaining) throw new Error(`${remaining.id} remains ${remaining.state}: ${remaining.detail}. Run myco setup again to resume.`);
  const answers = chosen(ctx);
  const project = fact(ctx, 'project');
  const projectUrl = project?.detail.startsWith('bound-cutover: ') ? project.detail.slice('bound-cutover: '.length) : answers.url;
  const summary = isMember(ctx)
    ? answers.root ? `Setup connected ${path.resolve(answers.root)} to ${projectUrl}. Start a session in your agent here, then open ${projectUrl}.`
      : `Your Myco is ready at ${answers.url}, and this machine is signed in. Next, run myco setup --join ${answers.url} from a git repository to connect a project.`
    : `Runner setup for ${answers.url}. Review this machine on ${answers.url}/runners.`;
  ctx.out(summary);
}
