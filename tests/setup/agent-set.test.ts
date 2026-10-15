import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as member from '@myco/cli/member.js';
import { setupChecks } from '@myco/cli/member-doctor.js';
import { keepCurrent } from '@myco/cli/member-keep-current.js';
import { renderSetupStatus } from '@myco/cli/setup-status.js';
import { observeSetup, observeSetupStatus } from '@myco/setup/observe.js';
import { run as setup } from '@myco/cli/setup.js';
import { recordProvision, readProvisionRecord, provisionRecordPath } from '@myco/symbionts/member-provision-record.js';
import { writeDeploymentMembership, writeRegistryEntry } from '@myco/member/registry.js';
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
afterEach(() => {
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
  for (const name of ['Windsurf', 'GitHub Copilot']) {
    expect(lines).toContain(`${name} is installed; Myco doesn't capture it yet. Capture support is not available in this build.`);
  }
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
  expect(renderSetupStatus(facts)).toContain("Windsurf is installed; Myco doesn't capture it yet. Capture support is not available in this build.");
  expect(refresh()).toBe(true);
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code', 'codex']);
  expect(fs.readFileSync(file, 'utf8')).toBe('{}');
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
