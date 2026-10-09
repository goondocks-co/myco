import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/runner.js';
import { run as worker } from '@myco/cli/worker.js';
import { LEGACY_WORKER_WORDS, RUNNER_IDENTITY_REMAINS } from '@myco/cli/runner-service.js';
import { publishRunnerRecord, readRunnerRecord, recordRunnerContact, withRunnerLock, RUNNER_RECORD_VERSION } from '@myco/runner/runner-registry.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { deploymentKeyFor } from '@myco/member/registry.js';
import { sweepWorkerServices } from '@myco/cli/worker-service.js';
import { installWorkerService, listWorkerUnits, workerServiceSpec } from '@myco/runner/service.js';
import { recordingPlatform } from '../helpers/fake-service-manager.js';
import { runnerUpdater } from '@myco/cli/runner-update.js';
import { writeInstallMarker } from '@myco/install/managed-binary.js';

const SERVER = 'https://runner.example';
const TOKEN = `mycorun_${'r'.repeat(43)}`;
const MEMBER_TOKEN = 'm'.repeat(43);
let root: string;
let mycoHome: string;
let home: string;
let output: string[];
let errors: string[];
let platform: ReturnType<typeof recordingPlatform>;
let authorizations: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-service-'));
  home = path.join(root, 'home'); mycoHome = path.join(root, 'runner-home');
  output = []; errors = []; authorizations = []; platform = recordingPlatform();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const enroll = () => withRunnerLock(SERVER, (lock) => publishRunnerRecord(lock, { version: RUNNER_RECORD_VERSION, serverUrl: SERVER, deploymentId: 'dep-one', runnerId: 'runner-one', name: 'mini', token: TOKEN, refreshAfter: 8888888 }), mycoHome);
const member = () => writeDeploymentMembership({ serverUrl: SERVER, token: MEMBER_TOKEN, machineId: 'machine-one', joinedAt: 1, updatedAt: 1 }, { mycoHome });
const contact = (refuse = false): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  expect(['/runners/contact', '/runners/rotate']).toContain(new URL(request.url).pathname);
  authorizations.push(request.headers.get('authorization')!);
  return refuse ? Response.json({ error: 'unauthorized' }, { status: 401 }) : Response.json({ persisted: true, runner: { id: 'runner-one', name: 'mini', deploymentId: 'dep-one', state: 'enabled' }, credential: { id: 'credential-one', expiresAt: 9999999, refreshAfter: 8888888 } });
}) as typeof fetch;
const deps = (os_: 'darwin' | 'linux' = 'darwin') => ({
  mycoHome, home, binaryPath: path.join(root, 'bin', 'myco'), platform: os_, runner: platform.runner,
  lockDir: path.join(root, 'locks'), harnessDirs: () => ['/fixture/harness/bin'], detect: () => [{ id: 'codex', installed: true, authenticated: true }],
  fetch: contact(), now: () => 1000, stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line),
});

