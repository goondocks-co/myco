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
  const affirmative = async (question: string) => question.includes('already have') ? 'no' : 'yes';
  for (const target of ['cloudflare', 'local'] as const) {
    const address = target === 'local' ? 'http://127.0.0.1:8787' : HOSTED_URL;
    const flags = () => ['--create', target, ...(target === 'local' ? ['--port', '8787', '--serve', 'service'] : ['--account-id', ACCOUNT]), '--new', 'Owner project', '--no-agents', '--no-runner', '--yes'];
    it(`creates ${target}, links through fake GitHub OAuth, signs in and connects once`, async () => {
      const server = ownerDeployment(root, home, target, address);
      closers.push(server.close);
      const deps = { ...base(), ...server.deps, sleep: async () => {}, loginDeps: { machineId: `owner-${target}` } };
      expect(await run(flags(), deps)).toBe(0);
      expect(errors).toEqual([]);
      const membership = readDeploymentMembership(address, home);
      expect(membership?.memberId).toBeTruthy();
      expect(readRegistryEntry(project, home)?.serverUrl).toBe(address);
      expect(server.links).toHaveLength(1);
      expect(server.github.calls.filter(call => call.url.includes('/conversions'))).toHaveLength(1);
      expect(server.github.calls.filter(call => call.url.includes('/access_token'))).toHaveLength(1);
      expect(server.calls.filter(route => route === '/auth/device/start')).toHaveLength(1);
      expect(server.commands.filter(command => command === 'auth token --json')).toHaveLength(target === 'cloudflare' ? 1 : 0);
      expect(lines.filter(line => line.startsWith('Setup connected'))).toHaveLength(1);
      expect(lines.filter(line => line.includes('/link#'))).toHaveLength(1);
      expect(lines.join('\n')).toContain('works once; keep it private');
      expect(errors.join('\n')).not.toContain('/link#');
      const saved = fs.readFileSync(setupFilePath(home), 'utf8');
      expect(saved).not.toContain('/link#');
      expect(saved).not.toContain(SETUP_APP.clientSecret);
      expect(saved).not.toContain('complete');
      const created = server.commands.filter(command => command.startsWith('d1 create') || command.startsWith('deploy ')).length;
      expect(await run([], deps)).toBe(0);
      expect(server.commands.filter(command => command.startsWith('d1 create') || command.startsWith('deploy '))).toHaveLength(created);
      expect(server.links).toHaveLength(1);
      expect(server.calls.filter(route => route === '/auth/device/start')).toHaveLength(1);
      expect(readDeploymentMembership(address, home)?.token).toBe(membership?.token);
      const before = snapshot(root);
      const commandCount = server.commands.length;
      expect(await run(['--status', '--json'], { ...deps, fetch: fakeFetch(async () => { throw new Error('status network'); }) })).toBe(0);
      expect(snapshot(root)).toEqual(before);
      expect(server.commands).toHaveLength(commandCount);
      fs.unlinkSync(setupFilePath(home));
      const withoutAnswers = snapshot(root);
      const beforeRemoteStatus = server.commands.length;
      expect(await run(['--status', '--json', '--create', target, '--check-remote'], deps)).toBe(0);
      const observed = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
      for (const id of ['journey', 'deployment.health', 'deployment.signin', 'machine.signin', 'project']) expect(observed.find(fact => fact.id === id)?.state).toBe('complete');
      expect(observed.find(fact => fact.id === 'deployment.owner')).toMatchObject(target === 'cloudflare' ? { state: 'incomplete', informational: true } : { state: 'complete' });
      expect(server.commands).toHaveLength(beforeRemoteStatus);
      expect(snapshot(root)).toEqual(withoutAnswers);
      expect(await run(['--status', '--create', target], deps)).toBe(0);
      expect(lines.join('\n')).toContain('This machine manages this Deployment.');
      expect(lines.join('\n')).not.toContain('This machine runs work for this Deployment.');
      expect(await run(['--status', '--json', '--check-remote'], deps)).toBe(0);
      const discovered = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
      expect(discovered.find(fact => fact.id === 'deployment.create' && fact.target === target)?.state).toBe('complete');
      expect(discovered.find(fact => fact.id === 'deployment.owner' && fact.target === target)?.state).toBe(target === 'cloudflare' ? 'incomplete' : 'complete');
      expect(snapshot(root)).toEqual(withoutAnswers);
      expect(await run(['--create', target, ...(target === 'local' ? ['--serve', 'service'] : []), '--yes', '--no-runner', '--no-agents'], deps)).toBe(0);
      expect(server.github.calls.filter(call => call.url.includes('/conversions'))).toHaveLength(1);
      expect(server.links).toHaveLength(1);
      const stale = readSetupFile(home);
      stale.answers.url = 'https://stale.invalid';
      saveSetupFile(home, stale);
      expect(await run(['--status', '--create', target, '--json', '--check-remote'], deps)).toBe(0);
      const current = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
      expect(current.find(fact => fact.id === 'machine.signin')?.scope).toBe(address);
      expect(current.find(fact => fact.id === 'deployment.health')?.scope).toBe(address);
      expect(current.find(fact => fact.id === 'journey')?.deployment).toBe(address);
      expect(server.github.calls.filter(call => call.url.includes('/conversions'))).toHaveLength(1);
    });

    for (const boundary of ['create', 'conversion', 'signin', 'owner-mint', 'owner-link', 'machine', 'project'] as const) {
      it(`resumes ${target} after interruption at ${boundary} without duplicated resources or lost state`, async () => {
        const server = ownerDeployment(root, home, target, address);
        closers.push(server.close);
        let interrupted = false;
        const interrupt = () => { if (!interrupted) { interrupted = true; throw new DOMException(`interrupted after ${boundary}`, 'AbortError'); } };
        const deps: SetupDeps = { ...base(), ...server.deps, sleep: async () => {}, ask: affirmative, loginDeps: { machineId: `interrupted-${target}` },
          createCloudflare: async options => { const result = await createCloudflareDeployment(options); if (boundary === 'create') interrupt(); return result; },
          registerApp: async options => {
            if (boundary === 'create' && target === 'local') interrupt();
            if (boundary === 'conversion' && !interrupted) {
              const savedRunner = options.runner;
              if (target === 'cloudflare') options = { ...options, runner: { run: async (command, args, opts) => { if (args.includes('bulk')) interrupt(); return savedRunner!.run(command, args, opts); } } };
            }
            const result = await registerGitHubApp(options);
            if (boundary === 'signin') interrupt();
            return result;
          },
          prepareLocal: async (localHome, plan, localDeps) => { const result = await prepareLocal(localHome, plan, localDeps); if (boundary === 'owner-mint') interrupt(); return result; },
          openUrl: async url => {
            if (new globalThis.URL(url).hash && boundary === 'owner-mint' && target === 'cloudflare') interrupt();
            await server.openUrl(url);
            if (new globalThis.URL(url).hash && boundary === 'owner-link') interrupt();
          },
          login: async (args, loginDeps) => { const result = await login(args, loginDeps); if (boundary === 'machine') interrupt(); return result; },
          join: async (args, joinDeps) => { const result = await runJoin(args, joinDeps); if (boundary === 'project') interrupt(); return result; },
        };
        if (boundary === 'conversion' && target === 'local') {
          const original = deps.registerApp!;
          deps.registerApp = async options => {
            if (!interrupted) { await writeSignInPending(options.target, await convertManifestCode('setup-conversion', server.github.registrationFetch), options.url); interrupt(); }
            return original(options);
          };
        }
        expect(await run(flags(), deps)).toBe(2);
        expect(interrupted).toBe(true);
        const keys = target === 'local' ? readLocalSecrets(peekLocalPaths(home)) : null;
        const databaseId = peekDeploymentRecord(home)?.databaseId;
        const resumed = await run([], deps);
        expect({ code: resumed, errors }).toEqual({ code: 0, errors: expect.any(Array) });
        expect(readDeploymentMembership(address, home)).not.toBeNull();
        expect(readRegistryEntry(project, home)).not.toBeNull();
        if (target === 'local') {
          const after = readLocalSecrets(peekLocalPaths(home));
          for (const key of ['SESSION_SECRET', 'SECRET_WRAP_KEY'] as const) expect(after[key]).toBe(keys![key]);
        } else expect(peekDeploymentRecord(home)?.databaseId).toBe(databaseId);
        expect(server.commands.filter(command => command.startsWith('d1 create '))).toHaveLength(target === 'local' ? 0 : 1);
        expect(server.github.calls.filter(call => call.url.includes('/conversions')).length).toBeLessThanOrEqual(1);
        expect(server.calls.filter(route => route === '/auth/device/start')).toHaveLength(1);
        expect(await run([], deps)).toBe(0);
      });
    }
  }
});
