import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeReport, refusedHookChecks, useHomeDoctor, type MemberDoctorDeps } from '@myco/cli/member-doctor.js';
import { runMemberVerb } from '@myco/cli/member-dispatch.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { REJOIN_HINT } from '@myco/member/delivery-notice.js';
import { logoutDeployment } from '@myco/member/logout.js';
import { clearLeft, markLeft, rootKeyFor } from '@myco/member/auto-join.js';
import { writeDeploymentMembership, writeRegistryEntry } from '@myco/member/registry.js';
import { recordRefusedHook, REFUSED_HOOK_RETENTION_MS } from '@myco/member/refused-hooks.js';
import { newRunnerBearer, runnerRecordPath } from '@myco/runner/runner-registry.js';
import { installWorkerService } from '@myco/runner/service.js';
import { recordingPlatform } from '../member/helpers/service-platform.js';

let scratch: string;
let home: string;
let deps: MemberDoctorDeps;
let platform: ReturnType<typeof recordingPlatform>;
let savedHome: string | undefined;
const now = 2_000_000;
const personal = 'https://homelab.example';
const work = 'https://work.example';
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-home-'));
  home = path.join(scratch, 'myco');
  fs.mkdirSync(home, { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = path.join(scratch, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  platform = recordingPlatform();
  deps = {
    cwd: scratch, mycoHome: home, now: () => now,
    worker: { home: process.env.HOME, mycoHome: home, platform: 'linux', runner: platform.runner, lockDir: path.join(scratch, 'locks'), ownDeploymentUrls: async () => [] },
  };
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(scratch, { recursive: true, force: true });
});
function join(serverUrl: string, root?: string) {
  const membership = { serverUrl, token: 'A'.repeat(43), machineId: 'machine-one', joinedAt: 1, updatedAt: 1, expiresAt: now + 1000 };
  if (root) {
    fs.mkdirSync(root, { recursive: true });
    writeRegistryEntry({ ...membership, version: 2, root, projectId: serverUrl === work ? 'proj_work' : 'proj_home' }, { mycoHome: home });
  } else writeDeploymentMembership(membership, { mycoHome: home });
}
const report = async () => (await homeReport(home, deps)).map(check => check.detail).join('\n');

describe('home doctor', () => {
  it('reports a fresh machine outside a repository without opening a local vault', async () => {
    expect(useHomeDoctor(home)).toBe(true);
    const lines: string[] = [];
    expect(await runMemberVerb('doctor', [], { ...deps, stdout: line => lines.push(line) })).toBe(true);
    expect(lines.join('\n')).toContain('joined no Myco');
    expect(lines.join('\n')).toContain('myco login <address>');
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.existsSync(path.join(scratch, '.myco'))).toBe(false);
  });

  it('reports membership and local credential state without a project or network call', async () => {
    join(personal);
    recordDefaultDeployment(personal, { mycoHome: home });
    const text = await report();
    expect(text).toContain(personal + ' (default for new repositories)');
    expect(text).toContain('locally unexpired');
    expect(text).toContain('authentication not checked');
    expect(text).not.toContain('A'.repeat(43));
    expect(text).not.toContain('no member credential resolves for this project');
  });

  it('shows homelab and work routes together, independent of cwd', async () => {
    const homelabRoot = path.join(scratch, 'repos', 'homelab');
    const workRoot = path.join(scratch, 'repos', 'work');
    join(personal, homelabRoot);
    join(work, workRoot);
    recordDefaultDeployment(work, { mycoHome: home });
    const text = await report();
    expect(text).toContain(homelabRoot + ' → ' + personal + ' / proj_home');
    expect(text).toContain(workRoot + ' → ' + work + ' / proj_work');
    expect(text).toContain('0 event(s) waiting to deliver');
    expect(text).toContain(work + ' (default for new repositories)');
  });

  it('uses the canonical remedy when a credential cannot renew', async () => {
    writeDeploymentMembership({ serverUrl: personal, token: 'A'.repeat(43), machineId: 'machine-one', joinedAt: 1, updatedAt: 1, refreshTerminal: true }, { mycoHome: home });
    const text = await report();
    expect(text).toContain('refused renewal');
    expect(text).toContain(REJOIN_HINT);
  });

  it('names repositories left alone by scoped logout and preserves the surviving route', async () => {
    const homelabRoot = path.join(scratch, 'homelab');
    const workRoot = path.join(scratch, 'work');
    join(personal, homelabRoot);
    join(work, workRoot);
    recordDefaultDeployment(personal, { mycoHome: home });
    await logoutDeployment(personal, { mode: 'local-only' }, {
      mycoHome: home, home: process.env.HOME, now: () => now,
      runtime: { aliases: async url => [url], snapshot: () => ({ agents: [], workerUrls: [], runner: false }), removeWorkers: () => {}, reconcile: () => {} },
    });
    const text = await report();
    expect(text).toContain(homelabRoot + ': left alone after logout from ' + personal);
    expect(text).toContain('will not automatically join it to another Myco');
    expect(text).toContain('myco member join');
    expect(text).toContain(workRoot + ' → ' + work);
    expect(text).not.toContain(homelabRoot + ' → ');
    clearLeft(rootKeyFor(homelabRoot, home), home);
    expect(await report()).not.toContain(homelabRoot + ': left alone');
  });

  it('detects leftover 1.4 state even after login without executing the managed binary', async () => {
    fs.mkdirSync(path.join(home, 'groves', 'old'), { recursive: true });
    fs.writeFileSync(path.join(home, 'groves', 'old', 'myco.db'), 'fixture');
    const bin = path.join(home, 'bin', 'myco');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    const sentinel = path.join(scratch, 'binary-executed');
    fs.writeFileSync(bin, '#!/bin/sh\ntouch "' + sentinel + '"\nexit 99\n', { mode: 0o700 });
    expect(useHomeDoctor(home)).toBe(false);
    join(personal);
    expect(useHomeDoctor(home)).toBe(true);
    const text = await report();
    expect(text).toContain('1.4 data may remain');
    expect(text).toContain('migration completion is not verified');
    expect(text).toContain('myco cutover --dry-run');
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('reports broken hooks and refused capture with the repair command', async () => {
    join(personal);
    const target = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/missing/myco hook session-start --symbiont claude-code --credential registry --myco-managed' }] }] } }));
    recordRefusedHook('no-credential', { mycoHome: home, now, hook: 'stop' });
    const text = await report();
    expect(text).toContain('is missing');
    expect(text).toContain('capture nothing');
    expect(text).toContain('declared no credential source');
    expect(text).toContain('myco member provision');
    const before = fs.readdirSync(path.join(home, 'member', 'refused-hooks'));
    refusedHookChecks(home, now + REFUSED_HOOK_RETENTION_MS + 1);
    expect(fs.readdirSync(path.join(home, 'member', 'refused-hooks'))).toEqual(before);
  });

  it('reports a stopped runner service and does not infer readiness from registration', async () => {
    const file = runnerRecordPath(personal, home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ version: 1, serverUrl: personal, name: 'homelab-mini', runnerId: 'runner_one', token: newRunnerBearer() }), { mode: 0o600 });
    installWorkerService({ executor: 'runner', serverUrl: personal, mycoHome: home, home: process.env.HOME!, binaryPath: path.join(home, 'bin', 'myco'), platform: 'linux' }, [], { runner: platform.runner });
    platform.running.clear();
    const text = await report();
    expect(text).toContain('registered homelab-mini');
    expect(text).toContain('installed, stopped');
    expect(text).toContain('unknown (no acknowledged service offer)');
    expect(text).toContain('myco runner status --server ' + personal);
    const lines: string[] = [];
    expect(await runMemberVerb('doctor', [], { ...deps, stdout: line => lines.push(line) })).toBe(true);
    expect(lines.join('\n')).not.toContain('no harness on this machine captures');
    expect(lines.join('\n')).not.toContain('myco login');
    expect(lines.join('\n')).not.toContain('myco member provision');
  });

  it('reports ordinary leave markers truthfully and malformed runner records as unavailable', async () => {
    const root = path.join(scratch, 'old-repository');
    fs.mkdirSync(root);
    markLeft(rootKeyFor(root, home), home, now);
    expect(await report()).toContain('path not recorded');
    expect(await report()).toContain('through Deployment settings');
    const file = runnerRecordPath(personal, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}', { mode: 0o600 });
    expect(useHomeDoctor(home)).toBe(true);
    expect(await report()).toContain('runner records could not be read');
    expect(await runMemberVerb('doctor', [], { ...deps, stdout: () => {} })).toBe(false);
  });

  it('surfaces unreadable membership state instead of reporting an empty home', async () => {
    fs.mkdirSync(path.join(home, 'member', 'deployments'), { recursive: true });
    fs.writeFileSync(path.join(home, 'member', 'deployments', 'broken.json'), '{}', { mode: 0o600 });
    const text = await report();
    expect(text).toContain('memberships could not all be read');
    expect(text).not.toContain('joined no Myco');
  });

  it('prints unavailable state when the Deployment directory cannot be listed', async () => {
    fs.mkdirSync(path.join(home, 'member'), { recursive: true });
    fs.writeFileSync(path.join(home, 'member', 'deployments'), 'not a directory');
    expect(useHomeDoctor(home)).toBe(true);
    const lines: string[] = [];
    expect(await runMemberVerb('doctor', [], { ...deps, stdout: line => lines.push(line) })).toBe(false);
    expect(lines.join('\n')).toContain('memberships could not all be read');
    expect(lines.join('\n')).toContain('service state unavailable');
  });
});
