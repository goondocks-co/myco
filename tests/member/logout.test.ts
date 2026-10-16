import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindSandboxChildHome, sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { logoutJournalPath } from '@myco/member/logout.js';
import { logoutDeployment, type LogoutRuntimeDeps } from '@myco/symbionts/logout-runtime.js';
import { run as logoutCli } from '@myco/cli/logout.js';
import { keepCurrent } from '@myco/cli/member-keep-current.js';
import { provisionGlobally, provisionAgents, run as memberCli } from '@myco/cli/member.js';
import {
  deploymentPath, deploymentFeaturesPath, machineSettingsPath, registryEntryPath, readDeploymentMembership, readRegistryEntry,
  writeDeploymentMembership, writeRegistryEntry,
} from '@myco/member/registry.js';
import { defaultDeploymentPath, readDefaultDeployment, recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { MemberSpool } from '@myco/member/spool.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { provisionRecordPath, readProvisionRecord, recordProvision } from '@myco/symbionts/member-provision-record.js';
import { runnerRecordPath } from '@myco/runner/runner-registry.js';
import { executorServiceTarget } from '@myco/cli/worker-service.js';
import { installWorkerService } from '@myco/runner/service.js';
import { recordingPlatform } from '../helpers/fake-service-manager.js';
import { memberRig } from './helpers/server.js';
import { ROUTES } from '@myco-server-worker/routes.js';
import { autoJoinHold, LEFT_ALONE } from '@myco/member/auto-join-hook.js';
import { rootKeyFor, isLeft, markLeft, listJoinRequests } from '@myco/member/auto-join.js';
import { cacheMachineSettings } from '@myco/member/machine-settings.js';
import { pendingSpool } from '@myco/member/pending.js';
import { reconcileProvisionDeployment } from '@myco/symbionts/member-provision-record.js';
import { execFileSync } from 'node:child_process';

const A = 'https://personal.example';
const B = 'https://work.example';
const C = 'https://third.example';
const PKG = path.resolve(import.meta.dir, '../../packages/myco');
let root: string;
let home: string;
let mycoHome: string;
let restore: () => void;
let requests: Request[];
let deps: LogoutRuntimeDeps;

const claude = () => loadManifests().find((m) => m.name === 'claude-code')!;
const globalInstaller = (url: string) => new SymbiontInstaller(claude(), mycoHome, PKG, false, mycoHome).withoutProjectRoot().forDeployment(url);
function join(url: string, project?: string): string | null {
  const membership = { serverUrl: url, token: `${url}-secret`, machineId: 'machine_test', joinedAt: 1, updatedAt: 1 };
  if (project === undefined) { writeDeploymentMembership(membership, { mycoHome }); return null; }
  const folder = path.join(root, project);
  fs.mkdirSync(folder, { recursive: true });
  writeRegistryEntry({ ...membership, version: 2, projectId: project, root: folder }, { mycoHome });
  return folder;
}
function spool(url: string, projectId: string): string {
  const held = new MemberSpool({ serverUrl: url, projectId }, { mycoHome });
  fs.writeFileSync(path.join(held.dir, 'session_pending.jsonl'), '{"retained":"capture"}\n');
  return held.dir;
}
function bytes(file: string): Buffer { return fs.readFileSync(file); }
function tree(dir: string): Record<string, string> {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
    const file = path.join(e.parentPath, e.name);
    return [path.relative(dir, file), bytes(file).toString('base64')];
  }));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-logout-'));
  home = path.join(root, 'home');
  mycoHome = path.join(home, '.myco');
  fs.mkdirSync(mycoHome, { recursive: true });
  restore = bindSandboxChildHome(root, { HOME: home, MYCO_HOME: mycoHome });
  requests = [];
  deps = { home, mycoHome, packageRoot: PKG, worker: { platform: 'darwin', runner: recordingPlatform().runner }, fetch: async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ persisted: true, revoked: 1 });
  } };
});
afterEach(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });

