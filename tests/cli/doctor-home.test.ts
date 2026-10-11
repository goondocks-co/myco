import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeReport, projectReport, refusedHookChecks, useHomeDoctor, type MemberDoctorDeps } from '@myco/cli/member-doctor.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { helpText, MEMBER_USAGE, runMemberVerb } from '@myco/cli/member-dispatch.js';
import { formatCheck } from '@myco/cli/doctor-member.js';
import { optOut } from '@myco/cli/member-auto-join.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { REJOIN_HINT } from '@myco/member/delivery-notice.js';
import { logoutDeployment } from '@myco/member/logout.js';
import { clearLeft, markLeft, rootKeyFor } from '@myco/member/auto-join.js';
import { recordProvision } from '@myco/symbionts/member-provision-record.js';
import { getPluginVersion } from '@myco/version.js';
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
    cwd: scratch, mycoHome: home, now: () => now, fetch: async () => new Response('{}', { status: 200 }),
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
    expect(lines.join('\n')).not.toContain('myco member provision');
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.existsSync(path.join(scratch, '.myco'))).toBe(false);
  });

  it('reports membership and local credential state without a project, checking only public server health', async () => {
    join(personal);
    recordDefaultDeployment(personal, { mycoHome: home });
    const text = await report();
    expect(text).toContain(personal + ' (default for new repositories)');
    expect(text).toContain('locally unexpired');
    expect(text).toContain('authentication not checked');
    expect(text).not.toContain('A'.repeat(43));
    const credential = (await homeReport(home, deps)).find(check => check.name === 'Credential')!;
    expect(credential.status).toBe('not-checked');
    expect(formatCheck(credential)).toContain('not checked');
    expect(formatCheck(credential)).not.toContain('\x1b[32m');
    expect(text).not.toContain('no member credential resolves for this project');
  });

  it('shows homelab and work routes together, independent of cwd', async () => {
    const homelabRoot = path.join(scratch, 'repos', 'homelab');
    const workRoot = path.join(scratch, 'repos', 'work');
    join(personal, homelabRoot);
    join(work, workRoot);
    recordDefaultDeployment(work, { mycoHome: home });
    recordProvision(home, { serverUrl: personal, agents: [], version: getPluginVersion(), at: now });
    const text = await report();
    expect(text).toContain(homelabRoot + ' → ' + personal + ' / proj_home');
    expect(text).toContain(workRoot + ' → ' + work + ' / proj_work');
    expect(text).toContain('0 event(s) waiting to deliver');
    expect(text).toContain(work + ' (default for new repositories)');
    const rows = await homeReport(home, deps);
    expect(rows.filter(check => check.name === 'Setup')).toHaveLength(1);
    expect(rows.some(check => check.name === 'Agents')).toBe(false);
    expect(text).not.toContain('no provisioning recorded for this Deployment');
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
    expect(text).toContain(homelabRoot + ': left alone after leaving ' + personal);
    expect(text).toContain('will not automatically join it to another Myco');
    expect((await homeReport(home, deps)).find(check => check.detail.includes(homelabRoot + ': left alone'))?.status).toBe('warn');
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
    expect(text).toContain('migration pending');
    expect(text).toContain(path.join(home, 'groves', 'old', 'myco.db'));
    expect(text).toContain('myco cutover --dry-run');
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it.each(['metadata', 'digest'] as const)('treats cutover-backed vaults as migrated using %s evidence', async evidence => {
    const vaults = [home, path.join(process.env.HOME!, '.myco')].map(directory => {
      const file = path.join(directory, 'groves', 'retained', 'myco.db');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const db = new Database(file);
      try { db.run('CREATE TABLE sessions (body TEXT)'); db.run("INSERT INTO sessions VALUES ('retained')"); } finally { db.close(); }
      return file;
    });
    expect(useHomeDoctor(home)).toBe(false);
    const backups = Object.fromEntries(vaults.map(file => {
      const stat = fs.statSync(file);
      return [file, evidence === 'metadata' ? { size: stat.size, mtimeMs: stat.mtimeMs } : { digest: readVaultContent(file).digest }];
    }));
    fs.mkdirSync(path.join(home, 'member'), { recursive: true });
    fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify({ backups }), { mode: 0o600 });
    expect(useHomeDoctor(home)).toBe(true);
    expect(helpText('legacy commands', deps)).toBe(MEMBER_USAGE);
    expect((await homeReport(home, deps)).filter(check => check.name === 'Myco 1.4')).toEqual([]);
    join(personal);
    const lines: string[] = [];
    await runMemberVerb('doctor', [], { ...deps, stdout: line => lines.push(line) });
    expect(lines.join('\n')).not.toContain('migration pending');
    expect(lines.join('\n')).not.toContain('Myco 1.4');
  });

  it('ignores empty groves and names pending vaults in the default home', async () => {
    fs.mkdirSync(path.join(home, 'groves'));
    expect(useHomeDoctor(home)).toBe(true);
    expect(helpText('legacy commands', deps)).toBe(MEMBER_USAGE);
    const vault = path.join(process.env.HOME!, '.myco', 'myco.db');
    fs.mkdirSync(path.dirname(vault), { recursive: true });
    fs.writeFileSync(vault, 'fixture');
    expect(useHomeDoctor(home)).toBe(false);
    expect(helpText('legacy commands', deps)).toBe('legacy commands');
    join(personal);
    const check = (await homeReport(home, deps)).find(check => check.name === 'Myco 1.4')!;
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('pending');
    expect(check.detail).toContain(vault);
  });

  it('surfaces unreadable migration evidence rather than claiming migration completed', async () => {
    fs.mkdirSync(path.join(home, 'groves', 'old'), { recursive: true });
    fs.writeFileSync(path.join(home, 'groves', 'old', 'myco.db'), 'fixture');
    fs.mkdirSync(path.join(home, 'member'), { recursive: true });
    fs.writeFileSync(path.join(home, 'member', 'cutover.json'), '{', { mode: 0o600 });
    expect(useHomeDoctor(home)).toBe(true);
    const check = (await homeReport(home, deps)).find(check => check.name === 'Myco 1.4')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('unavailable');
    expect(check.detail).toContain(path.join(home, 'member', 'cutover.json'));
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
    expect((await homeReport(home, deps)).find(check => check.detail.includes('is missing'))?.status).toBe('warn');
    expect((await homeReport(home, deps)).find(check => check.detail.includes('no harness'))?.status).toBe('fail');
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
    expect(text).toContain('myco runner install --server ' + personal);
    expect((await homeReport(home, deps)).find(check => check.name === 'Runner service')?.status).toBe('warn');
    expect((await homeReport(home, deps)).find(check => check.name === 'Runner offer')?.status).toBe('not-checked');
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

  it('warns on an expired credential and names the recovery command', async () => {
    writeDeploymentMembership({ serverUrl: personal, token: 'A'.repeat(43), machineId: 'machine-one', joinedAt: 1, updatedAt: 1, expiresAt: now - 1 }, { mycoHome: home });
    const credential = (await homeReport(home, deps)).find(check => check.name === 'Credential')!;
    expect(credential.status).toBe('warn');
    expect(credential.detail).toContain('expired');
    expect(credential.detail).toContain('myco login');
    writeRegistryEntry({ version: 2, root: scratch, projectId: 'proj_home', serverUrl: personal, token: 'A'.repeat(43), machineId: 'machine-one', joinedAt: 1, updatedAt: 1, expiresAt: now - 1 }, { mycoHome: home });
    const rows = await projectReport('registry', { ...deps, fetch: async () => { throw new Error('offline'); } });
    expect(rows.find(check => check.name === 'Credential')?.status).toBe('warn');

  });

  it('checks each membership health read-only with a bounded deadline from an unbound folder', async () => {
    join(personal);
    join(work);
    const seen: string[] = [];
    const before = fs.readFileSync(path.join(home, 'member', 'deployments', fs.readdirSync(path.join(home, 'member', 'deployments'))[0]), 'utf8');
    deps.fetch = async (input, init) => {
      seen.push(String(input));
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toBeUndefined();
      expect(init?.signal).toBeDefined();
      if (String(input).startsWith(work)) throw new Error('offline');
      return new Response('{}', { status: 200 });
    };
    const rows = await homeReport(home, deps);
    expect(seen.sort()).toEqual([personal + '/health', work + '/health'].sort());
    expect(rows.find(check => check.name === 'Deployment' && check.detail.includes(work))?.status).toBe('fail');
    expect(rows.find(check => check.name === 'Deployment' && check.detail.includes(personal))?.status).toBe('ok');
    expect(fs.readFileSync(path.join(home, 'member', 'deployments', fs.readdirSync(path.join(home, 'member', 'deployments'))[0]), 'utf8')).toBe(before);
    deps.requestTimeoutMs = 10;
    deps.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
    });
    expect((await homeReport(home, deps)).filter(check => check.name === 'Deployment').map(check => check.status)).toEqual(['fail', 'fail']);
  });

  it('records paths on ordinary leave and keeps good markers visible beside malformed markers', async () => {
    const root = path.join(scratch, 'left-repository');
    fs.mkdirSync(root);
    join(personal);
    await optOut(root, { serverUrl: personal, token: 'A'.repeat(43) }, { mycoHome: home, now, fetch: deps.fetch });
    const rows = await homeReport(home, deps);
    expect(rows.find(check => check.detail.includes(root + ': left alone after leaving ' + personal))?.status).toBe('warn');
    const left = path.join(home, 'member', 'auto-join', 'left');
    fs.writeFileSync(path.join(left, 'broken.json'), '{}', { mode: 0o600 });
    const text = await report();
    expect(text).toContain(root + ': left alone');
    expect(text).toContain('broken.json');
    expect(text).toContain('could not be read');
  });

  it('reports malformed default state', async () => {
    join(personal);
    fs.writeFileSync(path.join(home, 'member', 'default.json'), '{}', { mode: 0o600 });
    const selected = (await homeReport(home, deps)).find(check => check.name === 'Default Myco')!;
    expect(selected.status).toBe('warn');
    expect(selected.detail).toContain('malformed');
    expect(selected.detail).toContain('myco login');
  });

  it('prints machine facts once alongside repository access checks', async () => {
    join(personal, scratch);
    const lines: string[] = [];
    await runMemberVerb('doctor', [], { ...deps, stdout: line => lines.push(line), requestTimeoutMs: 20 });
    expect(lines.filter(line => line.includes('Membership ') && line.includes(personal))).toHaveLength(1);
    expect(lines.filter(line => line.includes('Credential '))).toHaveLength(1);
    expect(lines.filter(line => line.includes('Capture backlog'))).toHaveLength(1);
    expect(lines.some(line => line.includes('Spool '))).toBe(false);
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

describe('dated refusal and abandoned address guidance', () => {
  it('shows the newest time across the whole log and warns only for recent refusals', async () => {
    const { MemberSpool } = await import('@myco/member/spool.js');
    const { readRegistryEntry } = await import('@myco/member/registry.js');
    const at = Date.UTC(2026, 9, 11);
    deps.now = () => at;
    join(personal, scratch);
    const spool = new MemberSpool(readRegistryEntry(scratch, home)!, { mycoHome: home });
    const old = at - 8 * 24 * 60 * 60 * 1000;
    spool.appendRefused({ eventId: 'evt_old', sessionId: 'session', kind: 'session-end', code: 'refused', reason: 'old', at: old });
    let check = (await homeReport(home, deps)).find(row => row.name === 'Refusals')!;
    expect(check.status).toBe('ok');
    expect(check.detail).toContain(new Date(old).toISOString());
    expect(check.detail).toContain('0 in the last 7 days');
    expect(check.detail).toContain('myco logs');
    spool.appendRefused({ eventId: 'evt_recent', sessionId: 'session', kind: 'session-end', code: 'refused', reason: 'recent', at });
    for (let i = 0; i < 55; i++) spool.appendRefused({ eventId: 'evt_old', sessionId: 'session', kind: 'session-end', code: 'refused', reason: 'old', at: old });
    check = (await homeReport(home, deps)).find(row => row.name === 'Refusals')!;
    expect(check.status).toBe('warn');
    expect(check.detail).toContain(new Date(at).toISOString());
    expect(check.detail).toContain('1 in the last 7 days');
  });

  it('suggests local-only logout only for a long-expired credential at an unavailable address', async () => {
    const at = Date.UTC(2026, 9, 11);
    deps.now = () => at;
    const write = (expiresAt: number) => writeDeploymentMembership({ serverUrl: personal, token: 'A'.repeat(43), machineId: 'machine-one', joinedAt: 1, updatedAt: 1, expiresAt }, { mycoHome: home });
    write(at - 8 * 24 * 60 * 60 * 1000);
    deps.fetch = async () => { throw new Error('fixture offline'); };
    expect(await report()).toContain(`myco logout ${personal} --local-only`);
    deps.fetch = async () => new Response('{}');
    expect(await report()).not.toContain('--local-only');
    deps.fetch = async () => { throw new Error('fixture offline'); };
    write(at - 1000);
    expect(await report()).not.toContain('--local-only');
  });

  it('prints the server code and reason from the persisted log while export omits free text', async () => {
    const { MemberSpool } = await import('@myco/member/spool.js');
    const { readRegistryEntry } = await import('@myco/member/registry.js');
    const { projectDiagnostics } = await import('@myco/member/diagnostics.js');
    join(personal, scratch);
    const entry = readRegistryEntry(scratch, home)!;
    new MemberSpool(entry, { mycoHome: home }).appendRefused({
      eventId: 'evt_1', sessionId: 'session', kind: 'session-end', code: 'refused',
      serverCode: 'fixture_server_refusal', reason: 'fixture reason for refusal', at: now,
    });
    const lines: string[] = [];
    expect(await runMemberVerb('logs', [], { ...deps, stdout: line => lines.push(line) })).toBe(true);
    expect(lines.join('\n')).toContain('fixture_server_refusal: fixture reason for refusal');
    expect(JSON.stringify(projectDiagnostics(entry, home, now))).not.toContain('fixture reason for refusal');
  });
});
