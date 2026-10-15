import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as member from '@myco/cli/member.js';
import * as recordModule from '@myco/symbionts/member-provision-record.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { setupChecks } from '@myco/cli/member-doctor.js';
import { run as login } from '@myco/cli/login.js';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { unjoinedRig } from '../member/helpers/server.js';
import { keepCurrent } from '@myco/cli/member-keep-current.js';
import { renderSetupStatus } from '@myco/cli/setup-status.js';
import { observeSetup, observeSetupStatus } from '@myco/setup/observe.js';
import { run as setup } from '@myco/cli/setup.js';
import { recordProvision, readProvisionRecord, provisionRecordPath } from '@myco/symbionts/member-provision-record.js';
import { deploymentPath, writeDeploymentMembership, writeRegistryEntry } from '@myco/member/registry.js';
import { getPluginVersion } from '@myco/version.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';
import { ownerDeployment, ACCOUNT } from './fixtures/owner-deployment.js';

const SERVER = 'https://agents.example';
let scratch: string;
let home: string;
let restore: () => void;
let previousPath: string | undefined;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-agent-set-'));
  home = path.join(scratch, 'myco');
  restore = bindSandboxChildHome(scratch, { MYCO_HOME: home });
  previousPath = process.env.PATH;
  const bin = path.join(process.env.HOME!, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
});
afterEach(async () => {
  await Promise.all([...children].map(child => new Promise<void>(resolve => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  })));
  restore();
  if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exitCode = 0;
});

const detected = () => ['claude-code', 'codex', 'windsurf', 'copilot'];
const status = () => observeSetupStatus(home, { role: 'join', url: SERVER }, { agents: detected, includeCapture: false });
const provision = (agent: string) => member.provisionGlobally(agent, null, home, { serverUrl: SERVER });
const refresh = () => member.runProvision(['--refresh'], { mycoHome: home, cwd: scratch, agents: detected, stdout: () => {}, stderr: line => { throw new Error(line); } });
const omitCodex = () => recordProvision(home, { version: getPluginVersion(), serverUrl: SERVER, agents: ['claude-code'] }, { replace: true });

it('keeps chosen current agents complete and offers each installed agent never set up', async () => {
  provision('claude-code');
  const facts = await status();
  expect(facts.find(fact => fact.id === 'machine.agents')).toMatchObject({ state: 'complete', detail: 'current' });
  const lines = renderSetupStatus(facts);
  expect(lines).toContain("Codex is installed; Myco doesn't capture it yet. Run myco member provision codex to add it.");
  expect(lines).toContain("Myco can't capture Windsurf or GitHub Copilot in this build.");
  expect(lines.join('\n')).not.toContain('Out of date');
  expect(refresh()).toBe(true);
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code']);
});

it('keeps a genuinely stale chosen agent out of date even when detection misses it', async () => {
  provision('claude-code');
  const file = path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.hooks.Stop[0].hooks[0].timeout = 999;
  fs.writeFileSync(file, JSON.stringify(data));
  const facts = await observeSetupStatus(home, { role: 'join', url: SERVER }, { agents: () => ['copilot'], includeCapture: false });
  expect(facts.find(fact => fact.id === 'machine.agents')).toMatchObject({ state: 'incomplete', detail: 'stale' });
  expect(renderSetupStatus(facts).join('\n')).toContain('Agent hooks: Out of date; run myco member provision --refresh.');
});

