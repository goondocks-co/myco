import { recordMissingMembership, MISSING_MEMBERSHIP_RETENTION_MS } from '@myco/member/no-membership.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as setup } from '@myco/cli/setup.js';
import { homeReport, projectReport, refusedHookChecks, useHomeDoctor, type MemberDoctorDeps } from '@myco/cli/member-doctor.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { writeCutoverState, legacyMigrationState, type CutoverState } from '@myco/member/legacy-migration.js';
import { runMemberVerb } from '@myco/cli/member-dispatch.js';
import { helpText, MEMBER_USAGE } from '@myco/cli/help.js';
import { runDrain, runProvision } from '@myco/cli/member.js';
import { MemberSpool } from '@myco/member/spool.js';
import { CaptureLossLedger } from '@myco/member/capture-loss.js';
import { promptEvent, mintId } from '@myco/member/envelope.js';
import { updateSessionState } from '@myco/member/session-state.js';
import { formatCheck } from '@myco/cli/doctor-member.js';
import { optOut } from '@myco/cli/member-auto-join.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { REJOIN_HINT } from '@myco/member/delivery-notice.js';
import { logoutDeployment } from '@myco/member/logout.js';
import { clearLeft, markLeft, rootKeyFor } from '@myco/member/auto-join.js';
import { recordProvision } from '@myco/symbionts/member-provision-record.js';
import { getPluginVersion } from '@myco/version.js';
import { deploymentKeyFor, readRegistryEntry, writeDeploymentMembership, writeRegistryEntry } from '@myco/member/registry.js';
import { recordRefusedHook, REFUSED_HOOK_RETENTION_MS } from '@myco/member/refused-hooks.js';
import { newRunnerBearer, runnerRecordPath } from '@myco/runner/runner-registry.js';
import { installWorkerService } from '@myco/runner/service.js';
import { recordingPlatform } from '../member/helpers/service-platform.js';
import { statusHome, STATUS_NOW } from '../setup/fixtures/status-home.js';
import { writeRetainedLegacyVault } from '../helpers/legacy-migration-fixture.js';

let scratch: string;
let home: string;
let deps: MemberDoctorDeps;
let platform: ReturnType<typeof recordingPlatform>;
let savedHome: string | undefined;
const now = Date.parse('2026-11-16T12:00:00Z');
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
function join(serverUrl: string, root?: string, projectId = serverUrl === work ? 'proj_work' : 'proj_home') {
  const membership = { serverUrl, token: 'A'.repeat(43), machineId: 'machine-one', joinedAt: 1, updatedAt: 1, expiresAt: now + 7 * 86400_000 };
  if (root) {
    fs.mkdirSync(root, { recursive: true });
    writeRegistryEntry({ ...membership, version: 2, root, projectId }, { mycoHome: home });
  } else writeDeploymentMembership(membership, { mycoHome: home });
}
const report = async () => (await homeReport(home, deps)).map(check => check.detail).join('\n');

