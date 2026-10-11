import { hostname } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SIGN_IN_WAIT } from '@goondocks/myco-shared/setup-guidance';
import { run as login, type LoginDeps } from '@myco/cli/login.js';
import { runJoin, runDrain, provisionDetectedAgents, detectedProvisionLines, recordNoAgents, type MemberCliDeps } from '@myco/cli/member.js';
import { registerRunner } from '@myco/cli/runner-register.js';
import { defaultRunnerName } from '@myco/cli/runner-deps.js';
import { legacyWorkerInventory, preflightRunnerService, runRunnerService, type RunnerServiceDeps } from '@myco/cli/runner-service.js';
import { executorServiceTarget } from '@myco/cli/worker-service.js';
import { harnessDirectories, workerServiceStatus, workerServiceUnit, workerServiceSpec } from '@myco/runner/service.js';
import { servicePaths } from '@myco/server/service.js';
import { readRunnerRecord } from '@myco/runner/runner-registry.js';
import { readDefaultDeployment, recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { deploymentUrl, listRegistryEntriesResult } from '@myco/member/registry.js';
import { canonicalPlan, planFingerprint, saveSetupFile, type SetupFile, type SetupPlan } from '@myco/setup/answers.js';
import { observeSetup, type Observation, type ObserveDeps } from '@myco/setup/observe.js';
import { askOnTerminal, confirm, type Ask } from '@myco/setup/prompt.js';

const OFFER_WAIT_MS = 2 * 60_000;
const OFFER_POLL_MS = 1000;

export interface SetupDeps extends ObserveDeps {
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
  explicitDefault: boolean;
  explicitProject: boolean;
  newProjectChanged: boolean;
  ask: Ask;
  out: (line: string) => void;
  facts: Observation[];
  verified: Set<string>;
}
interface SetupStep {
  id: string;
  applies: (ctx: Context) => boolean;
  act: (ctx: Context) => Promise<void>;
}

const chosen = (ctx: Context) => {
  const { url, role } = ctx.file.answers;
  if (!url || !role) throw new Error('Choose --join <address> or --runner <address>.');
  return { ...ctx.file.answers, url, role };
};
const fact = (ctx: Context, id: string) => ctx.facts.find((value) => value.id === id);
const isMember = (ctx: Context) => chosen(ctx).role === 'join';
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
    && !await confirm(input.ask, 'Approve this plan?', 'an interactive terminal (changed plans require fresh consent)')) {
    throw new Error('Plan declined; run myco setup again when ready.');
  }
  input.file.consented[input.id] = fingerprint;
  saveSetupFile(input.home, input.file);
}
const consent = (ctx: Context, id: string, plan: SetupPlan, question: string, yes = ctx.yes) =>
  consentToPlan({ ...ctx, id, plan, question, yes });