describe('Deployment-scoped logout', () => {
  for (const agent of ['codex', 'claude-code']) it(`fails ${agent} MCP deletion after visiting every manifest and retains retry ownership`, async () => {
    join(A);
    const manifests = loadManifests();
    const installers = manifests.map(manifest => new SymbiontInstaller(manifest, mycoHome, PKG, false, mycoHome).withoutProjectRoot().forDeployment(A));
    for (const installer of installers) installer.install();
    const failed = installers[manifests.findIndex(manifest => manifest.name === agent)];
    const file = failed.memberGlobalTargets().mcp[0];
    if (agent === 'codex') {
      const raw = fs.readFileSync(file, 'utf8');
      const section = raw.indexOf('[mcp_servers.myco]');
      expect(section).toBeGreaterThanOrEqual(0);
      fs.writeFileSync(file, raw.slice(section));
    }
    const before = bytes(file);
    const failure = Object.assign(new Error(`Could not delete ${file}`), { code: 'EPERM' });
    const unlink = fs.unlinkSync;
    const deletion = spyOn(fs, 'unlinkSync').mockImplementation(target => {
      if (target === file) throw failure;
      return unlink(target);
    });
    const visits = spyOn(SymbiontInstaller.prototype, 'reconcileDeploymentLogout');
    try {
      await expect(logoutDeployment(A, { mode: 'revoke' }, deps)).rejects.toBe(failure);
      expect(visits).toHaveBeenCalledTimes(manifests.length);
      expect(bytes(file)).toEqual(before);
      expect(readProvisionRecord(mycoHome)).toMatchObject({ agents: [agent], pendingLogout: { [agent]: [A] } });
      expect(JSON.parse(fs.readFileSync(logoutJournalPath(A, mycoHome), 'utf8')).phase).toBe('config');
      for (const [index, installer] of installers.entries()) if (manifests[index].name !== agent) expect(installer.inspectMemberHooks().member).toBe(false);
    } finally { visits.mockRestore(); deletion.mockRestore(); }
    expect((await logoutDeployment(A, { mode: 'revoke' }, deps)).unreconciledAgents).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(readProvisionRecord(mycoHome)).toBeNull();
    expect(requests).toHaveLength(1);
  });

  for (const first of [A, B]) it(`retains both pending logouts for one agent until both retries complete (${first} first)`, async () => {
    join(A); join(B);
    recordDefaultDeployment(A, { mycoHome });
    globalInstaller(A).install();
    const file = globalInstaller(A).memberGlobalTargets().mcp[0];
    const clean = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '\ufeff' + clean);
    for (const url of [A, B]) expect((await logoutDeployment(url, { mode: 'revoke' }, deps)).unreconciledAgents).toHaveLength(1);
    expect(readProvisionRecord(mycoHome)?.pendingLogout).toEqual({ 'claude-code': [A, B] });
    fs.writeFileSync(file, clean);
    const second = first === A ? B : A;
    expect((await logoutDeployment(first, { mode: 'revoke' }, deps)).unreconciledAgents).toEqual([]);
    expect(readProvisionRecord(mycoHome)).toMatchObject({ agents: ['claude-code'], pendingLogout: { 'claude-code': [second] } });
    expect(fs.existsSync(logoutJournalPath(first, mycoHome))).toBe(false);
    expect(fs.existsSync(logoutJournalPath(second, mycoHome))).toBe(true);
    expect((await logoutDeployment(second, { mode: 'revoke' }, deps)).unreconciledAgents).toEqual([]);
    expect(readProvisionRecord(mycoHome)).toBeNull();
    expect(fs.existsSync(logoutJournalPath(second, mycoHome))).toBe(false);
    expect(globalInstaller(A).inspectMemberMcp().some(entry => entry.present)).toBe(false);
    expect(requests).toHaveLength(2);
  });

  for (const agent of ['copilot', 'cursor']) it(`keeps repeated retired-settings refusals retryable for ${agent}`, async () => {
    join(A);
    globalInstaller(A).install();
    const installer = new SymbiontInstaller(loadManifests().find(manifest => manifest.name === agent)!, mycoHome, PKG, false, mycoHome).withoutProjectRoot().forDeployment(A);
    installer.install();
    const file = installer.memberGlobalTargets().hooks!;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const raw = '{"user":1,"user":2,"chat.tools.terminal.autoApprove":{"myco":true,"myco-dev":true}}';
    fs.writeFileSync(file, raw);
    recordProvision(mycoHome, { version: 'test', serverUrl: A, agents: ['claude-code', agent] });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(installer.reconcileRetiredHookSettings()).toBeNull();
      warn.mockClear();
      for (let attempt = 0; attempt < 2; attempt++) {
        const err: string[] = [];
        expect(await logoutCli([A], { ...deps, stdout: () => {}, stderr: line => err.push(line) })).toBe(false);
        expect(err.filter(line => line.includes(file))).toHaveLength(1);
        expect(err.join('\n')).toContain('nothing was written there');
        expect(readProvisionRecord(mycoHome)).toMatchObject({ agents: [agent], pendingLogout: { [agent]: [A] } });
        expect(JSON.parse(fs.readFileSync(logoutJournalPath(A, mycoHome), 'utf8')).phase).toBe('config');
        expect(fs.readFileSync(file, 'utf8')).toBe(raw);
      }
      expect(warn).not.toHaveBeenCalled();
      fs.writeFileSync(file, '{"user":1}');
      expect(await logoutCli([A], { ...deps, stdout: () => {}, stderr: () => {} })).toBe(true);
      expect(readProvisionRecord(mycoHome)).toBeNull();
      expect(requests).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });

  it('keeps a joined Deployment provision record after retry with multiple survivors and no default', async () => {
    join(A); join(B); join(C);
    recordDefaultDeployment(A, { mycoHome });
    globalInstaller(B).install();
    const binaries = { 'claude-code': path.join(mycoHome, 'bin', 'myco') };
    const pendingTrust = { 'claude-code': { action: 'review', at: 1 } };
    recordProvision(mycoHome, { version: 'test', serverUrl: B, agents: ['claude-code'], binaries, pendingTrust }, { replace: true });
    const file = globalInstaller(B).memberGlobalTargets().mcp[0];
    const clean = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '\ufeff' + clean);
    expect((await logoutDeployment(A, { mode: 'revoke' }, deps)).unreconciledAgents).toHaveLength(1);
    expect(readDefaultDeployment(mycoHome)).toBeNull();
    fs.writeFileSync(file, clean);
    expect((await logoutDeployment(A, { mode: 'revoke' }, deps)).unreconciledAgents).toEqual([]);
    expect(readProvisionRecord(mycoHome)).toMatchObject({ serverUrl: B, agents: ['claude-code'], binaries, pendingTrust });
    expect(readProvisionRecord(mycoHome)?.pendingLogout).toBeUndefined();
    expect(readDeploymentMembership(B, mycoHome)).not.toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toContain(B);
    expect(keepCurrent(mycoHome, { packageRoot: PKG, binaryFound: () => true })?.serverUrl).toBe(B);
    expect(requests).toHaveLength(1);
  });

  for (const repair of ['keep-current', 'keep-current without binary', 'refresh', 'provision', 'detected provision']) it(`holds ${repair} until the last Deployment logout finishes`, async () => {
    join(A);
    globalInstaller(A).install();
    const file = globalInstaller(A).memberGlobalTargets().hooks!;
    const clean = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '\ufeff' + clean);
    expect((await logoutDeployment(A, { mode: 'revoke' }, deps)).unreconciledAgents.map(({ agent }) => agent)).toEqual(['claude-code']);
    fs.unlinkSync(file);
    const before = tree(home);
    const messages: string[] = [];
    const stderr = spyOn(process.stderr, 'write').mockImplementation(chunk => { messages.push(String(chunk)); return true; });
    const warn = spyOn(console, 'warn').mockImplementation(message => { messages.push(String(message)); });
    try {
      if (repair.startsWith('keep-current')) {
        const result = keepCurrent(mycoHome, { packageRoot: PKG, binaryFound: () => repair === 'keep-current' });
        expect(result?.harnesses).toEqual([expect.objectContaining({ id: 'claude-code', state: 'repair_failed', action: expect.stringContaining('waiting for') })]);
        expect(result?.ready).toEqual([]);
      } else if (repair === 'refresh') {
        await memberCli(['provision', '--refresh'], { mycoHome, packageRoot: PKG, cwd: root, stdout: message => messages.push(message), stderr: message => messages.push(message) });
      } else if (repair === 'provision') {
        const outcome = provisionGlobally('claude-code', null, mycoHome, { packageRoot: PKG, serverUrl: A });
        expect(outcome.kind).toBe('refused');
        if (outcome.kind === 'refused') messages.push(outcome.detail);
      } else {
        const outcome = provisionAgents(['claude-code'], mycoHome, A, null, { packageRoot: PKG });
        expect(outcome.skipped).toHaveLength(1);
        messages.push(outcome.skipped[0].reason);
      }
      expect(messages.join('\n')).toContain('waiting for `myco logout ' + A + '` to finish');
      expect(fs.existsSync(file)).toBe(false);
      const after = tree(home);
      for (const [name, contents] of Object.entries(before)) if (!name.startsWith('.myco/')) expect(after[name]).toBe(contents);
      expect(Object.keys(after).filter(name => !name.startsWith('.myco/'))).toEqual(Object.keys(before).filter(name => !name.startsWith('.myco/')));
      expect(readProvisionRecord(mycoHome)).toMatchObject({ serverUrl: A, pendingLogout: { 'claude-code': [A] } });
    } finally { stderr.mockRestore(); warn.mockRestore(); }
    expect((await logoutDeployment(A, { mode: 'revoke' }, deps)).unreconciledAgents).toEqual([]);
    expect(readProvisionRecord(mycoHome)).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it('reports a typed file refusal before an unexpected logout error', async () => {
    join(A);
    const manifests = loadManifests();
    const installers = manifests.map(manifest => new SymbiontInstaller(manifest, mycoHome, PKG, false, mycoHome).withoutProjectRoot().forDeployment(A));
    for (const installer of installers) installer.install();
    const file = installers[manifests.findIndex(manifest => manifest.name === 'copilot')].memberGlobalTargets().hooks!;
    recordProvision(mycoHome, { version: 'test', serverUrl: A, agents: manifests.map(manifest => manifest.name) });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '\ufeff{"user":true}');
    const original = SymbiontInstaller.prototype.reconcileDeploymentLogout;
    const unexpected = new TypeError('unexpected mixed logout bug');
    const visit = spyOn(SymbiontInstaller.prototype, 'reconcileDeploymentLogout').mockImplementation(function(this: SymbiontInstaller, ...args) {
      if (this.memberGlobalTargets().hooks === globalInstaller(A).memberGlobalTargets().hooks) throw unexpected;
      return original.apply(this, args);
    });
    const messages: string[] = [];
    try {
      expect(await logoutCli([A], { ...deps, stdout: () => {}, stderr: message => messages.push(message) })).toBe(false);
      expect(visit).toHaveBeenCalledTimes(manifests.length);
      expect(messages.filter(message => message.includes(file))).toHaveLength(1);
      expect(messages[0]).toContain(file);
      expect(messages[0]).toContain('nothing was written there');
      expect(messages.at(-1)).toBe('myco logout: unexpected mixed logout bug');
      expect(readProvisionRecord(mycoHome)?.agents).toEqual(['claude-code', 'copilot']);
    } finally { visit.mockRestore(); }
  });

  it('reports a typed file refusal before an unexpected provision-record write error', async () => {
    join(A);
    const copilot = new SymbiontInstaller(loadManifests().find(manifest => manifest.name === 'copilot')!, mycoHome, PKG, false, mycoHome).withoutProjectRoot().forDeployment(A);
    globalInstaller(A).install();
    recordProvision(mycoHome, { version: 'test', serverUrl: A, agents: ['claude-code', 'copilot'] });
    const file = copilot.memberGlobalTargets().hooks!;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '\ufeff{"user":true}');
    const original = fs.renameSync;
    const failure = Object.assign(new Error('cannot save provision record'), { code: 'EPERM' });
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === provisionRecordPath(mycoHome)) throw failure;
      original(from, to);
    });
    const messages: string[] = [];
    try {
      expect(await logoutCli([A], { ...deps, stdout: () => {}, stderr: message => messages.push(message) })).toBe(false);
      expect(messages.filter(message => message.includes(file))).toHaveLength(1);
      expect(messages[0]).toContain(file);
      expect(messages.at(-1)).toBe('myco logout: cannot save provision record');
      expect(fs.readFileSync(file, 'utf8')).toBe('\ufeff{"user":true}');
      expect(fs.existsSync(logoutJournalPath(A, mycoHome))).toBe(true);
    } finally { rename.mockRestore(); }
  });

  it('records the failed agent leaving destination beside the surviving default and clears it on retry', async () => {
    join(A); join(B);
    recordDefaultDeployment(A, { mycoHome });
    globalInstaller(A).install();
    const cursor = new SymbiontInstaller(loadManifests().find(manifest => manifest.name === 'cursor')!, mycoHome, PKG, false, mycoHome).withoutProjectRoot().forDeployment(A);
    cursor.install();
    const file = globalInstaller(A).memberGlobalTargets().mcp[0];
    const clean = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '\ufeff' + clean);
    const partial = await logoutDeployment(A, { mode: 'revoke' }, deps);
    expect(partial.unreconciledAgents).toEqual([{ agent: 'claude-code', reason: expect.stringContaining(file) }]);
    expect(readProvisionRecord(mycoHome)).toMatchObject({ serverUrl: B, agents: expect.arrayContaining(['claude-code', 'cursor']), pendingLogout: { 'claude-code': [A] } });
    expect(fs.readFileSync(file, 'utf8')).toBe('\ufeff' + clean);
    expect(cursor.inspectMemberMcp()[0].present).toBe(true);
    fs.writeFileSync(file, clean);
    expect((await logoutDeployment(A, { mode: 'revoke' }, deps)).unreconciledAgents).toEqual([]);
    expect(readProvisionRecord(mycoHome)?.serverUrl).toBe(B);
    expect(readProvisionRecord(mycoHome)?.pendingLogout).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toContain(B);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(A);
    expect(requests).toHaveLength(1);
  });

  for (const agent of ['copilot', 'cursor']) it(`finishes other agents and returns a retryable partial logout for BOM ${agent} hooks`, async () => {
    join(A);
    const manifests = loadManifests();
    const installers = manifests.map(manifest => new SymbiontInstaller(manifest, mycoHome, PKG, false, mycoHome).withoutProjectRoot().forDeployment(A));
    for (const installer of installers) installer.install();
    const failed = installers[manifests.findIndex(manifest => manifest.name === agent)];
    const file = failed.memberGlobalTargets().hooks!;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const clean = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{"user":true}';
    fs.writeFileSync(file, '\ufeff' + clean);
    const before = bytes(file);
    const binaries = Object.fromEntries(manifests.map(manifest => [manifest.name, path.join(mycoHome, 'bin', 'myco')]));
    const pendingTrust = Object.fromEntries(manifests.map(manifest => [manifest.name, { action: 'review', at: 1 }]));
    recordProvision(mycoHome, { version: 'test', serverUrl: A, agents: manifests.map(manifest => manifest.name), binaries, pendingTrust });
    const visits = spyOn(SymbiontInstaller.prototype, 'reconcileDeploymentLogout');
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    const out: string[] = [];
    const err: string[] = [];
    try {
      expect(await logoutCli([A], { ...deps, stdout: line => out.push(line), stderr: line => err.push(line) })).toBe(false);
      expect(visits).toHaveBeenCalledTimes(manifests.length);
      expect(bytes(file)).toEqual(before);
      for (const [index, installer] of installers.entries()) {
        if (manifests[index].name !== agent) expect(installer.inspectMemberHooks().member).toBe(false);
      }
      expect(readProvisionRecord(mycoHome)).toMatchObject({ agents: [agent], binaries: { [agent]: binaries[agent] }, pendingTrust: { [agent]: pendingTrust[agent] } });
      expect(Object.keys(readProvisionRecord(mycoHome)!.binaries!)).toEqual([agent]);
      expect(Object.keys(readProvisionRecord(mycoHome)!.pendingTrust!)).toEqual([agent]);
      expect([...err, ...warning.mock.calls.map(([line]) => String(line))].filter(line => line.includes(file))).toHaveLength(1);
      expect(err.join('\n')).toContain('nothing was written there');
      expect(err.join('\n')).toContain('not fully reconciled');
      expect(out.join('\n')).toContain(`Signed out of ${A}`);
      expect(JSON.parse(fs.readFileSync(logoutJournalPath(A, mycoHome), 'utf8')).phase).toBe('config');
      expect(readDeploymentMembership(A, mycoHome)).toBeNull();
      const partial = await logoutDeployment(A, { mode: 'revoke' }, deps);
      expect(partial.unreconciledAgents).toEqual([{ agent, reason: expect.stringContaining(file) }]);
      expect(visits).toHaveBeenCalledTimes(manifests.length * 2);
      fs.writeFileSync(file, clean);
      expect(await logoutCli([A], { ...deps, stdout: () => {}, stderr: () => {} })).toBe(true);
      expect(visits).toHaveBeenCalledTimes(manifests.length * 3);
      expect(failed.inspectMemberHooks().member).toBe(false);
      expect(readProvisionRecord(mycoHome)).toBeNull();
      expect(fs.existsSync(logoutJournalPath(A, mycoHome))).toBe(false);
      expect(requests).toHaveLength(1);
    } finally { visits.mockRestore(); warning.mockRestore(); }
  });

  it('fails unexpected reconciliation errors after visiting every manifest and reconciling the provision record', async () => {
    join(A);
    globalInstaller(A).install();
    const original = SymbiontInstaller.prototype.reconcileDeploymentLogout;
    let visited = 0;
    const failure = new TypeError('unexpected reconciliation bug');
    const visits = spyOn(SymbiontInstaller.prototype, 'reconcileDeploymentLogout').mockImplementation(function(this: SymbiontInstaller, ...args) {
      if (++visited === loadManifests().findIndex(manifest => manifest.name === 'claude-code') + 1) throw failure;
      return original.apply(this, args);
    });
    try {
      await expect(logoutDeployment(A, { mode: 'revoke' }, deps)).rejects.toBe(failure);
      expect(visited).toBe(loadManifests().length);
      expect(readProvisionRecord(mycoHome)?.agents).toEqual(['claude-code']);
      expect(fs.existsSync(logoutJournalPath(A, mycoHome))).toBe(true);
    } finally { visits.mockRestore(); }
  });

  it('returns a complete clean logout with every manifest visited and no provision record or journal', async () => {
    join(A);
    globalInstaller(A).install();
    const visits = spyOn(SymbiontInstaller.prototype, 'reconcileDeploymentLogout');
    const err: string[] = [];
    try {
      expect(await logoutCli([A], { ...deps, stdout: () => {}, stderr: line => err.push(line) })).toBe(true);
      expect(visits).toHaveBeenCalledTimes(loadManifests().length);
      expect(err).toEqual([]);
      expect(globalInstaller(A).inspectMemberHooks().member).toBe(false);
      expect(readProvisionRecord(mycoHome)).toBeNull();
      expect(fs.existsSync(logoutJournalPath(A, mycoHome))).toBe(false);
    } finally { visits.mockRestore(); }
  });

  it('keeps unreadable unrelated hooks untouched when another Deployment survives', async () => {
    join(A); join(B);
    const file = path.join(home, '.cursor', 'hooks.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '\ufeff{"user":true}');
    const before = bytes(file);
    const report = await logoutDeployment(A, { mode: 'revoke' }, deps);
    expect(report.unreconciledAgents).toEqual([]);
    expect(bytes(file)).toEqual(before);
  });

  it('removes this machines entries while keeping stale credential-marked hooks and tools', async () => {
    join(A);
    globalInstaller(A).install();
    const binary = path.join(root, 'deleted-install', 'bin', 'myco');
    const hooksFile = path.join(home, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    const staleHook = { hooks: [{ command: `${binary} hook stop --myco-managed --credential registry` }] };
    settings.hooks.Stop.push(staleHook);
    fs.writeFileSync(hooksFile, JSON.stringify(settings));
    const file = path.join(home, '.claude.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const staleTools = { type: 'http', url: `${A}/mcp`, headersHelper: `${binary} member mcp-headers --credential registry --server ${A}` };
    data.servers = { myco: staleTools };
    fs.writeFileSync(file, JSON.stringify(data));
    await logoutDeployment(A, { mode: 'local-only' }, deps);
    expect(JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks.Stop).toEqual([staleHook]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).servers.myco).toEqual(staleTools);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers?.myco).toBeUndefined();
    expect(globalInstaller(A).inspectMemberHooks().member).toBe(false);
  });

  it('reconciles every agent beside an unrelated stale Claude project entry', async () => {
    join(A);
    const agents = ['claude-code', 'codex', 'cursor'];
    const installers = agents.map(agent => new SymbiontInstaller(loadManifests().find(m => m.name === agent)!, mycoHome, PKG, false, mycoHome).withoutProjectRoot().forDeployment(A));
    for (const installer of installers) installer.install();
    const file = path.join(home, '.claude.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const folder = '/Users/x/my.app';
    const entry = { command: path.join(root, 'deleted-install', 'bin', 'myco') };
    data.projects = { [folder]: { mcpServers: { myco: entry } } };
    fs.writeFileSync(file, JSON.stringify(data));
    await logoutDeployment(A, { mode: 'local-only' }, deps);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).projects[folder].mcpServers.myco).toEqual(entry);
    for (const installer of installers) {
      expect(installer.inspectMemberHooks().member).toBe(false);
      expect(installer.inspectMemberMcp(A).some(e => e.present)).toBe(false);
    }
  });

  it('refuses a missing revoke route in the real pipeline and warns under local-only', async () => {
    const rig = await memberRig();
    const index = ROUTES.findIndex((r) => r.path === '/members/credential/revoke');
    const [route] = Array.prototype.splice.call(ROUTES, index, 1);
    try {
      writeDeploymentMembership({ serverUrl: A, token: rig.token, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
      const held = bytes(deploymentPath(A, mycoHome));
      await expect(logoutDeployment(A, { mode: 'revoke' }, { ...deps, fetch: rig.fetch })).rejects.toThrow('myco server update');
      expect(bytes(deploymentPath(A, mycoHome))).toEqual(held);
      const out: string[] = [];
      expect(await logoutCli([A, '--local-only'], { ...deps, fetch: rig.fetch, stdout: (s) => out.push(s) })).toBe(true);
      expect(out.join('\n')).toContain('Credential may stay valid on the server until it expires');
      expect(out.join('\n')).toContain('› machine_1 › Stop');
      expect((await rig.fetch(`${A}/members/status`, { method: 'POST', headers: rig.headers(), body: '{}' })).status).toBe(200);
    } finally { Array.prototype.splice.call(ROUTES, index, 0, route); rig.env.sqlite.close(); }
  });

  it('ends an eight-day-old refreshable credential before removing it locally', async () => {
    const rig = await memberRig({ now: Date.now() - 8 * 24 * 60 * 60 * 1000 });
    try {
      writeDeploymentMembership({ serverUrl: A, token: rig.token, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
      expect((await logoutDeployment(A, { mode: 'revoke' }, { ...deps, fetch: rig.fetch })).revoked).toBe(true);
      const refreshed = await rig.fetch(`${A}/tokens/refresh`, { method: 'POST', headers: rig.headers(), body: '{}' });
      expect(refreshed.status).toBe(401);
      expect((rig.env.sqlite.query('SELECT revoked_at FROM member_credentials WHERE id = ?').get(rig.tokenId) as { revoked_at: number | null }).revoked_at).not.toBeNull();
    } finally { rig.env.sqlite.close(); }
  });

  it('keeps a lapsed credential when the real pipeline lacks the revoke route', async () => {
    const rig = await memberRig({ now: Date.now() - 8 * 24 * 60 * 60 * 1000 });
    const index = ROUTES.findIndex((r) => r.path === '/members/credential/revoke');
    const [route] = Array.prototype.splice.call(ROUTES, index, 1);
    try {
      writeDeploymentMembership({ serverUrl: A, token: rig.token, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
      await expect(logoutDeployment(A, { mode: 'revoke' }, { ...deps, fetch: rig.fetch })).rejects.toThrow('myco server update');
      expect(readDeploymentMembership(A, mycoHome)?.token).toBe(rig.token);
      expect((rig.env.sqlite.query('SELECT revoked_at FROM member_credentials WHERE id = ?').get(rig.tokenId) as { revoked_at: number | null }).revoked_at).toBeNull();
      expect((await logoutDeployment(A, { mode: 'local-only' }, { ...deps, fetch: rig.fetch })).revoked).toBe(false);
    } finally { Array.prototype.splice.call(ROUTES, index, 0, route); rig.env.sqlite.close(); }
  });

  it('refuses a route-missing re-revoke after an interrupted acknowledgement', async () => {
    const rig = await memberRig();
    const index = ROUTES.findIndex((r) => r.path === '/members/credential/revoke');
    const [route] = Array.prototype.splice.call(ROUTES, index, 1);
    try {
      writeDeploymentMembership({ serverUrl: A, token: rig.token, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
      await expect(logoutDeployment(A, { mode: 'revoke' }, { ...deps, checkpoint: (phase) => { if (phase === 'revoked') throw new Error('interrupted'); } })).rejects.toThrow('interrupted');
      expect(JSON.parse(fs.readFileSync(logoutJournalPath(A, mycoHome), 'utf8')).phase).toBe('revoke');
      await expect(logoutDeployment(A, { mode: 'revoke' }, { ...deps, fetch: rig.fetch })).rejects.toThrow('myco server update');
      expect(readDeploymentMembership(A, mycoHome)).not.toBeNull();
    } finally { Array.prototype.splice.call(ROUTES, index, 0, route); rig.env.sqlite.close(); }
  });

  it('counts and preserves pending capture only for the leaving Deployment', async () => {
    join(A, 'proj_a'); join(B);
    spool(A, 'proj_a');
    for (const serverUrl of [A, B]) {
      const folder = path.join(home, 'Repos', serverUrl === A ? 'held-personal' : 'held-work');
      fs.mkdirSync(folder, { recursive: true });
      const held = pendingSpool({ root: folder, rootKey: rootKeyFor(folder, mycoHome), serverUrl }, { mycoHome, now: 1 })!;
      fs.writeFileSync(path.join(held.dir, 'session.jsonl'), 'retained capture\n');
    }
    const before = tree(path.join(mycoHome, 'member', 'pending'));
    const report = await logoutDeployment(A, { mode: 'revoke' }, deps);
    expect(report.keptSpool.sessions).toBe(2);
    expect(report.keptSpool.paths).toHaveLength(2);
    expect(tree(path.join(mycoHome, 'member', 'pending'))).toEqual(before);
    expect(fs.existsSync(logoutJournalPath(A, mycoHome))).toBe(false);
    expect(fs.existsSync(logoutJournalPath(A, mycoHome).replace(/\.json$/, '.lock'))).toBe(false);
  });

  it('reconciles a provision record naming the leaving origin with different URL spelling', () => {
    join(A); globalInstaller(A).install();
    const file = provisionRecordPath(mycoHome);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, serverUrl: 'https://PERSONAL.example:443/' }));
    reconcileProvisionDeployment(mycoHome, A, B);
    expect(readProvisionRecord(mycoHome)?.serverUrl).toBe(B);
  });

  for (const workCache of ['empty', 'stale', 'unreadable'] as const) it(`leaves former personal repositories out of work auto-join and capture (work cache: ${workCache})`, async () => {
    const homelab = path.join(home, 'Repos', 'homelab');
    fs.mkdirSync(homelab, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: homelab });
    writeRegistryEntry({ version: 2, root: homelab, projectId: 'proj_homelab', serverUrl: A, token: 'personal', machineId: 'machine_test', joinedAt: 1, updatedAt: 1 }, { mycoHome });
    join(B, 'proj_work');
    recordDefaultDeployment(B, { mycoHome });
    cacheMachineSettings(B, { leaves: { 'capture.auto_join_roots': [path.join(home, 'Repos')], 'capture.connect_roots': workCache === 'empty' ? {} : { [rootKeyFor(homelab, mycoHome)]: '' } } }, mycoHome);
    if (workCache === 'unreadable') fs.writeFileSync(machineSettingsPath(B, mycoHome), '{');
    const beforeSettings = bytes(machineSettingsPath(B, mycoHome));
    const beforeB = tree(path.join(mycoHome, 'member', 'pending'));
    const out: string[] = [];
    expect(await logoutCli([A], { ...deps, stdout: (s) => out.push(s) })).toBe(true);
    expect(out.join('\n')).toContain("1 repositories won't be captured until you connect them again");
    expect(out.join('\n')).toContain(homelab);
    expect(bytes(machineSettingsPath(B, mycoHome))).toEqual(beforeSettings);
    if (workCache === 'unreadable') cacheMachineSettings(B, { leaves: { 'capture.auto_join_roots': [path.join(home, 'Repos')], 'capture.connect_roots': { [rootKeyFor(homelab, mycoHome)]: '' } } }, mycoHome);
    const steps: Array<() => void> = [];
    const hold = autoJoinHold({ root: homelab, hookName: 'user-prompt-submit', agent: 'claude-code', sessionId: 'personal-session', mycoHome, now: Date.now(), env: { ...process.env, MYCO_TEMPORARY_FOLDERS: path.join(root, 'other-temp') }, later: (step) => steps.push(step) });
    expect(hold).toBe(LEFT_ALONE);
    expect(steps).toEqual([]);
    expect(listJoinRequests(mycoHome)).toEqual([]);
    expect(tree(path.join(mycoHome, 'member', 'pending'))).toEqual(beforeB);
    expect(rootKeyFor(homelab, mycoHome)).toBeTruthy();
    markLeft(rootKeyFor(homelab, mycoHome), mycoHome, Date.now());
    cacheMachineSettings(B, { leaves: { 'capture.connect_roots': {} } }, mycoHome);
    const hook = { root: homelab, hookName: 'user-prompt-submit' as const, agent: 'claude-code', sessionId: 'refreshed-directive', mycoHome, now: Date.now(), env: { ...process.env, MYCO_TEMPORARY_FOLDERS: path.join(root, 'other-temp') }, later: (step: () => void) => steps.push(step) };
    expect(autoJoinHold(hook)).toBe(LEFT_ALONE);
    cacheMachineSettings(B, { leaves: { 'capture.connect_roots': { [rootKeyFor(homelab, mycoHome)]: '' } } }, mycoHome);
    expect(autoJoinHold(hook)).toBe(LEFT_ALONE);
    expect(steps).toEqual([]);
    expect(listJoinRequests(mycoHome)).toEqual([]);
    expect(tree(path.join(mycoHome, 'member', 'pending'))).toEqual(beforeB);
  });

  it('reports only opted-out roots when a snapshotted root is rebound to work', async () => {
    const folder = join(A, 'proj_a')!;
    join(B);
    deps.checkpoint = (phase) => {
      if (phase === 'local') writeRegistryEntry({ version: 2, root: folder, projectId: 'proj_work', serverUrl: B, token: `${B}-secret`, machineId: 'machine_test', joinedAt: 1, updatedAt: 1 }, { mycoHome });
    };
    const report = await logoutDeployment(A, { mode: 'revoke' }, deps);
    expect(report.leftRoots).toEqual([]);
    expect(isLeft(rootKeyFor(folder, mycoHome), mycoHome)).toBe(false);
    expect(JSON.parse(fs.readFileSync(registryEntryPath(folder, mycoHome), 'utf8')).serverUrl).toBe(B);
  });

  it('revokes one credential, removes its state and registrations, and keeps its capture', async () => {
    const folder = join(A, 'proj_a')!;
    recordDefaultDeployment(A, { mycoHome });
    globalInstaller(A).install();
    fs.writeFileSync(deploymentFeaturesPath(A, mycoHome), 'features');
    fs.writeFileSync(machineSettingsPath(A, mycoHome), 'settings');
    const dir = spool(A, 'proj_a');
    const before = tree(dir);
    const report = await logoutDeployment(A, { mode: 'revoke' }, deps);
    expect(requests.map((r) => [r.url, r.method, r.headers.get('authorization')])).toEqual([[`${A}/members/credential/revoke`, 'POST', `Bearer ${A}-secret`]]);
    expect(requests[0].headers.has('x-myco-project')).toBe(false);
    expect(await requests[0].text()).toBe('{}');
    for (const file of [deploymentPath(A, mycoHome), deploymentFeaturesPath(A, mycoHome), machineSettingsPath(A, mycoHome), registryEntryPath(folder, mycoHome), defaultDeploymentPath(mycoHome), provisionRecordPath(mycoHome)]) expect(fs.existsSync(file)).toBe(false);
    expect(globalInstaller(A).inspectMemberHooks().member).toBe(false);
    expect(globalInstaller(A).inspectMemberMcp(A).some((e) => e.present)).toBe(false);
    expect(tree(dir)).toEqual(before);
    expect(report.keptSpool.sessions).toBe(1);
    expect(report.revoked).toBe(true);
    expect(fs.existsSync(logoutJournalPath(A, mycoHome))).toBe(false);
    expect(fs.existsSync(logoutJournalPath(A, mycoHome).replace(/\.json$/, '.lock'))).toBe(false);
    await expect(logoutDeployment(A, { mode: 'revoke' }, deps)).rejects.toThrow('No membership matches');
    expect(requests).toHaveLength(1);
  });

  it('revokes through the real server pipeline before removing the local credential', async () => {
    const rig = await memberRig();
    try {
      writeDeploymentMembership({ serverUrl: A, token: rig.token, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
      const report = await logoutDeployment(A, { mode: 'revoke' }, { ...deps, fetch: rig.fetch });
      expect(report.revoked).toBe(true);
      const response = await rig.fetch(`${A}/members/status`, { method: 'POST', headers: rig.headers(), body: '{}' });
      expect(response.status).toBe(401);
      expect(readDeploymentMembership(A, mycoHome)).toBeNull();
    } finally { rig.env.sqlite.close(); }
  });

  for (const answer of [{ persisted: false, code: 'parse' }, {}, null]) it(`requires a positive revoke acknowledgement: ${JSON.stringify(answer)}`, async () => {
    join(A);
    deps.fetch = async () => Response.json(answer);
    await expect(logoutDeployment(A, { mode: 'revoke' }, deps)).rejects.toThrow('did not acknowledge');
    expect(readDeploymentMembership(A, mycoHome)).not.toBeNull();
  });

  it('can restart a stale journal after a fresh sign-in replaces the credential', async () => {
    join(A);
    deps.fetch = async () => { throw new Error('offline'); };
    await expect(logoutDeployment(A, { mode: 'revoke' }, deps)).rejects.toThrow('could not be reached');
    writeDeploymentMembership({ serverUrl: A, token: 'fresh-sign-in', machineId: 'machine_test', joinedAt: 1, updatedAt: 2 }, { mycoHome });
    deps.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ persisted: true });
    };
    await logoutDeployment(A, { mode: 'revoke' }, deps);
    expect(requests[0].headers.get('authorization')).toBe('Bearer fresh-sign-in');
    expect(readDeploymentMembership(A, mycoHome)).toBeNull();
  });

  it('preserves a surviving entry under an alternate MCP key', async () => {
    join(A); join(B);
    recordDefaultDeployment(A, { mycoHome });
    globalInstaller(A).install();
    const file = globalInstaller(A).memberGlobalTargets().mcp[0];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entryB = globalInstaller(B).renderMemberMcp('registry')!.myco;
    data.servers = { myco: entryB };
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    await logoutDeployment(A, { mode: 'revoke' }, deps);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).servers.myco).toEqual(entryB);
  });

  it('re-renders an alternate-key leaving entry under the primary key', async () => {
    join(A); join(B);
    recordDefaultDeployment(A, { mycoHome });
    globalInstaller(A).install();
    const file = globalInstaller(A).memberGlobalTargets().mcp[0];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.servers = data.mcpServers;
    delete data.mcpServers;
    fs.writeFileSync(file, JSON.stringify(data));
    await logoutDeployment(A, { mode: 'revoke' }, deps);
    expect(globalInstaller(B).inspectMemberMcp(B).some((e) => e.namesExpectedDeployment)).toBe(true);
  });

  it('can remove the last membership while preserving a foreign Deployment MCP entry', async () => {
    join(A);
    globalInstaller(A).install();
    const file = globalInstaller(A).memberGlobalTargets().mcp[0];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.mcpServers.myco = globalInstaller(B).renderMemberMcp('registry')!.myco;
    fs.writeFileSync(file, JSON.stringify(data));
    const before = bytes(file);
    await logoutDeployment(A, { mode: 'revoke' }, deps);
    expect(bytes(file)).toEqual(before);
    expect(globalInstaller(A).inspectMemberHooks().member).toBe(false);
    expect(fs.existsSync(logoutJournalPath(A, mycoHome))).toBe(false);
  });

  for (const name of ['codex', 'cline']) it(`preserves surviving ${name} registrations byte for byte, then removes them on last logout`, async () => {
    join(A); join(B);
    recordDefaultDeployment(B, { mycoHome });
    const manifest = loadManifests().find((m) => m.name === name)!;
    const installer = new SymbiontInstaller(manifest, mycoHome, PKG, false, mycoHome).withoutProjectRoot().forDeployment(B);
    installer.install();
    const files = installer.memberGlobalTargets().all.filter((file) => fs.existsSync(file));
    const before = files.map(bytes);
    await logoutDeployment(A, { mode: 'revoke' }, deps);
    for (const [i, file] of files.entries()) expect(bytes(file)).toEqual(before[i]);
    await logoutDeployment(B, { mode: 'revoke' }, deps);
    expect(installer.inspectMemberHooks().member).toBe(false);
    expect(installer.inspectMemberMcp().some((entry) => entry.present)).toBe(false);
  });

  it('keeps all repository harness entries when logging out of a Deployment', async () => {
    const folderA = join(A, 'proj_a')!;
    const folderB = join(B, 'proj_b')!;
    const localA = path.join(folderA, '.mcp.json');
    fs.writeFileSync(localA, JSON.stringify({ mcpServers: { myco: { url: A + '/mcp' } } }));
    fs.writeFileSync(path.join(folderB, '.mcp.json'), JSON.stringify({ mcpServers: { myco: { url: B + '/mcp' } } }));
    const beforeA = bytes(localA);
    const fileB = path.join(folderB, '.mcp.json');
    const before = bytes(fileB);
    await logoutDeployment(A, { mode: 'revoke' }, deps);
    expect(bytes(localA)).toEqual(beforeA);
    expect(bytes(fileB)).toEqual(before);
  });

  it('reconciles each global MCP target independently and preserves the other target bytes', async () => {
    join(A); join(B);
    recordDefaultDeployment(A, { mycoHome });
    const copilot = loadManifests().find((m) => m.name === 'copilot')!;
    const manifest = { ...claude(), registration: { ...claude().registration!, globalMcpTarget: copilot.registration!.globalMcpTarget } };
    const installer = new SymbiontInstaller(manifest, mycoHome, PKG, false, mycoHome).withoutProjectRoot();
    const targets = manifest.registration!.globalMcpTarget!;
    expect(targets.length).toBeGreaterThan(1);
    const paths = targets.map((t) => path.join(home, t.path.replace(/^~\//, '')));
    const entryA = installer.forDeployment(A).renderMemberMcp('registry')!.myco;
    const entryB = installer.forDeployment(B).renderMemberMcp('registry')!.myco;
    for (const [i, file] of paths.entries()) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ [targets[i].serversKey ?? manifest.registration!.mcpServersKey ?? 'mcpServers']: { myco: i === 0 ? entryA : entryB } }));
    }
    const before = paths.slice(1).map(bytes);
    installer.reconcileDeploymentLogout(A, B, true);
    for (const [i, file] of paths.slice(1).entries()) expect(bytes(file)).toEqual(before[i]);
    expect(fs.readFileSync(paths[0], 'utf8')).not.toContain(A);
    expect(fs.readFileSync(paths[0], 'utf8')).toContain(B);
  });

  it('does not replace an MCP entry whose helper names a different Deployment', async () => {
    join(A); join(B);
    recordDefaultDeployment(A, { mycoHome });
    globalInstaller(A).install();
    const file = globalInstaller(A).memberGlobalTargets().mcp[0];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.mcpServers.myco.headersHelper = data.mcpServers.myco.headersHelper.replace(A, B);
    fs.writeFileSync(file, JSON.stringify(data));
    const before = bytes(file);
    await expect(logoutDeployment(A, { mode: 'revoke' }, deps)).rejects.toThrow('conflicting Deployments');
    expect(bytes(file)).toEqual(before);
  });

  it('preserves every byte of B credentials, bindings, hooks, MCP and spool after logging out of A', async () => {
    join(A, 'proj_a');
    const folderB = join(B, 'proj_b')!;
    recordDefaultDeployment(B, { mycoHome });
    globalInstaller(B).install();
    const dirA = spool(A, 'proj_a');
    const dirB = spool(B, 'proj_b');
    fs.writeFileSync(deploymentFeaturesPath(B, mycoHome), 'work features');
    fs.writeFileSync(machineSettingsPath(B, mycoHome), 'work machine settings');
    const files = [deploymentPath(B, mycoHome), registryEntryPath(folderB, mycoHome), deploymentFeaturesPath(B, mycoHome), machineSettingsPath(B, mycoHome),
      defaultDeploymentPath(mycoHome), provisionRecordPath(mycoHome), ...globalInstaller(B).memberGlobalTargets().all.filter((f) => fs.existsSync(f))];
    const snapshots = files.map((f) => [f, bytes(f)] as const);
    const beforeA = tree(dirA);
    const beforeB = tree(dirB);
    await logoutDeployment(A, { mode: 'revoke' }, deps);
    for (const [file, before] of snapshots) expect(bytes(file)).toEqual(before);
    expect(tree(dirA)).toEqual(beforeA);
    expect(tree(dirB)).toEqual(beforeB);
    expect(readDeploymentMembership(A, mycoHome)).toBeNull();
  });

  it('moves the default and only the leaving MCP entry to the sole valid survivor', async () => {
    join(A); join(B);
    recordDefaultDeployment(A, { mycoHome });
    globalInstaller(A).install();
    const hooks = globalInstaller(A).memberGlobalTargets().hooks!;
    const before = bytes(hooks);
    await logoutDeployment(A, { mode: 'revoke' }, deps);
    expect(readDefaultDeployment(mycoHome)?.serverUrl).toBe(B);
    expect(bytes(hooks)).toEqual(before);
    expect(globalInstaller(B).inspectMemberMcp(B).every((e) => !e.present || e.namesExpectedDeployment)).toBe(true);
    expect(readProvisionRecord(mycoHome)?.serverUrl).toBe(B);
  });

  it('clears the default and MCP with multiple valid survivors and keeps shared hooks', async () => {
    join(A); join(B); join(C);
    recordDefaultDeployment(A, { mycoHome });
    globalInstaller(A).install();
    const hooks = globalInstaller(A).memberGlobalTargets().hooks!;
    const before = bytes(hooks);
    const lines: string[] = [];
    expect(await logoutCli([A], { ...deps, stdout: (s) => lines.push(s) })).toBe(true);
    expect(readDefaultDeployment(mycoHome)).toBeNull();
    expect(bytes(hooks)).toEqual(before);
    expect(globalInstaller(A).inspectMemberMcp().some((e) => e.present)).toBe(false);
    expect(lines.join('\n')).toContain('myco login --default <url>');
  });

  for (const spelling of ['personal.example', `${A}/`, `${A}/some/path`]) it(`normalizes ${spelling} to its origin`, async () => {
    join(A);
    expect((await logoutDeployment(spelling, { mode: 'revoke' }, deps)).serverUrl).toBe(A);
  });

  it('resolves recorded native loopback aliases', async () => {
    join('http://localhost:12345');
    deps.worker!.ownDeploymentUrls = async () => ['http://localhost:12345', 'http://127.0.0.1:12345'];
    expect((await logoutDeployment('http://127.0.0.1:12345/', { mode: 'revoke' }, deps)).serverUrl).toBe('http://localhost:12345');
  });

  it('refuses a different scheme, host, or absent membership and lists those held', async () => {
    join(A);
    await expect(logoutDeployment(B, { mode: 'revoke' }, deps)).rejects.toThrow(A);
    await expect(logoutDeployment('http://localhost:12345', { mode: 'revoke' }, deps)).rejects.toThrow(A);
    expect(requests).toHaveLength(0);
    expect(readDeploymentMembership(A, mycoHome)).not.toBeNull();
  });

  for (const status of [403, 404, 500, 503]) it(`keeps local state on remote HTTP ${status}`, async () => {
    join(A, 'proj_a');
    deps.fetch = async () => new Response('', { status });
    await expect(logoutDeployment(A, { mode: 'revoke' }, deps)).rejects.toThrow(`HTTP ${status}`);
    expect(readDeploymentMembership(A, mycoHome)).not.toBeNull();
  });

  it('treats already revoked credentials as revoked', async () => {
    join(A);
    deps.fetch = async () => new Response('', { status: 401 });
    expect((await logoutDeployment(A, { mode: 'revoke' }, deps)).revoked).toBe(true);
  });

  it('keeps local state when unreachable, then permits explicit local-only and reports the still-live credential', async () => {
    join(A);
    deps.fetch = async () => { throw new Error('offline'); };
    await expect(logoutDeployment(A, { mode: 'revoke' }, deps)).rejects.toThrow('could not be reached');
    expect(readDeploymentMembership(A, mycoHome)).not.toBeNull();
    const lines: string[] = [];
    expect(await logoutCli([A, '--local-only'], { ...deps, stdout: (s) => lines.push(s) })).toBe(true);
    expect(lines.join('\n')).toContain('may stay valid on the server until it expires');
    expect(lines.join('\n')).toContain('People & machines');
  });

  for (const status of [200, 403, 404, 410]) it(`local-only removes local state after unconfirmed revocation HTTP ${status}`, async () => {
    const folder = join(A, 'proj_a')!;
    const capture = spool(A, 'proj_a');
    const before = tree(capture);
    deps.fetch = async () => new Response('<html>This address is unavailable</html>', { status, headers: { 'content-type': 'text/html' } });
    const lines: string[] = [];
    expect(await logoutCli([A, '--local-only'], { ...deps, stdout: line => lines.push(line), stderr: line => lines.push(line) })).toBe(true);
    expect(readDeploymentMembership(A, mycoHome)).toBeNull();
    expect(readRegistryEntry(folder, mycoHome)).toBeNull();
    expect(fs.existsSync(logoutJournalPath(A, mycoHome))).toBe(false);
    expect(tree(capture)).toEqual(before);
    expect(lines.join('\n')).toContain('Credential may stay valid on the server until it expires');
  });

  it('names local-only recovery for a missing address while keeping ordinary refusals unchanged', async () => {
    join(A);
    deps.fetch = async () => new Response('<html>Not Found</html>', { status: 404 });
    await expect(logoutDeployment(A, { mode: 'revoke' }, deps)).rejects.toThrow(
      `This address no longer answers Myco's revoke route (HTTP 404). If the Deployment moved or is gone, run myco logout ${A} --local-only to remove it from this machine (its credential stays valid on the server until it expires).`,
    );
    expect(readDeploymentMembership(A, mycoHome)).not.toBeNull();
    for (const status of [403, 410, 500]) {
      deps.fetch = async () => new Response('', { status });
      await expect(logoutDeployment(A, { mode: 'revoke' }, deps)).rejects.toThrow(`The Deployment refused credential revocation (HTTP ${status}); local state was kept`);
      expect(readDeploymentMembership(A, mycoHome)).not.toBeNull();
    }
  });

  it('permits explicit local-only on a server failure', async () => {
    join(A);
    deps.fetch = async () => new Response('', { status: 503 });
    expect((await logoutDeployment(A, { mode: 'local-only' }, deps)).revoked).toBe(false);
    expect(readDeploymentMembership(A, mycoHome)).toBeNull();
  });

  it('refuses an unreadable binding by filename before revocation', async () => {
    const folder = join(A, 'proj_a')!;
    const file = registryEntryPath(folder, mycoHome);
    fs.writeFileSync(file, '{broken');
    await expect(logoutDeployment(A, { mode: 'revoke' }, deps)).rejects.toThrow(file);
    expect(requests).toHaveLength(0);
  });

  it('removes only the target legacy service and leaves runner and B units and records untouched', async () => {
    join(A); join(B);
    const fake = recordingPlatform();
    const binary = path.join(mycoHome, 'bin', 'myco');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    deps.worker = { home, mycoHome, binaryPath: binary, platform: 'darwin', runner: fake.runner };
    const units = [
      installWorkerService(executorServiceTarget(A, deps.worker), [], { runner: fake.runner }),
      installWorkerService(executorServiceTarget(B, deps.worker), [], { runner: fake.runner }),
      installWorkerService(executorServiceTarget(A, deps.worker, 'runner'), [], { runner: fake.runner }),
    ];
    const record = runnerRecordPath(A, mycoHome);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ version: 1, serverUrl: A, name: 'runner', runnerId: 'run_fixture' }), { mode: 0o600 });
    const before = [bytes(units[1].unitFile), bytes(units[2].unitFile), bytes(record)];
    fake.commands.length = 0;
    const report = await logoutDeployment(A, { mode: 'revoke' }, deps);
    expect(report.runner).toBe(true);
    expect(fs.existsSync(units[0].unitFile)).toBe(false);
    expect(bytes(units[1].unitFile)).toEqual(before[0]);
    expect(bytes(units[2].unitFile)).toEqual(before[1]);
    expect(bytes(record)).toEqual(before[2]);
    expect(fake.commands.some((c) => c.includes('myco.runner'))).toBe(false);
  });

  it('refuses a changed credential before touching its service, and a rerun can log the new credential out', async () => {
    join(A);
    const fake = recordingPlatform();
    const binary = path.join(mycoHome, 'bin', 'myco');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    deps.worker = { home, mycoHome, binaryPath: binary, platform: 'darwin', runner: fake.runner };
    const unit = installWorkerService(executorServiceTarget(A, deps.worker), [], { runner: fake.runner });
    const before = bytes(unit.unitFile);
    fake.commands.length = 0;
    deps.checkpoint = (phase) => {
      if (phase === 'local') writeDeploymentMembership({ serverUrl: A, token: 'new-login', machineId: 'machine_test', joinedAt: 1, updatedAt: 2 }, { mycoHome });
    };
    await expect(logoutDeployment(A, { mode: 'revoke' }, deps)).rejects.toThrow('membership changed');
    expect(bytes(unit.unitFile)).toEqual(before);
    expect(fake.commands).toEqual([]);
    deps.checkpoint = undefined;
    await logoutDeployment(A, { mode: 'revoke' }, deps);
    expect(fs.existsSync(unit.unitFile)).toBe(false);
  });

  for (const phase of ['local', 'config'] as const) it(`resumes after a process is killed at ${phase}`, async () => {
    join(A); join(B);
    recordDefaultDeployment(A, { mycoHome });
    globalInstaller(A).install();
    const marker = path.join(root, 'checkpoint');
    const calls = path.join(root, 'revocations');
    const source = path.resolve(import.meta.dir, '../../packages/myco/src/symbionts/logout-runtime.ts');
    const script = path.join(root, 'interrupted.ts');
    fs.writeFileSync(script, `import fs from 'node:fs';\nimport { logoutDeployment } from ${JSON.stringify(source)};\nawait logoutDeployment(${JSON.stringify(A)}, { mode: 'revoke' }, { mycoHome: ${JSON.stringify(mycoHome)}, home: ${JSON.stringify(home)}, packageRoot: ${JSON.stringify(PKG)}, fetch: async () => { fs.appendFileSync(${JSON.stringify(calls)}, 'revoke\\n'); return Response.json({ persisted: true }); }, checkpoint: async (phase) => { if (phase === ${JSON.stringify(phase)}) { fs.writeFileSync(${JSON.stringify(marker)}, phase); await Bun.sleep(60000); } } });\n`);
    const child = Bun.spawn([process.execPath, '--no-env-file', '--tsconfig-override', path.resolve(import.meta.dir, '../../tsconfig.json'), script], {
      cwd: root, env: sandboxChildEnv(root, { HOME: home, MYCO_HOME: mycoHome }), stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await Bun.sleep(20);
      if (!fs.existsSync(marker)) throw new Error(`child did not reach checkpoint: ${await new Response(child.stderr).text()}`);
      child.kill('SIGKILL');
      await child.exited;
      expect(JSON.parse(fs.readFileSync(logoutJournalPath(A, mycoHome), 'utf8')).phase).toBe(phase);
      await logoutDeployment(A, { mode: 'revoke' }, deps);
      expect(fs.existsSync(logoutJournalPath(A, mycoHome))).toBe(false);
      expect(fs.readFileSync(calls, 'utf8')).toBe('revoke\n');
      expect(requests).toHaveLength(0);
      expect(readDeploymentMembership(A, mycoHome)).toBeNull();
      expect(readDeploymentMembership(B, mycoHome)).not.toBeNull();
      expect(globalInstaller(B).inspectMemberMcp(B).some((e) => e.namesExpectedDeployment)).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
    }
  }, 15000);
  for (const boundary of ['revoked', 'bindings-removed'] as const) it(`resumes after SIGKILL at ${boundary} against the real server`, async () => {
    const rig = await memberRig();
    let revokes = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => {
      if (new URL(request.url).pathname === '/members/credential/revoke') revokes++;
      return rig.fetch(request);
    } });
    const url = server.url.origin;
    const folder = join(url, 'proj_personal')!;
    writeDeploymentMembership({ serverUrl: url, token: rig.token, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
    join(B, 'proj_work');
    recordDefaultDeployment(B, { mycoHome });
    const marker = path.join(root, 'checkpoint');
    const source = path.resolve(import.meta.dir, '../../packages/myco/src/symbionts/logout-runtime.ts');
    const script = path.join(root, 'interrupted-real.ts');
    const stop = `fs.writeFileSync(${JSON.stringify(marker)}, 'ready'); Bun.sleepSync(60000);`;
    const pause = boundary === 'revoked' ? `checkpoint: (phase) => { if (phase === 'revoked') { ${stop} } }` : `afterBindingsRemoved: () => { ${stop} }`;
    fs.writeFileSync(script, `import fs from 'node:fs'; import { logoutDeployment } from ${JSON.stringify(source)}; await logoutDeployment(${JSON.stringify(url)}, { mode: 'revoke' }, { mycoHome: ${JSON.stringify(mycoHome)}, home: ${JSON.stringify(home)}, packageRoot: ${JSON.stringify(PKG)}, ${pause} });`);
    const child = Bun.spawn([process.execPath, '--no-env-file', '--tsconfig-override', path.resolve(import.meta.dir, '../../tsconfig.json'), script], {
      cwd: root, env: sandboxChildEnv(root, { HOME: home, MYCO_HOME: mycoHome }), stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await Bun.sleep(20);
      if (!fs.existsSync(marker)) throw new Error(`child did not reach checkpoint: ${await new Response(child.stderr).text()}`);
      child.kill('SIGKILL');
      await child.exited;
      expect(revokes).toBe(1);
      expect(JSON.parse(fs.readFileSync(logoutJournalPath(url, mycoHome), 'utf8')).phase).toBe(boundary === 'revoked' ? 'revoke' : 'local');
      expect(readDeploymentMembership(url, mycoHome)).not.toBeNull();
      expect(fs.existsSync(registryEntryPath(folder, mycoHome))).toBe(boundary === 'revoked');
      const report = await logoutDeployment(url, { mode: 'revoke' }, { ...deps, fetch: globalThis.fetch });
      expect(report.revoked).toBe(true);
      expect(report.leftRoots).toContain(folder);
      expect(isLeft(rootKeyFor(folder, mycoHome), mycoHome)).toBe(true);
      expect(revokes).toBe(boundary === 'revoked' ? 2 : 1);
      expect(fs.existsSync(logoutJournalPath(url, mycoHome))).toBe(false);
      expect(fs.existsSync(logoutJournalPath(url, mycoHome).replace(/\.json$/, '.lock'))).toBe(false);
      expect(readDeploymentMembership(url, mycoHome)).toBeNull();
      expect(readDeploymentMembership(B, mycoHome)).not.toBeNull();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      await server.stop(true);
      rig.env.sqlite.close();
    }
  }, 15000);

});