it('an empty Windsurf hooks file is no Myco registration and is never enrolled by refresh', async () => {
  provision('claude-code');
  provision('codex');
  const file = path.join(process.env.HOME!, '.codeium', 'windsurf', 'hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
  expect(member.memberHarnessStatus('windsurf', home, SERVER).current).toBe(false);
  expect(member.managedMemberHarnesses(home, SERVER)).toEqual(['claude-code', 'codex']);
  const facts = await status();
  expect(facts.find(fact => fact.id === 'machine.agents')?.state).toBe('complete');
  expect(renderSetupStatus(facts)).toContain("Myco can't capture Windsurf or GitHub Copilot in this build.");
  expect(refresh()).toBe(true);
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code', 'codex']);
  expect(fs.readFileSync(file, 'utf8')).toBe('{}');
});

it('doctor and setup status warn once about a torn agent setup record with a recovery action', async () => {
  provision('claude-code');
  const file = provisionRecordPath(home);
  fs.writeFileSync(file, '{not json');
  const checks = setupChecks(home);
  expect(checks).toHaveLength(1);
  expect(checks[0]?.status).toBe('warn');
  expect(checks[0]?.detail).toContain(file);
  expect(checks[0]?.detail).toContain('Restore it from a backup or delete it, then run myco member provision --refresh.');
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await setup(['--status'], { mycoHome: home, cwd: scratch, agents: detected, stdout: line => lines.push(line), stderr: line => errors.push(line) });
  expect(errors).toEqual([]);
  expect(code).toBe(3);
  expect(lines.filter(line => line.includes(file))).toHaveLength(1);
  expect(lines.join('\n')).toContain('Restore it from a backup or delete it, then run myco member provision --refresh.');
  expect(fs.readFileSync(file, 'utf8')).toBe('{not json');
});

it('keep-current leaves a torn record alone and logs once until its readable state changes', () => {
  provision('claude-code');
  const file = provisionRecordPath(home);
  fs.writeFileSync(file, '{not json');
  const errors: string[] = [];
  const log = spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
  try {
    expect(keepCurrent(home)).toBeNull();
    expect(keepCurrent(home)).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(file);
    recordProvision(home, { version: getPluginVersion(), serverUrl: SERVER, agents: ['claude-code'] });
    expect(keepCurrent(home, { binaryFound: () => true })?.harnesses.map(fact => fact.id)).toEqual(['claude-code']);
    fs.writeFileSync(file, '{not json');
    expect(keepCurrent(home)).toBeNull();
    expect(errors).toHaveLength(2);
    expect(fs.readFileSync(file, 'utf8')).toBe('{not json');
  } finally { log.mockRestore(); }
});

for (const repair of ['refresh', 'provision', 'keep-current'] as const) it(`${repair} drops recorded uncapturable agents without judging or repairing them`, async () => {
  provision('claude-code');
  recordProvision(home, { version: getPluginVersion(), serverUrl: SERVER, agents: ['claude-code', 'windsurf', 'copilot', 'antigravity'] });
  const facts = await observeSetupStatus(home, { role: 'join', url: SERVER }, { agents: () => ['claude-code', 'antigravity', 'copilot', 'windsurf'], includeCapture: false });
  expect(facts.find(fact => fact.id === 'machine.agents')?.state).toBe('complete');
  const lines = renderSetupStatus(facts);
  expect(lines).toContain("Myco can't capture Google Antigravity, GitHub Copilot or Windsurf in this build.");
  expect(lines.filter(line => /Antigravity|GitHub Copilot|Windsurf/.test(line))).toHaveLength(1);
  expect(lines.join('\n')).not.toContain('Out of date');
  expect(setupChecks(home).every(check => check.status === 'ok')).toBe(true);
  expect(setupChecks(home).map(check => check.detail).join('\n')).not.toMatch(/Windsurf|Copilot|Antigravity/);
  if (repair === 'refresh') {
    let ids: string[] | undefined;
    expect(member.runProvision(['--refresh'], { mycoHome: home, cwd: scratch, stdout: () => {} }, result => { ids = result?.harnesses.map(fact => fact.id); })).toBe(true);
    expect(ids).toEqual(['claude-code']);
  } else if (repair === 'provision') expect(member.runProvision(['claude-code', '--server', SERVER], { mycoHome: home, cwd: scratch, stdout: () => {} })).toBe(true);
  else expect(keepCurrent(home, { binaryFound: () => true })?.harnesses.map(fact => fact.id)).toEqual(['claude-code']);
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code']);
});

it('read paths stay quiet and an installed agent offer respects a left Deployment conflict', async () => {
  const second = 'https://second.example';
  writeDeploymentMembership({ serverUrl: second, token: 'B'.repeat(43), machineId: 'second', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  provision('claude-code');
  member.provisionGlobally('codex', null, home, { serverUrl: second });
  omitCodex();
  fs.unlinkSync(deploymentPath(second, home));
  const errors: string[] = [];
  const log = spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
  try {
    const facts = await status();
    setupChecks(home);
    expect(errors).toEqual([]);
    expect(facts.find(fact => fact.id === 'machine.agents')?.state).toBe('complete');
    const lines = renderSetupStatus(facts).join('\n');
    expect(lines).toContain('second.example');
    expect(lines).toContain('myco login');
    expect(lines).not.toContain('Run myco member provision codex to add it');
  } finally { log.mockRestore(); }
});

it('healing re-reads choices and owned registrations after acquiring the repair lock', () => {
  provision('claude-code');
  provision('codex');
  const original = LifecycleLock.acquire;
  let removed = false;
  const acquire = spyOn(LifecycleLock, 'acquire').mockImplementation((file, opts) => {
    if (!removed && opts?.command === 'myco member reconcile') {
      removed = true;
      expect(member.runProvision(['codex', '--remove'], { mycoHome: home, cwd: scratch, stdout: () => {} })).toBe(true);
      expect(readProvisionRecord(home)?.agents).toEqual(['claude-code']);
    }
    return original(file, opts);
  });
  try {
    expect(member.runProvision(['claude-code', '--server', SERVER], { mycoHome: home, cwd: scratch, stdout: () => {} })).toBe(true);
    expect(removed).toBe(true);
  } finally { acquire.mockRestore(); }
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code']);
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses.map(fact => fact.id)).toEqual(['claude-code']);
  expect(fs.existsSync(path.join(process.env.CODEX_HOME!, 'hooks.json'))).toBe(false);
});

const children = new Set<ChildProcess>();
const fixture = path.join(import.meta.dir, 'fixtures/repair-lease.ts');
function repairChild(mode: string, signal: string) {
  const child = spawn(process.execPath, ['--tsconfig-override', path.resolve('tsconfig.json'), fixture, mode, home, signal], {
    cwd: scratch, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout!.on('data', data => { output += String(data); });
  child.stderr!.on('data', data => { output += String(data); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { children.delete(child); resolve(code); });
  });
  return { child, exited, output: () => output };
}
async function helperLease() {
  const signal = path.join(scratch, 'release-helper');
  const holder = repairChild('hold', signal);
  await new Promise<void>((resolve, reject) => {
    holder.child.stdout!.on('data', data => { if (String(data).includes('READY')) resolve(); });
    holder.exited.then(() => reject(new Error('fixture helper exited before readiness')), reject);
  });
  const acquire = LifecycleLock.acquire;
  const watch = spyOn(LifecycleLock, 'acquire').mockImplementation((file, opts) => {
    if (opts?.command === 'myco member provision') fs.writeFileSync(signal, 'release');
    return acquire(file, opts);
  });
  return { ...holder, signal, watch };
}

for (const operation of ['named', 'batch', 'join', 'healing'] as const) it(operation + ' provision completes before a concurrent remove, which stays removed', async () => {
  provision('claude-code');
  provision('codex');
  let removal: ReturnType<typeof repairChild> | undefined;
  const signal = path.join(scratch, 'remove-requested');
  const beginRemoval = () => {
    if (removal) return;
    removal = repairChild('remove', signal);
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(signal) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    expect(fs.existsSync(signal)).toBe(true);
    expect(JSON.parse(fs.readFileSync(signal, 'utf8'))).toEqual({ wait: true });
    expect(readProvisionRecord(home)?.agents).toContain('codex');
  };
  const originalWrite = recordModule.recordProvision;
  const originalReconcile = recordModule.reconcileProvisionAgents;
  const write = operation === 'healing'
    ? spyOn(recordModule, 'reconcileProvisionAgents').mockImplementation((h, record) => {
      beginRemoval();
      return originalReconcile(h, record);
    })
    : spyOn(recordModule, 'recordProvision').mockImplementation((h, record, opts) => {
      if (record.agents.length === 1 && record.agents[0] === 'claude-code') beginRemoval();
      return originalWrite(h, record, opts);
    });
  try {
    if (operation === 'join') {
      const root = path.join(scratch, 'repo');
      fs.mkdirSync(root);
      execFileSync('git', ['init', '-q', root]);
      expect(await member.runJoin([SERVER, '--project', 'proj_fixture', '--token-env', 'JOIN_TOKEN', '--provision', 'claude-code', '--no-worker'], {
        mycoHome: home, cwd: root, env: { JOIN_TOKEN: 'A'.repeat(43) },
        fetch: async () => Response.json({ ok: true, blocks: [], settings: {} }), stdout: () => {}, stderr: () => {},
      })).not.toBeNull();
    } else expect(member.runProvision([...(operation === 'batch' ? [] : ['claude-code']), '--server', SERVER], { mycoHome: home, cwd: scratch, agents: () => ['claude-code'], stdout: () => {} })).toBe(true);
  } finally { write.mockRestore(); }
  expect(removal).toBeDefined();
  expect(await removal!.exited, removal!.output()).toBe(0);
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code']);
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses.map(fact => fact.id)).toEqual(['claude-code']);
  expect(fs.existsSync(path.join(process.env.CODEX_HOME!, 'hooks.json'))).toBe(false);
});

for (const operation of ['guided setup', 'login'] as const) it(operation + ' waits for a helper lease and sets up the detected agents', async () => {
  const root = path.join(scratch, 'repo');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  writeRegistryEntry({ version: 2, root, projectId: 'proj_fixture', serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  const holder = await helperLease();
  const lines: string[] = [];
  const errors: string[] = [];
  try {
    if (operation === 'guided setup') {
      const fetchImpl = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
        const route = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (route === '/health') return Response.json({ ok: true });
        if (route === '/auth/login') return new Response(null, { status: 302, headers: { location: 'https://github.com/login/oauth/authorize?client_id=fixture&redirect_uri=' + encodeURIComponent(SERVER + '/auth/callback') } });
        if (route === '/members/status') return Response.json({ target: 'fixture' });
        throw new Error('unexpected route ' + route);
      }, { preconnect: () => {} });
      expect(await setup(['--join', SERVER, '--yes', '--no-runner'], {
        mycoHome: home, cwd: root, ask: async () => null, fetch: fetchImpl, agents: () => ['claude-code', 'codex'],
        stdout: line => lines.push(line), stderr: line => errors.push(line),
      }), errors.join('\n')).toBe(0);
    } else {
      const rig = unjoinedRig();
      const authority = await issueEnrollmentAuthority(rig.env.db, Date.now(), { issuer: { kind: 'operator' }, role: 'member' });
      expect(await login(['https://s/join#' + authority.key], {
        mycoHome: home, cwd: scratch, machineId: 'fixture', fetch: Object.assign(rig.fetch, { preconnect: () => {} }), agents: () => ['claude-code', 'codex'],
        stdout: line => lines.push(line), stderr: line => errors.push(line),
      })).toBe(true);
    }
    expect(errors).toEqual([]);
    expect(lines.join('\n')).toContain('Capture is set up for Claude Code, Codex.');
    expect(readProvisionRecord(home)?.agents).toEqual(['claude-code', 'codex']);
  } finally {
    holder.watch.mockRestore();
    fs.writeFileSync(holder.signal, 'release');
    expect(await holder.exited, holder.output()).toBe(0);
  }
});

it('healing keeps a hook-trust prompt settled during its registration scan settled', () => {
  provision('claude-code');
  provision('codex');
  recordModule.holdHookTrust(home, 'codex', 'Restart Codex and trust its hooks');
  const pending = readProvisionRecord(home)?.pendingTrust;
  const original = SymbiontInstaller.prototype.memberRegistrationPresent;
  let settled = false;
  const scan = spyOn(SymbiontInstaller.prototype, 'memberRegistrationPresent').mockImplementation(function (this: SymbiontInstaller, ...args) {
    if (!settled) {
      settled = true;
      recordModule.settleHookTrust(home, pending);
      expect(readProvisionRecord(home)?.pendingTrust?.codex).toBeUndefined();
    }
    return original.apply(this, args);
  });
  try {
    const result = keepCurrent(home, { binaryFound: () => true });
    expect(settled).toBe(true);
    expect(readProvisionRecord(home)?.pendingTrust?.codex).toBeUndefined();
    expect(result?.harnesses.find(fact => fact.id === 'codex')?.state).toBe('ready');
  } finally { scan.mockRestore(); }
});

it('keep-current replaces an unreadable diagnostic state without failing or repeating its warning', () => {
  provision('claude-code');
  const file = path.join(home, 'member', 'provision-problem.json');
  fs.writeFileSync(file, '{not json');
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses.map(fact => fact.id)).toEqual(['claude-code']);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toBeNull();
  fs.writeFileSync(file, '{not json');
  fs.writeFileSync(provisionRecordPath(home), '{not json');
  const errors: string[] = [];
  const log = spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
  try {
    expect(keepCurrent(home)).toBeNull();
    expect(keepCurrent(home)).toBeNull();
    expect(errors).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toContain('Restore it from a backup or delete it');
  } finally { log.mockRestore(); }
});

it('keep-current stays non-blocking while a helper holds the lease', async () => {
  provision('claude-code');
  const holder = await helperLease();
  try {
    expect(keepCurrent(home, { binaryFound: () => true })).toBeNull();
    expect(holder.watch.mock.calls.at(-1)?.[1]?.wait).not.toBe(true);
    expect(holder.child.exitCode).toBeNull();
  } finally {
    holder.watch.mockRestore();
    fs.writeFileSync(holder.signal, 'release');
    expect(await holder.exited, holder.output()).toBe(0);
  }
});

it('person-run lease timeouts name the busy operation and retry without an ownership refusal', () => {
  provision('claude-code');
  const acquire = spyOn(LifecycleLock, 'acquire').mockReturnValue({ acquired: false, holder: null, holderPid: null });
  try {
    for (const args of [['claude-code', '--server', SERVER], ['--server', SERVER], ['--refresh']]) {
      expect(() => member.runProvision(args, { mycoHome: home, cwd: scratch, agents: () => ['claude-code'] })).toThrow("Myco is updating this machine's agents. Retry this command");
      expect(acquire.mock.calls.at(-1)?.[1]).toMatchObject({ wait: true, timeoutMs: 15_000 });
    }
    const errors: string[] = [];
    expect(member.runProvision(['claude-code', '--remove'], { mycoHome: home, cwd: scratch, stderr: line => errors.push(line) })).toBe(false);
    expect(errors.join('\n')).toContain('Retry this command');
    expect(errors.join('\n')).not.toContain('ownership');
    expect(keepCurrent(home)).toBeNull();
  } finally { acquire.mockRestore(); }
});

it('a later reconciliation timeout asks the person to retry their command', () => {
  provision('claude-code');
  const original = LifecycleLock.acquire;
  const acquire = spyOn(LifecycleLock, 'acquire').mockImplementation((file, opts) => opts?.command === 'myco member reconcile'
    ? { acquired: false, holder: null, holderPid: null } : original(file, opts));
  try {
    for (const args of [['claude-code', '--server', SERVER], ['--server', SERVER], ['--refresh']]) {
      expect(() => member.runProvision(args, { mycoHome: home, cwd: scratch, agents: () => ['claude-code'] })).toThrow("Myco is updating this machine's agents. Retry this command after the current update finishes.");
    }
  } finally { acquire.mockRestore(); }
});

it('unexpected registration inspection errors remain observable', async () => {
  provision('claude-code');
  const inspect = spyOn(SymbiontInstaller.prototype, 'memberRegistrationPresent').mockImplementation(() => { throw new Error('fixture inspection failure'); });
  try {
    expect(() => member.managedMemberHarnesses(home, SERVER)).toThrow('fixture inspection failure');
    expect((await status()).find(fact => fact.id === 'machine.agents')).toMatchObject({ state: 'unavailable', detail: 'fixture inspection failure' });
  } finally { inspect.mockRestore(); }
});

it('refresh names the --server remedy for ambiguous joined Deployments without guessing', () => {
  provision('claude-code');
  fs.unlinkSync(provisionRecordPath(home));
  writeDeploymentMembership({ serverUrl: 'https://second.example', token: 'B'.repeat(43), machineId: 'second', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  const errors: string[] = [];
  expect(member.runProvision(['--refresh'], { mycoHome: home, cwd: scratch, stdout: () => {}, stderr: line => errors.push(line) })).toBe(false);
  expect(errors.join('\n')).toContain('name one with --server');
  expect(errors.join('\n')).not.toContain('has not set up');
  expect(readProvisionRecord(home)).toBeNull();
  expect(keepCurrent(home)).toBeNull();
});

for (const repair of ['refresh', 'keep-current'] as const) it(`${repair} recovers owned registrations without a provision record or Default Deployment`, async () => {
  provision('claude-code');
  fs.unlinkSync(provisionRecordPath(home));
  expect(setupChecks(home)).toContainEqual(expect.objectContaining({ status: 'ok', detail: expect.stringContaining('claude-code set up by this build') }));
  expect((await status()).find(fact => fact.id === 'machine.agents')?.state).toBe('complete');
  expect(readProvisionRecord(home)).toBeNull();
  if (repair === 'refresh') expect(refresh()).toBe(true);
  else expect(keepCurrent(home, { binaryFound: () => true })?.harnesses.map(fact => fact.id)).toEqual(['claude-code']);
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code']);
});

it('refresh with --server recovers an owned registration among several joined Deployments', () => {
  provision('claude-code');
  fs.unlinkSync(provisionRecordPath(home));
  writeDeploymentMembership({ serverUrl: 'https://second.example', token: 'B'.repeat(43), machineId: 'second', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  expect(member.runProvision(['--refresh', '--server', SERVER], { mycoHome: home, cwd: scratch, stdout: () => {} })).toBe(true);
  expect(readProvisionRecord(home)).toMatchObject({ serverUrl: SERVER, agents: ['claude-code'] });
});

for (const missingHooks of [false, true]) it(`manages unrecorded ${missingHooks ? 'deleted' : 'current'} capture while its tools remain on another joined Deployment`, async () => {
  const second = 'https://second.example';
  writeDeploymentMembership({ serverUrl: second, token: 'B'.repeat(43), machineId: 'second', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  provision('claude-code');
  expect(member.provisionGlobally('codex', null, home, { serverUrl: second })).toMatchObject({ kind: 'provisioned' });
  omitCodex();
  if (missingHooks) fs.unlinkSync(path.join(process.env.CODEX_HOME!, 'hooks.json'));
  const file = path.join(process.env.CODEX_HOME!, 'config.toml');
  const before = fs.readFileSync(file, 'utf8');
  expect(member.memberHarnessStatus('codex', home, SERVER)).toMatchObject({ current: !missingHooks, toolsDeployment: second });
  expect(member.managedMemberHarnesses(home, SERVER)).toEqual(['claude-code', 'codex']);
  expect((await status()).find(fact => fact.id === 'machine.agents')?.state).toBe(missingHooks ? 'incomplete' : 'complete');
  expect(setupChecks(home)).toContainEqual(expect.objectContaining({ status: missingHooks ? 'warn' : 'ok', toolsDeployment: second }));
  expect(refresh()).toBe(true);
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code', 'codex']);
  expect(member.memberHarnessStatus('codex', home, SERVER).current).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
});

for (const repair of ['refresh', 'provision', 'keep-current'] as const) it(`${repair} records surviving current Codex capture without choosing Copilot`, async () => {
  provision('claude-code');
  expect(provision('codex')).toMatchObject({ kind: 'provisioned' });
  expect(member.memberHarnessStatus('codex', home, SERVER).current).toBe(true);
  omitCodex();
  const before = fs.readFileSync(provisionRecordPath(home), 'utf8');
  expect(member.managedMemberHarnesses(home, SERVER)).toEqual(['claude-code', 'codex']);
  const facts = await status();
  expect(facts.find(fact => fact.id === 'machine.agents')?.state).toBe('complete');
  expect(renderSetupStatus(facts).join('\n')).not.toContain('Codex is installed;');
  expect(setupChecks(home)).toContainEqual(expect.objectContaining({ status: 'ok', detail: expect.stringContaining('claude-code, codex set up by this build') }));
  expect(fs.readFileSync(provisionRecordPath(home), 'utf8')).toBe(before);
  if (repair === 'refresh') expect(refresh()).toBe(true);
  else if (repair === 'provision') expect(member.runProvision(['claude-code', '--server', SERVER], { mycoHome: home, cwd: scratch, stdout: () => {} })).toBe(true);
  else expect(keepCurrent(home, { binaryFound: () => true })?.harnesses.map(fact => fact.id)).toEqual(['claude-code', 'codex']);
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code', 'codex']);
});

it('status, doctor, refresh and keep-current consume the shared agent-set function', async () => {
  provision('claude-code');
  provision('codex');
  const shared = spyOn(member, 'managedMemberHarnesses').mockReturnValue(['claude-code']);
  try {
    const facts = await status();
    expect(shared).toHaveBeenCalled();
    expect(facts.find(fact => fact.id === 'machine.agents')?.agentOffers).toContain("Codex is installed; Myco doesn't capture it yet. Run myco member provision codex to add it.");
    shared.mockClear();
    expect(setupChecks(home).map(check => check.detail).join('\n')).toContain('claude-code set up by this build');
    expect(shared).toHaveBeenCalled();
    shared.mockClear();
    expect(keepCurrent(home, { binaryFound: () => true })?.harnesses.map(fact => fact.id)).toEqual(['claude-code']);
    expect(shared).toHaveBeenCalled();
    shared.mockClear();
    let ids: string[] | undefined;
    member.runProvision(['--refresh'], { mycoHome: home, cwd: scratch, stdout: () => {} }, result => { ids = result?.harnesses.map(fact => fact.id); });
    expect(ids).toEqual(['claude-code']);
    expect(shared).toHaveBeenCalled();
  } finally { shared.mockRestore(); }
});

for (const role of ['join', 'create'] as const) it(`${role} guided setup still judges detected agents beyond current chosen agents`, async () => {
  provision('claude-code');
  const facts = await observeSetup(home, { role, url: SERVER }, { agents: detected, includeCapture: false });
  expect(facts.find(fact => fact.id === 'machine.agents')).toMatchObject({ state: 'incomplete', detail: 'stale' });
  expect(facts.find(fact => fact.id === 'machine.agents')?.agentOffers).toBeUndefined();
});

for (const role of ['join', 'create'] as const) it(`${role} first-run journey sets up the detected agents`, async () => {
  const root = path.join(scratch, 'repo');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  const lines: string[] = [];
  const errors: string[] = [];
  const server = role === 'create' ? ownerDeployment(scratch, home, 'cloudflare') : undefined;
  if (role === 'join') writeRegistryEntry({ version: 2, root, projectId: 'proj_fixture', serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  const fetchImpl = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const route = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (route === '/health') return Response.json({ ok: true });
    if (route === '/auth/login') return new Response(null, { status: 302, headers: { location: `https://github.com/login/oauth/authorize?client_id=fixture&redirect_uri=${encodeURIComponent(`${SERVER}/auth/callback`)}` } });
    if (route === '/members/status') return Response.json({ target: 'fixture' });
    throw new Error(`unexpected route ${route}`);
  }, { preconnect: () => {} });
  try {
    const args = role === 'join' ? ['--join', SERVER] : ['--create', 'cloudflare', '--account-id', ACCOUNT, '--new', 'Fixture'];
    const code = await setup([...args, '--yes', '--no-runner'], {
      mycoHome: home, cwd: root, ask: async () => null, sleep: async () => {}, fetch: fetchImpl,
      ...server?.deps, agents: () => ['claude-code', 'codex'],
      stdout: line => lines.push(line), stderr: line => errors.push(line),
    });
    expect({ code, errors }).toEqual({ code: 0, errors: [] });
    expect(lines.join('\n')).toContain('Capture is set up for Claude Code, Codex.');
    expect(readProvisionRecord(home)?.agents).toEqual(['claude-code', 'codex']);
  } finally { await server?.close(); }
});
