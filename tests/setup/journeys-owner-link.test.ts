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
import { resetMachineIdCache } from '@myco/machine-id.js';
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
  resetMachineIdCache();
});
const base = (): SetupDeps => ({ mycoHome: home, cwd: project, ask: async () => null, agents: () => [], stdout: line => lines.push(line), stderr: line => errors.push(line) });
function holdRunnerLock(lockDir: string): void {
  bindRunnerLock(closers, lockDir);
}

describe('new owner journeys (a) and (b)', () => {
  it('shows the private owner link only on stdout, never in setup.json or logs, when the opener is missing', async () => {
    const logs: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
    closers.push(() => { log.mockRestore(); });
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const deps = { ...base(), ...server.deps, sleep: async () => {}, openUrl: async (url: string) => {
      if (!new globalThis.URL(url).hash) return server.openUrl(url);
      await server.openUrl(url);
      throw new Error('fixture missing opener');
    } };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes', '--new', 'Opener', '--no-agents', '--no-runner'], deps)).toBe(0);
    expect(lines.filter(line => line.includes('/link#'))).toHaveLength(1);
    expect(lines.join('\n')).toContain('works once; keep it private');
    expect(lines.join('\n')).toMatch(/Expires: \d{4}-/);
    expect(errors.join('\n')).not.toContain('/link#');
    expect(logs.join('\n')).not.toContain('/link#');
    expect(fs.readFileSync(setupFilePath(home), 'utf8')).not.toContain('/link#');
  });

  it('asks for each Cloudflare login occurrence instead of saving standing consent', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const questions: string[] = [];
    const deps = { ...base(), ...server.deps, sleep: async () => {}, ask: async (question: string) => { questions.push(question); return 'yes'; } };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes', '--new', 'Login', '--no-agents', '--no-runner'], deps)).toBe(0);
    for (let occurrence = 0; occurrence < 2; occurrence++) {
      server.signOutWrangler();
      expect(await run([], deps)).toBe(0);
    }
    expect(questions.filter(question => question.startsWith('Sign in to Cloudflare'))).toHaveLength(2);
    expect(readSetupFile(home).consented['cloudflare.login']).toBeUndefined();
  });

  it('asks for each native service stop occurrence instead of saving standing consent', async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    const questions: string[] = [];
    const deps: SetupDeps = { ...base(), ...server.deps, sleep: async () => {}, ask: async question => { questions.push(question); return 'yes'; } };
    expect(await run(['--create', 'local', '--serve', 'service', '--yes', '--new', 'Stop', '--no-agents', '--no-runner'], deps)).toBe(0);
    server.platform.dispose();
    await writeSignInPending({ kind: 'local', paths: peekLocalPaths(home) }, SETUP_APP, 'http://127.0.0.1:8787');
    for (let occurrence = 0; occurrence < 2; occurrence++) {
      expect(await run([], { ...deps, registerApp: async () => { throw new Error('fixture registration still pending'); } })).toBe(2);
    }
    expect(questions.filter(question => question.startsWith('This stops your Myco'))).toHaveLength(2);
    expect(readSetupFile(home).consented['local.stop']).toBeUndefined();
  });

  it('pins the missing hosted address refusal while keeping provisioned resources', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const runner = { run: async (...args: Parameters<typeof server.runner.run>) => {
      const result = await server.runner.run(...args);
      return args[1].includes('deploy') ? { ...result, stdout: result.stdout.replace(HOSTED_URL, '') } : result;
    } };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes'], { ...base(), ...server.deps, cloudflare: { ...server.deps.cloudflare, runner } })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: Cloudflare has not reported your Myco’s address; run myco server status --target cloudflare, then myco setup again.');
    expect(peekDeploymentRecord(home)?.databaseId).toBeTruthy();
    expect(server.github.calls).toHaveLength(0);
  });

  it('pins delayed GitHub verification and resumes the installed app without registering again', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const deps = { ...base(), ...server.deps, sleep: async () => {}, registerApp: async (options: Parameters<typeof registerGitHubApp>[0]) => ({ ...await registerGitHubApp(options), verified: { ok: false as const, reason: 'fixture propagation' } }) };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--new', 'Delayed', '--no-agents', '--no-runner', '--yes'], deps)).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: GitHub sign-in is not answering yet; check myco server status --target cloudflare, then run myco setup again.');
    expect(await run(['--yes'], { ...deps, registerApp: registerGitHubApp })).toBe(0);
    expect(server.github.calls.filter(call => call.url.includes('/conversions'))).toHaveLength(1);
  });

  it('stops on unavailable hosted sign-in without recreating resources or registering an app', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    const deps: SetupDeps = { ...base(), ...server.deps, createCloudflare: async options => { await createCloudflareDeployment(options); throw new Error('interrupted before sign-in'); } };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes'], deps)).toBe(2);
    const record = peekDeploymentRecord(home);
    expect(await run(['--yes'], { ...deps, fetch: fakeFetch(async (input, init) => {
      if (new globalThis.URL(new Request(input, init).url).pathname === '/auth/login') throw new Error('fixture sign-in unavailable');
      return server.fetchImpl(input, init);
    }) })).toBe(2);
    expect(errors.at(-1)).toBe(`myco setup: deployment.signin (${HOSTED_URL}) unavailable: ${HOSTED_URL} did not answer: fixture sign-in unavailable. Restore access, then run myco setup again.`);
    expect(peekDeploymentRecord(home)).toEqual(record);
    expect(server.commands.filter(command => command.startsWith('deploy '))).toHaveLength(1);
    expect(server.github.calls).toHaveLength(0);
  });

  it('pins account mismatch before running any Cloudflare command', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    writeDeploymentRecord({ accountId: 'b'.repeat(32), workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: new Date(0).toISOString() }, home);
    const recordFile = path.join(home, 'server', 'cloudflare', 'record.json');
    const before = fs.readFileSync(recordFile);
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--yes'], { ...base(), ...server.deps })).toBe(2);
    expect(errors.at(-1)).toBe(`myco setup: deployment.create (${home}) unavailable: Selected Cloudflare account does not match the Deployment record; keep its --account-id. Restore access, then run myco setup again.`);
    expect(server.commands).toEqual([]);
    expect(peekDeploymentRecord(home)?.accountId).toBe('b'.repeat(32));
    expect(fs.readFileSync(recordFile)).toEqual(before);
  });

  it('pins the refusal to change an existing native port and keeps its keys', async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    createLocalDeployment(DEFAULT_LOCAL_RECORD, { library: null, vec0: null }, peekLocalPaths(home));
    const keys = readLocalSecrets(peekLocalPaths(home));
    expect(await run(['--create', 'local', '--port', '8788', '--serve', 'terminal', '--yes'], { ...base(), ...server.deps })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: This Deployment uses port 8787; run myco setup --port 8787.');
    expect(readLocalSecrets(peekLocalPaths(home))).toEqual(keys);
    expect(server.platform.commands).toEqual([]);
  });

  it('pins missing Wrangler guidance and keeps the selected target', async () => {
    const runner = { run: async () => ({ code: 1, stdout: '', stderr: 'fixture absent' }) };
    expect(await run(['--create', 'cloudflare', '--yes'], { ...base(), cloudflare: { runner } })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: wrangler is not installed; `npm install -g wrangler`, then `wrangler login`, and retry');
    expect(readSetupFile(home).answers.target).toBe('cloudflare');
    expect(peekDeploymentRecord(home)).toBeNull();
  });

  it('pins the refusal to guide a shared native Deployment', async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    createLocalDeployment({ ...DEFAULT_LOCAL_RECORD, origin: 'https://existing.invalid' }, { library: null, vec0: null }, peekLocalPaths(home));
    const data = fs.readFileSync(peekLocalPaths(home).databasePath);
    expect(await run(['--create', 'local', '--serve', 'service', '--yes'], { ...base(), ...server.deps })).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: Guided local setup is loopback only. Keep this Myco’s configuration and use myco server status --target local.');
    expect(fs.readFileSync(peekLocalPaths(home).databasePath)).toEqual(data);
    expect(server.platform.commands).toEqual([]);
  });

  for (const refusal of ['pending', 'missing'] as const) it(`pins the ${refusal} native owner link refusal`, async () => {
    const server = ownerDeployment(root, home, 'local', 'http://127.0.0.1:8787');
    closers.push(server.close);
    const deps: SetupDeps = { ...base(), ...server.deps, sleep: async () => {},
      ask: async question => question.includes('already have') || (refusal === 'pending' && question.startsWith('Make a fresh link?')) ? 'no' : 'yes',
      prepareLocal: async (localHome, plan, localDeps) => ({ ...await prepareLocal(localHome, plan, localDeps), ownerLink: null }),
      ...(refusal === 'missing' ? { recoverLocal: async () => ({ url: 'http://127.0.0.1:8787', ownerLink: null }) } : {}),
    };
    expect(await run(['--create', 'local', '--port', '8787', '--serve', 'service', '--new', 'Owner', '--no-agents', '--no-runner'], deps)).toBe(2);
    expect(errors.at(-1)).toBe(refusal === 'pending' ? 'myco setup: Owner linking is pending; run myco setup again when ready.' : 'myco setup: No owner link was issued; run myco server setup-owner, then myco setup again.');
  });

  it('pins an expired owner link refusal and keeps the first owner for a rerun', async () => {
    const server = ownerDeployment(root, home, 'cloudflare');
    closers.push(server.close);
    let expired = false;
    const deps: SetupDeps = { ...base(), ...server.deps, sleep: async () => {}, now: () => Date.now() + (expired ? 16 * 60_000 : 0),
      ask: async question => question.includes('already have') || question.startsWith('The owner link expired.') ? 'no' : 'yes',
      openUrl: async url => { if (new globalThis.URL(url).hash) { expired = true; return; } await server.openUrl(url); },
    };
    expect(await run(['--create', 'cloudflare', '--account-id', ACCOUNT, '--url', HOSTED_URL, '--new', 'Expired', '--no-agents', '--no-runner'], deps)).toBe(2);
    expect(errors.at(-1)).toBe('myco setup: Owner link expired; run myco setup again to make a fresh link.');
    expect((server.sqlite.query('SELECT count(*) AS count FROM members').get() as { count: number }).count).toBe(1);
    expect(await run(['--yes'], { ...deps, now: Date.now, openUrl: server.openUrl })).toBe(0);
  });

  for (const target of ['cloudflare', 'local'] as const) it(`an expired ${target} owner link is replaced with consent and completes`, async () => {
    const address = target === 'local' ? 'http://127.0.0.1:8787' : HOSTED_URL;
    const server = ownerDeployment(root, home, target, address);
    closers.push(server.close);
    let expired = false;
    let opens = 0;
    const deps: SetupDeps = { ...base(), ...server.deps, now: () => Date.now() + (expired ? 16 * 60_000 : 0), sleep: async () => {},
      openUrl: async url => {
        if (new globalThis.URL(url).hash && ++opens === 1) { expired = true; return; }
        expired = false;
        await server.openUrl(url);
      },
    };
    expect(await run(['--create', target, ...(target === 'local' ? ['--serve', 'service'] : ['--account-id', ACCOUNT]), '--yes', '--new', 'Expiry', '--no-agents', '--no-runner'], deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(opens).toBe(2);
    expect(server.links).toHaveLength(1);
    if (target === 'local') expect(server.platform.commands.some(command => command.includes('unload'))).toBe(true);
  });

  for (const expire of [false, 'wait', 'resume'] as const) it(`terminal setup ${expire ? `recovers an expired link during ${expire}` : 'asks the user to serve'} and never starts a service`, async () => {
    const address = 'http://127.0.0.1:8787';
    const server = ownerDeployment(root, home, 'local', address);
    closers.push(server.close);
    let serves = 0;
    let expired = false;
    let opens = 0;
    let terminal: (() => void)[] = [];
    closers.unshift(() => { terminal.forEach(release => release()); });
    const deps: SetupDeps = { ...base(), ...server.deps, cwd: root, sleep: async () => {}, now: () => Date.now() + (expired ? 16 * 60_000 : 0), openUrl: async url => {
      if (new globalThis.URL(url).hash && ++opens === 1 && expire) {
        expired = true;
        if (expire === 'resume') throw new DOMException('interrupted with the terminal server still running', 'AbortError');
        return;
      }
      expired = false;
      await server.openUrl(url);
    }, stdout: line => {
      lines.push(line);
      if (line.startsWith('Stop your Myco')) { terminal.forEach(release => release()); terminal = []; return; }
      if (!line.startsWith('In another terminal, run:') && !line.startsWith('Start it again:')) return;
      if (terminal.length > 0) return;
      serves++;
      const paths = peekLocalPaths(home);
      for (const [name, mode] of [[`${paths.root}.serve.lock`, 'exclusive'], [`${paths.root}.lock`, 'shared']] as const) {
        const held = LifecycleLock.acquire(name, { command: 'fixture separate terminal', mode });
        if (!held.acquired) throw new Error('fixture terminal lease unavailable');
        terminal.push(() => held.lock.release());
      }
    } };
    const result = await run(['--create', 'local', '--serve', 'terminal', '--yes', '--no-agents', '--no-runner'], deps);
    expect(result).toBe(expire === 'resume' ? 2 : 0);
    if (expire === 'resume') {
      expect(errors.pop()).toBe('myco setup: interrupted with the terminal server still running');
      expect(await run(['--yes'], deps)).toBe(0);
    }
    expect(errors).toEqual([]);
    expect(serves).toBe(expire ? 2 : 1);
    expect(server.platform.commands).toEqual([]);
    expect(lines).toContain('In another terminal, run: myco server run --target local');
    expect(lines.at(-1)).toContain('from a git repository');
  });

  for (const target of ['local', 'cloudflare'] as const) it(`create ${target} status on an absent home is file-only, read-only and never runs tools`, async () => {
    const before = snapshot(root);
    expect(await run(['--status', '--json', '--create', target], { ...base(), fetch: fakeFetch(async () => { throw new Error('network forbidden'); }), cloudflare: { runner: { run: async () => { throw new Error('wrangler forbidden'); } } }, local: { native: { library: null, vec0: null }, service: { runner: () => { throw new Error('service forbidden'); } } } })).toBe(3);
    expect(snapshot(root)).toEqual(before);
    const observations = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
    expect(observations.find(fact => fact.id === 'deployment.create')?.state).toBe('absent');
  });

  for (const [flags, refusal] of [
    [['--create', 'other'], '--create needs cloudflare or local'],
    [['--create', 'local', '--url', 'https://example.invalid'], 'Local setup is loopback only; use --port and --serve, without --url, --account-id or --org.'],
    [['--create', 'cloudflare', '--port', '8787'], 'Cloudflare setup uses --account-id and --url, without --port or --serve.'],
    [['--account-id', 'wrong'], '--account-id needs 32 hexadecimal characters'],
    [['--url', 'http://remote.invalid'], '--url needs an https Deployment origin, with no path, query or fragment'],
    [['--org', 'bad org'], '--org needs a GitHub organization name'],
    [['--app-name', 'x'.repeat(35)], '--app-name needs 1 to 34 characters'],
    [['--port', '0'], '--port needs an integer from 1 to 65535'],
    [['--port', '1.5'], '--port needs an integer from 1 to 65535'],
    [['--serve', 'foreground'], '--serve needs service or terminal'],
    [['--create', 'local', '--join', URL], '--create and --join cannot be combined'],
    [['--create', 'local', '--runner', URL], '--create and --runner cannot be combined'],
  ] as const) it(`pins the refusal for ${flags.join(' ')}`, () => {
    expect(() => parseSetupOptions(flags)).toThrow(refusal);
  });
});