describe('home doctor', () => {
  const output = async (args: string[] = []) => {
    const lines: string[] = [];
    const ok = await runMemberVerb('doctor', args, { ...deps, renew: false, stdout: line => lines.push(line) });
    if (lines[0]?.startsWith('myco doctor')) {
      const heading = lines[0].match(/\((\d+) failed, (\d+) warnings?\)/);
      const counts = { FAIL: 0, WARN: 0 };
      for (const line of lines) {
        const match = args.includes('--all') ? line.match(/^  \S.*?: (FAIL|WARN) /) : line.match(/^  (FAIL|WARN) /);
        if (match) counts[match[1] as 'FAIL' | 'WARN'] += 1;
      }
      expect([counts.FAIL, counts.WARN]).toEqual(heading ? [Number(heading[1]), Number(heading[2])] : [0, 0]);
    }
    return { ok, text: lines.join('\n'), lines };
  };
  const setupOutput = async () => {
    const lines: string[] = [];
    const code = await setup(['--status'], { ...deps, agents: () => ['claude-code'], stdout: line => lines.push(line) });
    return { code, text: lines.join('\n') };
  };
  const connectedHome = () => {
    const roots = Array.from({ length: 15 }, (_, index) => path.join(scratch, `repository-${index + 1}`));
    for (const [index, root] of roots.entries()) join(personal, root, `proj_repo_${index + 1}`);
    const binary = path.join(home, 'bin', 'myco');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    runProvision(['--server', personal], { mycoHome: home, cwd: scratch, agents: () => ['claude-code', 'codex', 'cursor', 'opencode', 'antigravity', 'windsurf'], stdout: () => {} });
    return roots;
  };

  const connectedCapture = () => {
    const roots = connectedHome();
    return { roots, root: roots[0], spool: new MemberSpool(readRegistryEntry(roots[0], home)!, { mycoHome: home }) };
  };
  const transcript = (spool: MemberSpool, sessionId: string, at: number) => {
    const file = path.join(scratch, `${sessionId}.jsonl`);
    fs.writeFileSync(file, 'test');
    fs.utimesSync(file, new Date(at), new Date(at));
    updateSessionState(spool.dir, sessionId, state => {
      state.transcript = { path: file, transcriptId: sessionId, inode: 1, nextOffset: 0, parsedSize: 4 };
      state.hookAt = at;
      state.lastDeliveryAt = now - 4 * 60_000;
    }, at);
    return file;
  };

  it('finishes an earlier move with no transcript pass, but keeps failed history and transcript passes unfinished', async () => {
    connectedHome();
    recordDefaultDeployment(personal, { mycoHome: home });
    const vault = path.join(home, 'groves', 'retained', 'myco.db');
    writeRetainedLegacyVault(vault);
    const db = new Database(vault);
    try { db.run("UPDATE sessions SET project_id='proj_repo_1'"); } finally { db.close(); }
    const { size, mtimeMs } = fs.statSync(vault);
    const project = { destination: { serverUrl: personal, key: deploymentKeyFor(personal) }, vault: { state: 'complete' as const, at: 1 } };
    const state: CutoverState = { backups: {}, handover: { at: 1, legacyHomes: [home], agents: [] }, migrations: { [vault]: { ...readVaultContent(vault), size, mtimeMs, projects: { proj_repo_1: project } } } };
    writeCutoverState(home, state);
    const status: string[] = [];
    const statusDeps = { ...deps, fetch: async () => Response.json({ persisted: true, projectState: 'active' }), agents: () => ['claude-code'], stdout: (line: string) => status.push(line) };
    expect(await setup(['--status'], statusDeps)).toBe(0);
    expect(status.join('\n')).toContain('Myco 1.4 data has been moved.');
    expect(status.join('\n')).toContain('Earlier agent transcripts were not imported.');
    expect((await output()).text).not.toContain('Earlier history:');
    expect((await output(['--all'])).text).toContain('myco cutover --import-transcripts');
    for (const failure of [{ ...project, vault: { state: 'partial' as const, at: 1 } }, { ...project, transcripts: { state: 'partial' as const, at: 1, endedBy: 'forbidden' } }]) {
      state.migrations![vault].projects.proj_repo_1 = failure;
      writeCutoverState(home, state);
      status.length = 0;
      expect(await setup(['--status'], statusDeps)).toBe(3);
      expect(status.join('\n')).toContain('Some Myco 1.4 data has not finished moving');
      const doctor = await output();
      expect(doctor.ok).toBe(true);
      expect(doctor.text).toContain('WARN Earlier history:');
    }
  });

  it('summarizes fifteen healthy repositories and six agents, with every item available under --all', async () => {
    const roots = connectedHome();
    const compact = await output();
    expect(compact.ok).toBe(true);
    expect(compact.text).toContain('nothing needs attention');
    expect(compact.text).toContain('15 repositories connected');
    expect(compact.text).toContain('6 agents connected');
    expect(compact.text).toContain('tools configured for 6 agents');
    expect(compact.text).toContain('nothing waiting to deliver');
    expect(compact.lines).toHaveLength(9);
    const summary = compact.lines.findIndex(line => line.startsWith('  Also checked:'));
    expect(compact.lines[summary]).toContain('Myco connection');
    expect(compact.lines[summary]).not.toContain('Sign-in');
    expect(compact.text).toContain('Not verified: Sign-in');
    expect(compact.lines.findIndex(line => line.startsWith('  Capture waiting:'))).toBeLessThan(summary);
    expect(compact.lines.findIndex(line => line.startsWith('  Capture losses:'))).toBeLessThan(summary);
    expect(compact.text).not.toContain('ok Capture');
    expect(compact.lines.at(-1)).toBe('  7 checks not verified at runtime; use myco doctor --all for every check and detail.');
    expect(compact.text).not.toContain('\x1b');
    expect(compact.text).not.toContain(roots[0]);
    const all = await output(['--all']);
    for (const root of roots) expect(all.text).toContain(root);
    expect(all.text).toContain('capture execution not checked');
    expect(all.ok).toBe(true);
    deps.cwd = roots[0];
    deps.env = { ...process.env, MYCO_HOME: home };
    deps.fetch = async (_input, init) => {
      if (!init?.body) return Response.json({ ok: true });
      const request = JSON.parse(String(init.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : { tools: [] } });
    };
    expect((await output()).text).toContain('tools configured for 6 agents');
    const detail = (await output(['--all'])).text;
    expect(detail).toContain('config:');
    expect(detail).toContain('Myco home:');
    expect(detail).not.toContain('…');
    expect((await output(['--fix'])).ok).toBe(false);
  });

  it('lists only the repository needing attention among fifteen and preserves warning and failure outcomes', async () => {
    const roots = connectedHome();
    markLeft(rootKeyFor(roots[3], home), home, now, { repository: { root: roots[3] } });
    const warning = await output();
    expect(warning.ok).toBe(true);
    expect(warning.text).toContain('1 check needs attention');
    expect(warning.text).toContain(roots[3]);
    expect(warning.text).toContain('myco member join');
    expect(warning.text).not.toContain(roots[2]);
    deps.fetch = async () => { throw new Error('offline'); };
    const failed = await output();
    expect(failed.ok).toBe(false);
    expect(failed.text).toContain('FAIL Deployment:');
    expect(failed.lines.find(line => line.startsWith('  Also checked:'))).not.toContain('Deployment');
  });

  it('counts sessions with events and transcripts once, including transcript-only sessions', async () => {
    const { roots: [root, alias], spool } = connectedCapture();
    writeRegistryEntry({ ...readRegistryEntry(root, home)!, root: alias }, { mycoHome: home });
    for (const sessionId of ['both', 'transcript-only']) transcript(spool, sessionId, now - 120_000);
    spool.append('both', promptEvent({ agent: 'claude-code', sessionId: 'both', now: () => now - 180_000 }, { promptId: mintId(), text: 'waiting event' }));
    const result = await output();
    expect(result.ok).toBe(true);
    expect((await output(['--all'])).text).toContain('2 sessions waiting (1 with events, 2 with transcripts); oldest activity 3 minutes ago');
    expect(result.text).toContain('myco member drain');
    expect((await output(['--all'])).text).toContain('proj_repo_1 (2 connected repositories:');
  });

  it('keeps growing transcripts and sessions idle between turns out of attention', async () => {
    const { root, spool } = connectedCapture();
    recordDefaultDeployment(personal, { mycoHome: home });
    spool.append('live', promptEvent({ agent: 'claude-code', sessionId: 'live', now: () => now - 1000 }, { promptId: mintId(), text: 'capture in progress' }));
    for (const [sessionId, minutes] of [['live', 1], ['idle', 57]] as const) transcript(spool, sessionId, now - minutes * 60_000);
    const compact = await output();
    expect(compact.text).toContain('nothing needs attention');
    expect(compact.text).toContain('2 sessions in progress; last delivery');
    expect(compact.text).not.toContain('myco member drain');
    expect((await output(['--all'])).text).toContain('2 sessions waiting (1 with events, 2 with transcripts)');
    const status = await setupOutput();
    expect(status.code).toBe(0);
    expect(status.text).not.toContain('needs attention');
    expect(status.text).toContain('capture in progress');
  });

  it('names the repository when a quiet transcript has not delivered', async () => {
    const { root, spool } = connectedCapture();
    transcript(spool, 'quiet', now - 3 * 60 * 60_000);
    const result = await output();
    expect(result.ok).toBe(true);
    const problem = result.lines.find(line => line.startsWith('  WARN Capture waiting:'))!;
    expect(problem).toContain(root);
    expect(problem).toContain('myco member drain');
    expect((await setupOutput()).text).toContain('session needs delivery');
  });

  it('keeps unconnected folder requests and older unrecognized records informational under --all', async () => {
    connectedHome();
    const folders = ['background', 'temporary', 'home'].map(name => path.join(scratch, name));
    for (const root of [...folders, folders[0]]) recordMissingMembership(root, { mycoHome: home, now: () => now });
    fs.writeFileSync(path.join(home, 'member', 'unmembered', 'earlier.json'), JSON.stringify({ version: 1, root: folders[0], count: 253, firstAt: now - 2 * MISSING_MEMBERSHIP_RETENTION_MS, lastAt: now - 2 * MISSING_MEMBERSHIP_RETENTION_MS }), { mode: 0o600 });
    const compact = await output();
    expect(compact.text).toContain('nothing needs attention');
    expect(compact.text).not.toContain('could not read');
    expect(compact.text).not.toContain('myco member join');
    expect(compact.text).not.toContain('outside connected repositories');
    const all = await output(['--all']);
    expect(all.text).toContain('Unconnected folders: info 4 requests outside connected repositories');
    expect(all.text).toContain('last 30 days');
    expect(all.text).toContain(`most recent ${new Date(now).toISOString()}`);
    for (const root of folders) expect(all.text).toContain(root);
    expect(all.text).toContain('1 unrecognized folder records omitted');
  });

  it('names an unreadable capture loss file in the default report', async () => {
    const { root, spool } = connectedCapture();
    const file = path.join(spool.dir, 'capture-losses.json');
    fs.writeFileSync(file, '{broken', { mode: 0o600 });
    const result = await output();
    const problem = result.lines.find(line => line.startsWith('  WARN Capture losses:'))!;
    expect(problem).toContain(file);
    expect(problem).toContain('malformed');
  });

  it('reports recent loss kinds and dates without counting old losses as recent', async () => {
    const { root, spool } = connectedCapture();
    fs.unlinkSync(transcript(spool, 'missing-transcript', now));
    spool.markTranscriptBacklog('missing-transcript');
    await runDrain([], { ...deps, cwd: root, stdout: () => {} });
    await runDrain([], { ...deps, cwd: root, stdout: () => {} });
    new CaptureLossLedger(spool.dir, () => now).record([{ kind: 'payload', key: 'future-clock', at: now + 400 * 86400_000 }]);
    new CaptureLossLedger(spool.dir, () => now).record([
      { kind: 'payload', key: 'recent', at: now }, { kind: 'plan', key: 'old', at: now - 10 * 86400_000 },
      { kind: 'record', key: 'damage', at: now },
    ]);
    const result = await output();
    expect(result.ok).toBe(true);
    expect(result.text).toContain('1 lost payload, 1 damaged record, 1 unavailable transcript');
    expect((await setupOutput()).text).toContain('1 lost payload, 1 damaged record, 1 unavailable transcript');
    expect(result.text).toContain('last 7 UTC days (including today)');
    expect(result.text).toContain(`most recent ${new Date(now).toISOString()}`);
    expect(result.text).not.toContain('1 lost plan');
    expect(result.text).toContain('Recorded history cannot be repaired by a command');
    expect(result.text).toContain('clear after 7 UTC days');
    expect(result.text).not.toContain('myco member provision --refresh');
    expect((await output(['--all'])).text).toContain(`Affected repositories or Projects: ${root}`);
  });

  it('keeps previous-build loss totals as a detail note without raising attention', async () => {
    const { root, spool } = connectedCapture();
    fs.writeFileSync(path.join(spool.dir, 'capture-losses.json'), JSON.stringify({ version: 1, payloads: 3, plans: 0, records: 1, recent: [], lastAt: now - 200 * 86400_000 }), { mode: 0o600 });
    const compact = await output();
    expect(compact.ok).toBe(true);
    expect(compact.text).toContain('nothing needs attention');
    expect(compact.text).not.toContain('earlier losses');
    expect((await output(['--all'])).text).toContain('Historical note: 4 earlier losses have no dates');
  });

  it('reports a fresh machine outside a repository without opening a local vault', async () => {
    expect(useHomeDoctor(home)).toBe(true);
    const lines: string[] = [];
    expect(await runMemberVerb('doctor', [], { ...deps, stdout: line => lines.push(line) })).toBe(true);
    expect(lines.join('\n')).toContain('joined no Myco');
    expect(lines.join('\n')).toContain('this machine has joined no Myco. Run `myco setup`.');
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

  it('leads capture observations with their repository before the recovery command', async () => {
    const fixture = statusHome(path.join(scratch, 'capture'));
    const rows = await homeReport(fixture.home, { ...deps, now: () => STATUS_NOW });
    for (const [name, root, command, status] of [
      ['Capture backlog', fixture.repositories[0], 'myco member drain', 'info'],
      ['Capture', fixture.repositories[0], 'myco member drain', 'warn'],
      ['Refusals', fixture.repositories[1], 'myco logs', 'warn'],
    ]) {
      const check = rows.find(check => check.name === name && check.detail.startsWith(root + ':'));
      expect(check?.status).toBe(status);
      expect(check?.detail.indexOf(command)).toBeGreaterThan(root.length);
    }
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
    writeRetainedLegacyVault(path.join(home, 'groves', 'old', 'myco.db'));
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
    expect(legacyMigrationState(home).state).toBe('needs-destination');
    expect(useHomeDoctor(home)).toBe(true);
    const confirmation = (await homeReport(home, deps)).find(check => check.name === 'Migration');
    expect(confirmation?.status).toBe('warn');
    expect(confirmation?.detail).toContain('moved by an earlier version');
    expect(confirmation?.detail).toContain('confirm where each project went');
    expect(confirmation?.detail).toContain('myco cutover --dry-run');
    const unbound: string[] = [];
    expect(await runMemberVerb('doctor', [], { ...deps, stdout: line => unbound.push(line) })).not.toBeNull();
    expect(unbound.join('\n')).toContain('myco doctor (member)');
    expect(unbound.join('\n')).toContain('confirm where each project went');
    expect(unbound.join('\n')).not.toContain('migration pending');
    expect(helpText(deps)).toBe(MEMBER_USAGE);
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
    expect(helpText(deps)).toBe(MEMBER_USAGE);
    const vault = path.join(process.env.HOME!, '.myco', 'myco.db');
    fs.mkdirSync(path.dirname(vault), { recursive: true });
    writeRetainedLegacyVault(vault);
    expect(useHomeDoctor(home)).toBe(false);
    expect(helpText(deps)).toContain(MEMBER_USAGE);
    expect(helpText(deps)).toContain('myco cutover --dry-run');
    join(personal);
    const check = (await homeReport(home, deps)).find(check => check.name === 'Myco 1.4')!;
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('pending');
    expect(check.detail).toContain(vault);
  });

  it('does not call backup-only evidence moved while legacy hooks still own capture', async () => {
    const vault = path.join(home, 'myco.db');
    writeRetainedLegacyVault(vault);
    fs.mkdirSync(path.join(home, 'member'), { recursive: true });
    fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify({ backups: { [vault]: {} } }), { mode: 0o600 });
    const settings = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${home}/bin/myco hook session-start --myco-managed` }] }] } }));
    expect(legacyMigrationState(home)).toMatchObject({ state: 'needs-destination', legacyOwnsCapture: true });
    const check = (await homeReport(home, deps)).find(check => check.name === 'Migration')!;
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('still own capture');
    expect(check.detail).not.toContain('moved by an earlier version');
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
    expect(helpText(deps)).toBe(MEMBER_USAGE);
  });

  it('names the offending agent registration file when migration cannot be read', async () => {
    const file = path.join(process.env.HOME!, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[mcp_servers.myco\ncommand="myco"\n');
    expect(legacyMigrationState(home)).toMatchObject({ state: 'unavailable', file });
    const check = (await homeReport(home, deps)).find(check => check.name === 'Myco 1.4')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain(`Inspect ${file}`);
    expect(check.detail).not.toContain(`Inspect ${home},`);
    expect(helpText(deps)).toBe(MEMBER_USAGE);
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
    await runMemberVerb('doctor', ['--all'], { ...deps, stdout: line => lines.push(line), requestTimeoutMs: 20 });
    expect(lines.filter(line => line.includes('Membership:') && line.includes(personal))).toHaveLength(1);
    expect(lines.filter(line => line.includes('Credential:'))).toHaveLength(1);
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

  it('preserves long local diagnostics while stripping hostile terminal controls', async () => {
    const { describeWorkerService } = await import('@myco/cli/worker-service.js');
    join(personal, scratch);
    const status = describeWorkerService(personal, deps.worker)!;
    const local = 'x'.repeat(1_000);
    const hostile = '\x1b]0;title\x07\x1b[2J\x00\r' + local;
    fs.mkdirSync(path.dirname(status.errLog), { recursive: true });
    fs.writeFileSync(status.errLog, `${local}\n${hostile}\n`);
    const lines: string[] = [];
    await runMemberVerb('logs', [], { ...deps, stdout: line => lines.push(line) });
    expect(lines).toEqual(expect.arrayContaining([local, ' ]0;title  [2J  ' + local]));
  });

  it('bounds and escapes every refusal field and restores empty kind and event labels', async () => {
    const { MemberSpool, REFUSED_LOG_FILE } = await import('@myco/member/spool.js');
    const { readRegistryEntry } = await import('@myco/member/registry.js');
    join(personal, scratch);
    const spool = new MemberSpool(readRegistryEntry(scratch, home)!, { mycoHome: home });
    const hostile = '\x1b]0;title\x07\x1b[2J\x00\r\nFORGED\x85' + 'x'.repeat(100_000);
    const entries = [hostile, undefined].map(serverCode => ({
      eventId: hostile, sessionId: hostile, kind: hostile, code: hostile, serverCode, reason: hostile, at: now,
    }));
    fs.writeFileSync(path.join(spool.dir, REFUSED_LOG_FILE), [
      ...entries,
      { eventId: '', sessionId: 'unknown', kind: '', code: 'refused', reason: 'unparsable spool line', at: now },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const lines: string[] = [];
    expect(await runMemberVerb('logs', [], { ...deps, stdout: line => lines.push(line) })).toBe(true);
    const printed = lines.filter(line => line.startsWith(new Date(now).toISOString()));
    expect(printed).toHaveLength(3);
    for (const line of printed) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(line.length).toBeLessThanOrEqual(1_100);
    }
    expect(printed[0].match(/…/g)).toHaveLength(5);
    expect(printed[1].match(/…/g)).toHaveLength(5);
    expect(printed[2]).toContain('unknown kind unknown event session unknown: refused: unparsable spool line');
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