const STEPS: readonly SetupStep[] = [
  {
    id: 'machine.signin', applies: isMember,
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
    id: 'default', applies: isMember,
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
    id: 'machine.agents', applies: isMember,
    act: async (ctx) => {
      const answers = chosen(ctx);
      if (answers.noAgents) { recordNoAgents(ctx.home, answers.url); return; }
      if (fact(ctx, 'machine.agents')?.state === 'complete') return;
      const result = provisionDetectedAgents(ctx.home, answers.url, answers.root ?? null, { agents: ctx.deps.agents, packageRoot: ctx.deps.packageRoot });
      detectedProvisionLines(result).forEach(ctx.out);
      if (result.skipped.length > 0) throw new Error('Some agents could not be set up; resolve the reported ownership, then run myco setup again.');
    },
  },
  {
    id: 'project', applies: isMember,
    act: async (ctx) => {
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
      if (entry === null) throw new Error('Project connection did not finish; run myco setup with --project <id|name> or --new [name].');
    },
  },
  {
    id: 'machine.backlog', applies: isMember,
    act: async (ctx) => {
      const entries = listRegistryEntriesResult(ctx.home);
      if (!entries.readable || entries.unavailableEntries > 0) throw new Error('Repository bindings could not all be read; inspect them before running myco setup again.');
      for (const entry of entries.entries.filter((entry) => deploymentUrl(entry.serverUrl) === chosen(ctx).url)) {
        const results = await runDrain([], { ...ctx.deps.memberDeps, mycoHome: ctx.home, cwd: entry.root, fetch: ctx.deps.fetch, stdout: ctx.out, stderr: ctx.deps.stderr });
        if (results.some((result) => result.endedBy !== 'drained')) ctx.out('Some capture is still waiting; myco member drain retries it.');
      }
    },
  },
  {
    id: 'runner.choice', applies: isMember,
    act: async (ctx) => {
      if (ctx.file.answers.runWork !== undefined) return;
      ctx.file.answers.runWork = await confirm(ctx.ask, 'Make this machine a runner?', '--run-work or --no-runner');
      saveSetupFile(ctx.home, ctx.file);
    },
  },
  {
    id: 'runner.preview', applies: isRunner,
    act: async (ctx) => {
      const deps = runnerDeps(ctx);
      const preview = await preflightRunnerService(executorServiceTarget(chosen(ctx).url, deps, 'runner'), (deps.harnessDirs ?? harnessDirectories)(), deps);
      ctx.out('Coding agents this runner would offer (preview; confirmed after it starts):');
      if (preview) for (const harness of preview.harnesses) ctx.out(`  ${harness.id}: ${!harness.installed ? 'not installed' : !harness.authenticated ? 'not signed in' : 'signed in'}`);
      if (preview && !preview.codex.ok) ctx.out(`  Codex: ${preview.codex.directory}: ${preview.codex.rule}`);
    },
  },
  {
    id: 'runner.enrollment', applies: isRunner,
    act: async (ctx) => {
      if (fact(ctx, 'runner.enrollment')?.state === 'complete') return;
      const answers = chosen(ctx);
      const name = answers.runnerName ?? defaultRunnerName(hostname());
      await consent(ctx, 'runner', { url: answers.url, name }, 'Run Myco’s work here and register this runner?');
      if (!await (ctx.deps.register ?? registerRunner)([answers.url, '--name', name], runnerDeps(ctx))) throw new Error('Runner enrollment did not finish; run myco setup again to resume.');
    },
  },
  {
    id: 'runner.authority', applies: isRunner,
    act: async (ctx) => {
      const authority = fact(ctx, 'runner.authority');
      if (authority && authority.state !== 'complete') throw new Error(`Runner authority is ${authority.detail}; resume it on the dashboard’s Runners page, or use myco runner register ${chosen(ctx).url} --replace to replace removed access with explicit approval.`);
      const legacy = await legacyWorkerInventory(runnerDeps(ctx));
      if (legacy.length > 0) throw new Error(`This machine runs Myco’s work the older way. Let it become idle (see the dashboard’s Runners page), then retire it:\n${legacy.join('\n')}\nRun myco setup again. No service was changed.`);
    },
  },
  {
    id: 'runner.service', applies: isRunner,
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
          ctx.verified.add('runner.service');
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

export async function conductSetup(home: string, file: SetupFile, deps: SetupDeps, options: { yes: boolean; explicitJoin: boolean; explicitDefault: boolean; explicitProject: boolean; newProjectChanged: boolean }): Promise<void> {
  const ctx: Context = { home, file, deps, ...options, ask: deps.ask ?? askOnTerminal, out: deps.stdout ?? console.log, facts: [], verified: new Set() };
  const observe = async () => {
    deps.signal?.throwIfAborted();
    const legacy = await observeSetup(home, {}, deps);
    const failure = legacy.find((entry) => entry.id === 'legacy' && entry.state !== 'complete');
    if (failure?.state === 'unavailable') throw new Error(`Legacy migration state unavailable: ${failure.detail}`);
    if (failure) throw new Error('Myco 1.4 migration is pending. Guided migration is not available here yet; run myco cutover --dry-run to review the existing migration workflow. No legacy binary was executed.');
    ctx.facts = await observeSetup(home, file.answers, { ...deps, checkRemote: true });
    const unavailable = ctx.facts.find((entry) => entry.state === 'unavailable');
    if (unavailable) throw new Error(`${unavailable.id} (${unavailable.scope}) unavailable: ${unavailable.detail}. Restore access, then run myco setup again.`);
  };
  for (const step of STEPS) {
    await observe();
    if (step.applies(ctx)) await step.act(ctx);
  }
  await observe();
  const remaining = ctx.facts.find((entry) => !entry.informational && entry.state !== 'complete' && !ctx.verified.has(entry.id));
  if (remaining) throw new Error(`${remaining.id} remains ${remaining.state}: ${remaining.detail}. Run myco setup again to resume.`);
  const answers = chosen(ctx);
  ctx.out(answers.role === 'join'
    ? `Setup connected ${path.resolve(answers.root!)} to ${answers.url}. Start a session in your agent here, then open ${answers.url}.`
    : `Runner setup for ${answers.url}. Review this machine on ${answers.url}/runners.`);
}
