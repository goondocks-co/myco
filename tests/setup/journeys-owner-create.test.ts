import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, parseSetupOptions } from '@myco/cli/setup.js';
import { consentToPlan, cutoverConsentPlan, type SetupDeps } from '@myco/setup/steps.js';
import { observeSetup, setupExitCode } from '@myco/setup/observe.js';
import { planFingerprint, readSetupFile, saveSetupFile, setupFilePath } from '@myco/setup/answers.js';
import { readDeploymentMembership, readRegistryEntry, writeDeploymentMembership, writeRegistryEntry, registryEntryPath, deploymentPath, deploymentKeyFor, machineSettingsPath } from '@myco/member/registry.js';
import { fakeGitHub, SETUP_APP } from './fixtures/github.js';
import { SESSION_SECRET } from '../myco-server/helpers/owner.js';
import { ownerDeployment, ACCOUNT, HOSTED_URL } from './fixtures/owner-deployment.js';
import { createCloudflareDeployment, planCloudflareDeployment } from '@myco/server/cloudflare-lifecycle.js';
import { registerGitHubApp, convertManifestCode, writeSignInPending, signInPendingPath } from '@myco/server/github-app.js';
import { peekDeploymentRecord, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { peekLocalPaths, readLocalSecrets, createLocalDeployment, DEFAULT_LOCAL_RECORD } from '@myco/server/local.js';
import { runJoin } from '@myco/cli/member.js';
import { URL, fakeFetch, freshJourney, snapshot, holdRunnerLock as bindRunnerLock } from './fixtures/journey-harness.js';

const OWNER_JOURNEY_TIMEOUT_MS = 60_000;

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
    }, OWNER_JOURNEY_TIMEOUT_MS);

    for (const boundary of ['create', 'conversion', 'project'] as const) {
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
            return registerGitHubApp(options);
          },
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
      }, OWNER_JOURNEY_TIMEOUT_MS);
    }
  }
});