describe('explicit runner service opt-in', () => {
  for (const os_ of ['darwin', 'linux'] as const) it(`updates and reports the installed service program from a sibling CLI on ${os_}`, async () => {
    const serviceBinary = path.join(root, 'service-bin', 'myco');
    fs.mkdirSync(path.dirname(serviceBinary), { recursive: true });
    fs.writeFileSync(serviceBinary, '#!/bin/sh\nprintf "2.0.0-alpha.2\\n"\n', { mode: 0o755 });
    installWorkerService({ ...deps(os_), binaryPath: serviceBinary, serverUrl: SERVER, executor: 'runner' }, [], { runner: platform.runner });
    writeInstallMarker(mycoHome, { channel: 'alpha', source: 'curl', bin: deps(os_).binaryPath });
    const updater = runnerUpdater(SERVER, deps(os_), line => output.push(line));
    expect(updater.contactPayload()).toMatchObject({ currentVersion: '2.0.0-alpha.2', channel: 'alpha' });
    const foreground = runnerUpdater(SERVER, { ...deps(os_), version: '2.0.0-alpha.3' }, line => output.push(line), true);
    foreground.onContact({ updateRequest: { id: 'foreground-request', requestedAt: 1000 } });
    expect(await foreground.idle()).toBe('continue');
    expect(foreground.contactPayload().lastResult).toMatchObject({ result: 'refused', reason: 'runner service is not installed' });
    expect(fs.readFileSync(serviceBinary, 'utf8')).toContain('2.0.0-alpha.2');
  });
  it('retirement names the exact legacy unit when path-prefixed addresses share a lock', async () => {
    const a = `${SERVER}/a`, b = `${SERVER}/b`;
    const units = [a, b].map(serverUrl => installWorkerService({ ...deps(), serverUrl }, [], { runner: platform.runner }));
    expect(await worker(['uninstall', '--server', SERVER], deps())).toBe(false);
    expect(units.every(unit => fs.existsSync(unit.unitFile))).toBe(true);
    const selected = listWorkerUnits(home, 'darwin').at(-1)!;
    expect(await worker(['uninstall', '--server', selected.serverUrl!], deps())).toBe(true);
    for (const unit of units) expect(fs.existsSync(unit.unitFile)).toBe(unit.unitFile !== selected.unitFile);
  });

  it('status inventories legacy workers across homes without registration or a matching local unit', async () => {
    const otherHome = path.join(root, 'other home');
    installWorkerService({ ...deps(), mycoHome: otherHome, serverUrl: SERVER }, [], { runner: platform.runner });
    for (const command of [run, worker]) {
      for (const verb of ['status', 'doctor']) {
        output.length = 0;
        await command([verb], deps());
        expect(output.join('\n')).toContain(`owning MYCO_HOME='${otherHome}'`);
        expect(output.join('\n')).toContain(`MYCO_HOME='${otherHome}' myco worker uninstall --server '${SERVER}'`);
      }
    }
    await enroll();
    output.length = 0;
    await run(['status'], deps());
    expect(output.join('\n')).toContain(`owning MYCO_HOME='${otherHome}'`);
  });

  it('unnamed compatibility install inventories stopped legacy units without restarting them', async () => {
    for (const url of [SERVER, 'https://second.example']) {
      installWorkerService({ ...deps(), serverUrl: url }, [], { runner: platform.runner });
    }
    platform.loaded.clear(); platform.running.clear(); platform.commands.length = 0;
    expect(await worker(['install'], deps())).toBe(true);
    expect(platform.running.size).toBe(0);
    expect(platform.commands).toEqual([]);
    expect(output.join('\n')).toContain('No service changed');
    expect(await worker(['install', '--server', SERVER], deps())).toBe(true);
    expect(platform.running.size).toBe(1);
    output.length = 0;
    expect(await worker(['uninstall', '--server', SERVER], deps())).toBe(true);
    expect(output.join('\n')).toContain('Membership and capture are unchanged; nothing else to remove.');
    expect(output.join('\n')).not.toContain('dashboard');
  });

  for (const mode of ['member only', 'runner only', 'both']) {
    for (const os_ of ['darwin', 'linux'] as const) {
      it(`${mode} installs only an enrolled runner on ${os_}`, async () => {
        if (mode !== 'runner only') member();
        if (mode !== 'member only') await enroll();
        const installed = await run(['install', '--server', SERVER], deps(os_));
        expect(installed).toBe(mode !== 'member only');
        if (mode === 'member only') {
          expect(platform.commands).toEqual([]);
          expect(errors.join('\n')).toContain(`myco runner register ${SERVER}`);
        } else {
          const spec = workerServiceSpec({ ...deps(os_), serverUrl: SERVER, executor: 'runner' }, []);
          const file = os_ === 'darwin' ? path.join(home, 'Library', 'LaunchAgents', `${spec.unit.label}.plist`) : path.join(home, '.config', 'systemd', 'user', `${spec.unit.unitName}.service`);
          const bytes = fs.readFileSync(file, 'utf8');
          expect(bytes).toContain(mycoHome);
          expect(bytes).toContain(os_ === 'darwin' ? '<string>runner</string>' : 'myco runner run');
          expect(bytes).not.toContain(MEMBER_TOKEN);
          expect(bytes).not.toContain(TOKEN);
          expect(await run(['install', '--server', SERVER], deps(os_))).toBe(true);
          expect(await run(['doctor', '--server', SERVER], deps(os_))).toBe(true);
          expect(output.join('\n')).toContain('harnesses offered: unknown');
          expect(readRunnerRecord(SERVER, mycoHome)?.lastContactAt).toBeUndefined();
        }
      });
    }
  }

  it('uninstall retains registration and capture byte for byte', async () => {
    await enroll(); member();
    const spool = path.join(mycoHome, 'member', 'sentinel'); fs.mkdirSync(path.dirname(spool), { recursive: true }); fs.writeFileSync(spool, 'capture');
    await run(['install', '--server', SERVER], deps());
    const before = readRunnerRecord(SERVER, mycoHome);
    expect(await run(['uninstall', '--server', SERVER], deps())).toBe(true);
    expect(readRunnerRecord(SERVER, mycoHome)).toEqual(before);
    expect(fs.readFileSync(spool, 'utf8')).toBe('capture');
    expect(output.join('\n')).toContain(RUNNER_IDENTITY_REMAINS);
  });

  it('keeps a legacy service and refuses handover without stopping it', async () => {
    await enroll(); member();
    const target = { ...deps(), serverUrl: SERVER };
    const installed = installWorkerService(target, [], { runner: platform.runner });
    const before = fs.readFileSync(installed.unitFile, 'utf8');
    platform.commands.length = 0;
    expect(await run(['install', '--server', SERVER], deps())).toBe(false);
    expect(errors.join('\n')).toContain(LEGACY_WORKER_WORDS);
    expect(platform.commands.every((line) => line.startsWith('launchctl list'))).toBe(true);
    expect(fs.readFileSync(installed.unitFile, 'utf8')).toBe(before);
    expect(await worker(['install', '--server', SERVER], deps())).toBe(true);
    expect(fs.readFileSync(installed.unitFile, 'utf8')).toBe(before);
    expect(await worker(['uninstall', '--server', SERVER], deps())).toBe(true);
    expect(await run(['install', '--server', SERVER], deps())).toBe(true);
  });

  it('refuses an older foreground executor through an unrecorded origin alias', async () => {
    await enroll();
    const held = LifecycleLock.acquire(path.join(root, 'locks', `${deploymentKeyFor('https://old-alias.example')}.lock`));
    try {
      expect(await run(['install', '--server', SERVER], deps())).toBe(false);
      expect(await run(['run', '--server', SERVER, '--once'], deps())).toBe(false);
      expect(platform.commands).toEqual([]);
      expect(errors.join('\n')).toContain('stop the foreground executor in its owning terminal');
      expect(authorizations).toEqual([]);
    } finally { if (held.acquired) held.lock.release(); }
  });

  it('refuses foreground execution beside a legacy unit with an unverified origin alias', async () => {
    await enroll();
    const legacy = installWorkerService({ ...deps(), serverUrl: 'https://other-origin.example' }, [], { runner: platform.runner });
    expect(await run(['run', '--server', SERVER, '--once'], deps())).toBe(false);
    expect(errors.join('\n')).toContain('identity across origin aliases is unverified');
    expect(errors.join('\n')).toContain("myco worker uninstall --server 'https://other-origin.example'");
    expect(authorizations).toEqual([]);
    expect(fs.existsSync(legacy.unitFile)).toBe(true);
  });

  it('names the owning home when legacy service retirement crosses homes', async () => {
    await enroll();
    const foreign = path.join(root, 'legacy-home');
    installWorkerService({ ...deps(), mycoHome: foreign, serverUrl: SERVER }, [], { runner: platform.runner });
    expect(await run(['install', '--server', SERVER], deps())).toBe(false);
    expect(errors.join('\n')).toContain(`MYCO_HOME='${foreign}' myco worker uninstall --server '${SERVER}'`);
    expect(await worker(['uninstall', '--server', SERVER], { ...deps(), mycoHome: foreign })).toBe(true);
    expect(await run(['install', '--server', SERVER], deps())).toBe(true);
  });

  it('quotes legacy URLs in the printed retirement command', async () => {
    await enroll();
    installWorkerService({ ...deps(), serverUrl: 'https://legacy.example/?a=1&b=2' }, [], { runner: platform.runner });
    expect(await run(['install', '--server', SERVER], deps())).toBe(false);
    expect(errors.join('\n')).toContain("--server 'https://legacy.example/?a=1&b=2'");
  });

  it('doctor renews an expired recoverable runner credential through the runner path', async () => {
    await enroll();
    await withRunnerLock(SERVER, (lock) => publishRunnerRecord(lock, { ...readRunnerRecord(SERVER, mycoHome)!, tokenExpiresAt: 500, refreshAfter: 400 }), mycoHome);
    let successor = '';
    const fetch_: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/runners/rotate') {
        expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
        successor = (await request.json() as { candidate: string }).candidate;
        return Response.json({ persisted: true, rotated: true, credentialId: 'successor-id', expiresAt: 9999999, refreshAfter: 8888888 });
      }
      expect(request.headers.get('authorization')).toBe(`Bearer ${successor}`);
      return contact()(input, init);
    }) as typeof fetch;
    expect(await run(['doctor', '--server', SERVER], { ...deps(), fetch: fetch_ })).toBe(true);
    expect(readRunnerRecord(SERVER, mycoHome)?.token).toBe(successor);
    expect(output.join('\n')).not.toContain(successor);
  });

  it('refused runner authentication never tries the available member credential', async () => {
    await enroll(); member();
    expect(await run(['doctor', '--server', SERVER], { ...deps(), fetch: contact(true) })).toBe(false);
    expect(authorizations).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    expect(output.join('\n')).toContain('no member credential is used');
    expect(output.join('\n')).not.toContain(TOKEN);
    expect(output.join('\n')).not.toContain(MEMBER_TOKEN);
  });

  it('global removal sweeps this home’s runners and retains another home’s runner', async () => {
    await enroll();
    await run(['install', '--server', SERVER], deps());
    const foreign = installWorkerService({ ...deps(), mycoHome: path.join(root, 'foreign'), serverUrl: SERVER, executor: 'runner' }, [], { runner: platform.runner });
    const swept = sweepWorkerServices(deps());
    expect(swept.removed).toHaveLength(1);
    expect(swept.kept).toEqual([{ unitFile: foreign.unitFile, reason: 'the runner belongs to another home' }]);
    expect(fs.existsSync(foreign.unitFile)).toBe(true);
  });

  it('retains the unit and reports refusal if stopping the service fails', async () => {
    await enroll();
    await run(['install', '--server', SERVER], deps('linux'));
    const spec = workerServiceSpec({ ...deps('linux'), serverUrl: SERVER, executor: 'runner' }, []);
    const file = path.join(home, '.config', 'systemd', 'user', `${spec.unit.unitName}.service`);
    const runner = (command: string, args: readonly string[]) => args.includes('disable') ? { status: 1 } : platform.runner(command, args);
    expect(await run(['uninstall', '--server', SERVER], { ...deps('linux'), runner })).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(errors.join('\n')).toContain('could not be stopped');
    expect(output.join('\n')).not.toContain('stopped and removed');
  });

  it('global removal inspects enrolled runner services even when their unit is absent', async () => {
    await enroll();
    await run(['install', '--server', SERVER], deps());
    const unit = workerServiceSpec({ ...deps(), serverUrl: SERVER, executor: 'runner' }, []).unit;
    fs.rmSync(path.join(home, 'Library', 'LaunchAgents', `${unit.label}.plist`));
    const runner = (command: string, args: readonly string[]) => ['unload', 'remove'].includes(args[0]!) ? { status: 1 } : platform.runner(command, args);
    expect(() => sweepWorkerServices({ ...deps(), runner })).toThrow('could not be stopped');
    expect(platform.running.has(unit.label)).toBe(true);
  });

  it('worker aliases inventory and remove both classes in a mixed home', async () => {
    await enroll();
    await run(['install', '--server', SERVER], deps());
    const legacyUrl = 'https://legacy.example';
    installWorkerService({ ...deps(), serverUrl: legacyUrl }, [], { runner: platform.runner });
    output.length = 0;
    await worker(['status'], deps());
    expect(output.join('\n')).toContain('registered runner mini');
    expect(output.join('\n')).toContain(LEGACY_WORKER_WORDS);
    expect(await worker(['uninstall'], deps())).toBe(true);
    expect(platform.loaded.size).toBe(0);
    expect(readRunnerRecord(SERVER, mycoHome)).not.toBeNull();
  });

  it('legacy aliases show a prepared runner on the same Deployment without interrupting active work', async () => {
    await enroll();
    installWorkerService({ ...deps(), serverUrl: SERVER }, [], { runner: platform.runner });
    platform.commands.length = 0;
    expect(await worker(['install', '--server', SERVER], deps())).toBe(true);
    expect(platform.commands.some((line) => /launchctl (load|unload|remove)/.test(line))).toBe(false);
    output.length = 0;
    await worker(['status', '--server', SERVER], deps());
    expect(output.join('\n')).toContain('registered runner mini');
    expect(output.join('\n')).toContain('execution refused: legacy worker');
  });

  it('verifies stopping a live executor even when its unit file is missing', async () => {
    await enroll();
    await run(['install', '--server', SERVER], deps());
    const unit = workerServiceSpec({ ...deps(), serverUrl: SERVER, executor: 'runner' }, []).unit;
    fs.rmSync(path.join(home, 'Library', 'LaunchAgents', `${unit.label}.plist`));
    const runner = (command: string, args: readonly string[]) => ['unload', 'remove'].includes(args[0]!) ? { status: 1 } : platform.runner(command, args);
    expect(await run(['uninstall', '--server', SERVER], { ...deps(), runner })).toBe(false);
    expect(errors.join('\n')).toContain('could not be stopped');
    expect(platform.running.has(unit.label)).toBe(true);
  });

  it('worker install restarts a retained legacy service without changing its unit', async () => {
    const installed = installWorkerService({ ...deps(), serverUrl: SERVER }, [], { runner: platform.runner });
    const before = fs.readFileSync(installed.unitFile, 'utf8');
    platform.loaded.clear(); platform.running.clear();
    expect(await worker(['install', '--server', SERVER], deps())).toBe(true);
    expect(fs.readFileSync(installed.unitFile, 'utf8')).toBe(before);
    expect(platform.running.size).toBe(1);
  });

  it('reads only the selected home and refuses a membership in another home', async () => {
    await enroll();
    const foreign = path.join(root, 'member-home');
    writeDeploymentMembership({ serverUrl: SERVER, token: MEMBER_TOKEN, machineId: 'other', joinedAt: 1, updatedAt: 1 }, { mycoHome: foreign });
    expect(await run(['install', '--server', SERVER], { ...deps(), mycoHome: foreign })).toBe(false);
    expect(platform.commands).toEqual([]);
  });
});

