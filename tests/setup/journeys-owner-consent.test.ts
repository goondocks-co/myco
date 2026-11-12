import { renderSetupStatus } from '@myco/cli/setup-status.js';
import { rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';
import { run, parseSetupOptions } from '@myco/cli/setup.js';
import { run as login } from '@myco/cli/login.js';
import { runRunnerService } from '@myco/cli/runner-service.js';
import { executorServiceTarget } from '@myco/cli/worker-service.js';
import { homeReport } from '@myco/cli/member-doctor.js';
import { consentToPlan, cutoverConsentPlan, type SetupDeps } from '@myco/setup/steps.js';
import { observeSetup, setupExitCode } from '@myco/setup/observe.js';
import { planFingerprint, readSetupFile, saveSetupFile, setupFilePath } from '@myco/setup/answers.js';
import { readDeploymentMembership, readRegistryEntry, writeDeploymentMembership, writeRegistryEntry, registryEntryPath, deploymentPath, deploymentKeyFor, machineSettingsPath } from '@myco/member/registry.js';
import { legacyMigrationState, type LegacyMigrationState } from '@myco/member/legacy-migration.js';
import { legacyVaultStamp } from '@myco/member/legacy-sources.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { MemberSpool } from '@myco/member/spool.js';
import { LegacyLedger } from '@myco/member/legacy-ledger.js';
import { observeLegacyStrayHistory } from '@myco/member/legacy-strays.js';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { bufferLockPath, sessionStatePath, updateSessionState } from '@myco/member/session-state.js';
import { installWorkerService } from '@myco/runner/service.js';
import { workerLockPath } from '@myco/runner/instance.js';
import { recordDefaultDeployment, readDefaultDeployment } from '@myco/member/default-deployment.js';
import { readRunnerRecord, recordRunnerContact, runnerRecordPath } from '@myco/runner/runner-registry.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { recordingPlatform } from '../helpers/fake-service-manager.js';
import { enrolledBeforeInstall } from './fixtures/interrupted-state.js';
import { legacyFixtureHome } from './fixtures/legacy-home.js';
import { fakeGitHub, SETUP_APP } from './fixtures/github.js';
import { createBunHandler, type BunHandler } from '@myco-server-worker/entry/bun.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { seededSqlite } from '../myco-server/helpers/d1.js';
import { SESSION_SECRET } from '../myco-server/helpers/owner.js';
import { OAUTH_STATE_COOKIE } from '@myco-server-worker/auth/owner/github.js';
import { SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { ownerDeployment, ACCOUNT, HOSTED_URL } from './fixtures/owner-deployment.js';
import { createCloudflareDeployment, planCloudflareDeployment } from '@myco/server/cloudflare-lifecycle.js';
import { prepareLocal } from '@myco/server/local-lifecycle.js';
import { registerGitHubApp, convertManifestCode, writeSignInPending, signInPendingPath } from '@myco/server/github-app.js';
import { peekDeploymentRecord, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { peekLocalPaths, readLocalSecrets, createLocalDeployment, DEFAULT_LOCAL_RECORD } from '@myco/server/local.js';
import { runJoin } from '@myco/cli/member.js';
import { cloudflareOwnerLinked } from '@myco/server/cloudflare-owner.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { legacyJourney, LEGACY_URLS } from './fixtures/legacy-journey.js';
import { planCutover, runCutover, run as cutoverRun } from '@myco/cli/cutover.js';
import { readCutoverState } from '@myco/member/legacy-migration.js';
import { legacyHistoryCompletionGroups, readLegacyVault } from '@myco/member/legacy-import.js';
import { URL, fakeFetch, freshJourney, snapshot, holdRunnerLock as bindRunnerLock } from './fixtures/journey-harness.js';

let root: string;
let home: string;
let project: string;
let lines: string[];
let errors: string[];
const closers: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  ({ root, home, project, lines, errors } = freshJourney());
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});
const base = (): SetupDeps => ({ mycoHome: home, cwd: project, ask: async () => null, agents: () => [], stdout: line => lines.push(line), stderr: line => errors.push(line) });
function holdRunnerLock(lockDir: string): void {
  bindRunnerLock(closers, lockDir);
}

describe('new owner journeys (a) and (b)', () => {
  it('offers the custom domain before registration, selects the one account and asks before Cloudflare login', async () => {
    const address = 'https://myco.custom.invalid';
    const server = ownerDeployment(root, home, 'cloudflare', address);
    closers.push(server.close);
    server.signOutWrangler();
    const questions: string[] = [];
    const deps: SetupDeps = { ...base(), ...server.deps, sleep: async () => {}, ask: async question => {
      questions.push(question);
      if (question.includes('already have')) return 'no';
      if (question.startsWith('Choose the address')) return '2';
      if (question.startsWith('What is the custom domain')) return address;
      return 'yes';
    } };
    expect(await run(['--create', 'cloudflare', '--new', 'Custom', '--no-agents', '--no-runner'], deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(questions.findIndex(question => question.startsWith('Choose the address'))).toBeLessThan(questions.findIndex(question => question.startsWith('Do you already have')));
    expect(lines.join('\n')).toContain('Cloudflare zone security rules');
    expect(lines.join('\n')).toContain('Myco (myco.custom.invalid)');
    expect(server.commands.filter(command => command === 'login')).toHaveLength(1);
    expect(readSetupFile(home).answers.accountId).toBe(ACCOUNT);
    expect(peekDeploymentRecord(home)?.url).toBe(address);
  });

  it('requires creation consent despite saved answers, and re-asks for a changed app plan even with --yes', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const file = readSetupFile(home);
    saveSetupFile(home, { ...file, answers: { role: 'create', target: 'cloudflare', accountId: ACCOUNT, addressChoice: 'workers.dev', runWork: false, noAgents: true } });
    expect(await run([], { ...base(), ...server.deps })).toBe(2);
    expect(errors.at(-1)).toContain('pass --yes');
    expect(server.commands.filter(command => command.startsWith('d1 create'))).toEqual([]);
    let calls = 0;
    const deps: SetupDeps = { ...base(), ...server.deps, registerApp: async () => { calls++; throw new Error('registration interrupted'); } };
    expect(await run(['--yes', '--app-name', 'First app'], deps)).toBe(2);
    expect(calls).toBe(1);
    expect(await run(['--yes', '--app-name', 'Changed app'], deps)).toBe(2);
    expect(calls).toBe(1);
    expect(errors.at(-1)).toContain('changed plans require fresh consent');
    expect(lines.join('\n')).toContain('This plan changed; its previous consent no longer applies.');
  });

  for (const [flags, refusal] of [
    [[], 'Choose 1, 2 or 3; run myco setup --help for the available choices.'],
    [['--create', 'local', '--port', '8787'], 'Choose 1 or 2; pass --serve service|terminal.'],
    [['--create', 'cloudflare', '--account-id', ACCOUNT], 'Choose 1 or 2; pass --url https://<host> for a custom domain.'],
  ] as const) it(`pins invalid prompted choice ${flags.join(' ') || 'role'}`, async () => {
    const server = ownerDeployment(root, home, flags.some(flag => flag === 'local') ? 'local' : 'cloudflare');
    closers.push(server.close);
    expect(await run([...flags], { ...base(), ...server.deps, ask: async () => 'invalid' })).toBe(2);
    expect(errors.at(-1)).toBe(`myco setup: ${refusal}`);
  });

  it('pins an invalid hosting target choice', async () => {
    expect(await run([], { ...base(), ask: async question => question.startsWith('What should') ? '1' : 'invalid' })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: Choose 1 or 2; pass --create cloudflare or --create local.');
  });

  it('pins an account choice outside the listed Cloudflare accounts', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const runner = { run: async (...args: Parameters<typeof server.runner.run>) => {
      const result = await server.runner.run(...args);
      return args[1].includes('whoami') ? { ...result, stdout: `${result.stdout}\n│ Other │ ${'b'.repeat(32)} │` } : result;
    } };
    expect(await run(['--create', 'cloudflare'], { ...base(), ...server.deps, cloudflare: { ...server.deps.cloudflare, runner }, ask: async () => 'c'.repeat(32) })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: Choose a listed Cloudflare account with --account-id <id>.');
    expect(server.commands.some(command => command.startsWith('d1 create'))).toBe(false);
  });

  it('pins malformed Cloudflare records before any provider command', async () => {
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: '', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: 'then' }, home);
    expect(await run(['--create', 'cloudflare', '--yes'], base())).toBe(2);
    expect(errors.at(-1)).toBe(`myco setup: deployment.create (${home}) unavailable: Cloudflare record is malformed; restore it before running myco setup again. Restore access, then run myco setup again.`);
  });

  it('pins unavailable Cloudflare owner state before requesting credentials', async () => {
    await expect(cloudflareOwnerLinked({ accountId: ACCOUNT, mycoHome: home })).rejects.toThrow('Cloudflare owner state unavailable; check myco server status --target cloudflare for the selected account.');
  });

  it('pins the address move recovery without replacing sign-in', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    await createCloudflareDeployment({ ...server.deps.cloudflare, mycoHome: home, accountId: ACCOUNT });
    const before = peekDeploymentRecord(home);
    const deps = { ...base(), ...server.deps, sleep: async () => {} };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--url', 'https://new.invalid', '--yes', '--new', 'Kept address', '--no-agents', '--no-runner'], deps)).toBe(2);
    expect(errors.at(-1)).toBe(`myco setup: This Deployment's address is ${HOSTED_URL}; rerun myco setup without --url, or move it with myco server create --target cloudflare --account-id ${ACCOUNT} --url <new>, then register sign-in again.`);
    expect(peekDeploymentRecord(home)).toEqual(before);
    expect(server.github.calls).toHaveLength(0);
    expect(readSetupFile(home).answers.customUrl).toBeUndefined();
    expect(await run(['--yes'], deps)).toBe(0);
    expect(peekDeploymentRecord(home)?.url).toBe(HOSTED_URL);
    expect(server.commands.filter(command => command.startsWith('deploy '))).toHaveLength(1);
  });

  it('refuses a behind native schema before creation consent', async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    const paths = peekLocalPaths(home);
    createLocalDeployment(DEFAULT_LOCAL_RECORD, { library: null, vec0: null }, paths);
    const db = new Database(paths.databasePath);
    try { db.query("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(SERVER_SCHEMA_VERSION - 1)); } finally { db.close(); }
    const before = snapshot(paths.root);
    expect(await run(['--create', 'local', '--serve', 'service', '--yes'], { ...base(), ...server.deps })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: native Deployment data needs update; run myco server update --target local before setup');
    expect(lines.join('\n')).not.toContain('Create your Myco on this machine?');
    expect(snapshot(paths.root)).toEqual(before);
  });

  it('refuses incompatible prompted choices before saving them', async () => {
    expect(await run(['--port', '8787'], { ...base(), ask: async () => '2' })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: Creation options require --create cloudflare or --create local.');
    expect(fs.existsSync(setupFilePath(home))).toBe(false);
    expect(readSetupFile(home).answers).toEqual({});
  });

  it('accepts Enter for the advertised native port default', async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    const deps = { ...base(), ...server.deps, sleep: async () => {}, ask: async (question: string) => question.startsWith('Only this machine can reach it.') ? '' : question.includes('already have') ? 'no' : 'yes' };
    expect(await run(['--create', 'local', '--serve', 'service', '--new', 'Default port', '--no-agents', '--no-runner'], deps)).toBe(0);
    expect(readSetupFile(home).answers.port).toBe(8787);
    expect(errors).toEqual([]);
  });

  it('names --port when the native port question has no terminal', async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    expect(await run(['--create', 'local', '--serve', 'service'], { ...base(), ...server.deps })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: no terminal to ask "Only this machine can reach it. Port [8787]:"; pass --port <n>');
    expect(fs.existsSync(peekLocalPaths(home).databasePath)).toBe(false);
  });

  for (const answer of ['', 'maybe']) it(`local runner choice refuses ${JSON.stringify(answer)} with no default`, async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    const deps = { ...base(), ...server.deps, sleep: async () => {}, ask: async () => answer };
    expect(await run(['--create', 'local', '--serve', 'service', '--yes', '--new', 'Local', '--no-agents'], deps)).toBe(2);
    expect(errors.at(-1)).toBe(answer === '' ? 'myco setup: an answer is required; pass --run-work or --no-runner' : 'myco setup: Answer yes or no; pass --run-work or --no-runner.');
    expect(readSetupFile(home).answers.runWork).toBeUndefined();
    expect(await run(['--no-runner'], deps)).toBe(0);
  });

  for (const target of ['cloudflare', 'local'] as const) it(`offers an existing GitHub app recovery command for ${target}`, async () => {
    const address = target === 'local' ? 'http://127.0.0.1:8787' : HOSTED_URL;
    const server = ownerDeployment(root, home, target, address);
    closers.push(server.close);
    const deps = { ...base(), ...server.deps, ask: async () => 'yes' };
    expect(await run(['--create', target, ...(target === 'local' ? ['--port', '8787', '--serve', 'service'] : ['--account-id', ACCOUNT, '--url', HOSTED_URL]), '--no-agents', '--no-runner'], deps)).toBe(2);
    expect(errors.at(-1)).toBe(`myco setup: ${target === 'local' ? 'Run myco server create --target local first. ' : ''}Use myco server github-app --target ${target} --url ${address} --existing --client-id <id> --client-secret-stdin with its regenerated secret, then run myco setup again.`);
    expect(server.github.calls).toHaveLength(0);
  });

  it('requires fresh consent for a changed URL after partial creation with --yes and no TTY', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    let interrupted = false;
    const runner = { run: async (...args: Parameters<typeof server.runner.run>) => {
      if (!interrupted && args[1].includes('deploy')) { interrupted = true; throw new Error('interrupted before deploy'); }
      return server.runner.run(...args);
    } };
    const deps = { ...base(), ...server.deps, cloudflare: { ...server.deps.cloudflare, runner } };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes'], deps)).toBe(2);
    expect(peekDeploymentRecord(home)).toMatchObject({ databaseId: expect.any(String), versionId: null });
    expect(readSetupFile(home).consented.create).toBeTruthy();
    server.commands.splice(0);
    expect(await run(['--url', 'https://changed.invalid', '--yes'], deps)).toBe(2);
    expect(errors.at(-1)).toContain('changed plans require fresh consent');
    expect(server.commands.filter(command => /\b(create|deploy)\b/.test(command))).toEqual([]);
  });

  for (const identity of ['account', 'step name'] as const) it(`requires fresh consent for a changed ${identity} before any record with --yes and no TTY`, async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    let createCalls = 0;
    let changeName = false;
    const deps: SetupDeps = { ...base(), ...server.deps,
      planCloudflare: async options => {
        const plan = await planCloudflareDeployment(options);
        if (changeName) plan.steps[0].name += '-changed';
        return plan;
      },
      createCloudflare: async () => { createCalls++; throw new Error('interrupted after consent, before record'); },
    };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes'], deps)).toBe(2);
    expect(peekDeploymentRecord(home)).toBeNull();
    expect(readSetupFile(home).consented.create).toBeTruthy();
    server.commands.splice(0);
    changeName = identity === 'step name';
    expect(await run(identity === 'account' ? ['--account-id', 'b'.repeat(32), '--yes'] : ['--yes'], deps)).toBe(2);
    expect(errors.at(-1)).toContain('changed plans require fresh consent');
    expect(createCalls).toBe(1);
    expect(server.commands.filter(command => /\b(create|deploy)\b/.test(command))).toEqual([]);
    expect(peekDeploymentRecord(home)).toBeNull();
  });

  for (const boundary of ['vectorize create', 'deploy'] as const) for (const interactive of [false, true]) it(`resumes partial Cloudflare creation at ${boundary} with ${interactive ? 'interactive' : 'no-TTY'} consent`, async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    let interrupted = false;
    const runner = { run: async (...args: Parameters<typeof server.runner.run>) => {
      if (!interrupted && args[1].slice(2).join(' ').startsWith(boundary)) { interrupted = true; throw new Error('mid-create interruption'); }
      return server.runner.run(...args);
    } };
    const questions: string[] = [];
    const deps = { ...base(), ...server.deps, cloudflare: { ...server.deps.cloudflare, runner }, sleep: async () => {},
      ask: async (question: string) => { questions.push(question); return interactive ? 'yes' : null; } };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes', '--new', 'Partial', '--no-agents', '--no-runner'], deps)).toBe(2);
    expect(peekDeploymentRecord(home)?.databaseId).toBeTruthy();
    expect(peekDeploymentRecord(home)?.versionId).toBeNull();
    const resumed = await run(['--yes'], deps);
    expect({ code: resumed, errors }).toMatchObject({ code: 0 });
    expect(server.commands.filter(command => command.startsWith('deploy '))).toHaveLength(1);
    expect(peekDeploymentRecord(home)).toMatchObject({ url: HOSTED_URL, versionId: expect.any(String) });
    expect(questions.some(question => question.startsWith('Approve this plan?'))).toBe(false);
    expect(lines.join('\n')).not.toContain('This plan changed');
  });

  for (const target of ['local', 'cloudflare'] as const) it(`resumes a ${target === 'local' ? 'native' : 'hosted'} pending registration even when its secrets are already configured`, async () => {
    const server = ownerDeployment(root, home, target, target === 'local' ? 'http://127.0.0.1:8787' : HOSTED_URL);
    closers.push(server.close);
    let registrations = 0;
    const deps: SetupDeps = { ...base(), ...server.deps, sleep: async () => {}, registerApp: async options => {
      registrations++;
      const result = await registerGitHubApp(options);
      if (registrations === 1) { await writeSignInPending(options.target, SETUP_APP, options.url); throw new Error('interrupted after secrets, before journal cleanup'); }
      return result;
    } };
    const flags = ['--create', target, ...(target === 'local' ? ['--serve', 'service'] : ['--account-id', ACCOUNT]), '--yes', '--new', 'Pending', '--no-agents', '--no-runner'];
    expect(await run(flags, deps)).toBe(2);
    if (target === 'local') expect(readLocalSecrets(peekLocalPaths(home)).GITHUB_CLIENT_ID).toBe(SETUP_APP.clientId);
    const pending = signInPendingPath(target === 'local' ? { kind: 'local', paths: peekLocalPaths(home) } : { kind: 'cloudflare', record: peekDeploymentRecord(home)!, mycoHome: home });
    expect(fs.existsSync(pending)).toBe(true);
    const result = await run(['--yes'], deps);
    expect({ code: result, errors }).toMatchObject({ code: 0 });
    expect(registrations).toBe(2);
    expect(fs.existsSync(pending)).toBe(false);
    expect(server.github.calls.filter(call => call.url.includes('/conversions'))).toHaveLength(1);
  });
});