it('status shows the acknowledged service offer and one service contact time, regardless of CLI detection', async () => {
  await enroll();
  await recordRunnerContact(SERVER, { runnerId: 'runner-one', deploymentId: 'dep-one' }, 500, mycoHome, { offered: ['claude-code', 'codex'], withheld: [] });
  const different = { ...deps(), detect: () => { throw new Error('status must not detect in the CLI environment'); },
    fetch: async () => { throw new Error('status must not contact the Deployment'); } };
  expect(await run(['status'], different)).toBe(true);
  const text = output.join('\n');
  expect(text).toContain('harnesses offered: claude-code, codex');
  expect(text).toContain('observed: 1970-01-01T00:00:00.500Z');
  expect(text.match(/last contact:/g)).toHaveLength(1);
  expect(text).toContain('last contact: 1970-01-01T00:00:00.500Z');
  expect(text).not.toContain('contact acknowledged:');
});

it('legacy uninstall prints only its removal even when this Deployment also has a runner record', async () => {
  await enroll();
  installWorkerService({ ...deps(), serverUrl: SERVER }, [], { runner: platform.runner });
  output.length = 0;
  expect(await worker(['uninstall', '--server', SERVER], deps())).toBe(true);
  expect(output.join('\n')).toContain('legacy worker service stopped and removed');
  expect(output.join('\n')).not.toContain('no runner service');
  expect(output.join('\n')).not.toContain(RUNNER_IDENTITY_REMAINS);
});
