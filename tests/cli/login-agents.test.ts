/**
 * `myco login` sets up the agents installed on this machine (#1499).
 *
 * A person who follows "install, then login" captures from their first session: every agent the machine has is
 * provisioned for the Deployment, through the cutover's own detection and ownership preview. An agent whose entries
 * belong to another installation is left byte for byte as it is and named.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { run } from '@myco/cli/login.js';
import { detectedProvisionLines, runProvision } from '@myco/cli/member.js';
import { isBinaryOnPath } from '@myco/symbionts/detect.js';
import { writeDeploymentMembership, deploymentKeyFor } from '@myco/member/registry.js';
import { unjoinedRig } from '../member/helpers/server.js';
import { recordingPlatform } from '../member/helpers/service-platform.js';
import { readProvisionRecord } from '@myco/symbionts/member-provision-record.js';
import { readDeploymentMembership } from '@myco/member/registry.js';
import { LEGACY_AGENT_DEFERRAL } from '@goondocks/myco-shared/setup-guidance';
import { Database } from 'bun:sqlite';
import { legacyMigrationState } from '@myco/member/legacy-migration.js';
import { legacyVaultStamp } from '@myco/member/legacy-sources.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { withLegacyBinaryTraps } from '../helpers/legacy-migration-fixture.js';

describe('myco login sets up the agents on this machine', () => {
  let home: string;
  let root: string;
  let out: string[];
  let err: string[];
  const userHome = os.homedir();
  const claudeDir = path.join(userHome, '.claude');
  const codexDir = path.join(userHome, '.codex');
  const agentFiles = [claudeDir, codexDir, path.join(userHome, '.claude.json')];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-login-agents-home-'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-login-agents-root-'));
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    for (const file of agentFiles) fs.rmSync(file, { recursive: true, force: true });
    out = [];
    err = [];
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    for (const file of agentFiles) fs.rmSync(file, { recursive: true, force: true });
  });

  const platform = recordingPlatform();
  const deps = (rig: ReturnType<typeof unjoinedRig>, extra: Record<string, unknown> = {}) => ({
    fetch: rig.fetch as typeof fetch, mycoHome: home, machineId: 'machine_person', cwd: root,
    stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l),
    worker: {
      home, platform: 'darwin' as const, binaryPath: path.join(home, 'bin', 'myco'), detect: () => [], harnessDirs: () => [],
      ownDeploymentUrls: async () => [], admission: async () => 'admitted' as const, lockDir: path.join(home, 'locks'), runner: platform.runner,
    },
    ...extra,
  });
  const invite = async (rig: ReturnType<typeof unjoinedRig>, projectId?: string) =>
    `https://s/join#${(await issueEnrollmentAuthority(rig.env.db, Date.now(), { issuer: { kind: 'operator' }, role: 'member', ...(projectId === undefined ? {} : { projectId }) })).key}`;
  const read = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

  it('provisions every agent it detects for the Deployment, with no project connected yet, and says so', async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    const rig = unjoinedRig();
    expect(await run([await invite(rig)], deps(rig))).toBe(true);
    const hooks = read(path.join(claudeDir, 'settings.json')) ?? '';
    expect(hooks).toContain('--credential registry');
    expect(read(path.join(userHome, '.claude.json')) ?? '').toContain('https://s');
    expect(read(path.join(codexDir, 'hooks.json')) ?? '').toContain('--credential registry');
    expect(read(path.join(codexDir, 'config.toml')) ?? '').toContain('https://s');
    expect(out.join('\n')).toContain('Capture is set up for Claude Code, Codex.');
    expect(err).toEqual([]);
  });

  it('sets up the agents of a sign-in with no project, and provisions and refreshes them, where the home could be no project folder', async () => {
    // A home at the user's home directory, the way `/root/.myco` sits one below a home parent: no project root may be there.
    fs.mkdirSync(claudeDir, { recursive: true });
    const priorPath = process.env.PATH;
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'), process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${priorPath ?? ''}`;
    const homedir = spyOn(os, 'homedir').mockReturnValue(home);
    try {
      expect(isBinaryOnPath('claude')).toBe(true);
      const rig = unjoinedRig();
      expect(await run([await invite(rig)], deps(rig, { agents: () => ['claude-code'] }))).toBe(true);
      expect(read(path.join(claudeDir, 'settings.json')) ?? '').toContain('--credential registry');
      expect(out.join('\n')).toContain('Capture is set up for Claude Code.');
      out = [];
      expect(runProvision([], { mycoHome: home, cwd: root, agents: () => ['claude-code'], stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(true);
      expect(runProvision(['--refresh'], { mycoHome: home, cwd: root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(true);
      expect(out).toEqual(['Capture is set up for Claude Code.', 'Capture is set up for Claude Code.']);
      expect(err).toEqual([]);
    } finally {
      homedir.mockRestore();
      if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    }
  });

  it('leaves an agent whose hooks belong to another installation byte for byte as it is, names it, and sets up the rest', async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    const foreign = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/opt/other/bin/myco hook session-start --symbiont claude-code --myco-managed' }] }] } }, null, 2);
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), foreign);
    const rig = unjoinedRig();
    expect(await run([await invite(rig)], deps(rig))).toBe(true);
    expect(read(path.join(claudeDir, 'settings.json'))).toBe(foreign);
    expect(out.join('\n')).toMatch(/Skipped Claude Code: .*another installation/);
    expect(out.join('\n')).toContain('Capture is set up for Codex.');
    expect(read(path.join(codexDir, 'hooks.json')) ?? '').toContain('--credential registry');
  });

  it('sets up nothing with --no-agents, and a later `member provision` sets them all up from the membership alone', async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    const rig = unjoinedRig();
    expect(await run([await invite(rig), '--no-agents'], deps(rig))).toBe(true);
    expect(read(path.join(claudeDir, 'settings.json'))).toBeNull();
    expect(out.join('\n')).not.toContain('Capture is set up');
    // What `myco upgrade` and `myco update` run keeps the choice: no agent is set up on its own.
    expect(runProvision(['--refresh'], { mycoHome: home, cwd: root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(true);
    expect(read(path.join(claudeDir, 'settings.json'))).toBeNull();
    expect(out.at(-1)).toBe('No agent is set up for Myco on this machine; `myco member provision` sets them up.');
    out = [];
    expect(runProvision([], { mycoHome: home, cwd: root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(true);
    expect(read(path.join(claudeDir, 'settings.json')) ?? '').toContain('--credential registry');
    expect(out).toEqual(['Capture is set up for Claude Code.']);
    // Idempotent: a second run changes nothing and says the agent is already set up.
    const before = read(path.join(claudeDir, 'settings.json'));
    out = [];
    expect(runProvision([], { mycoHome: home, cwd: root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(true);
    expect(read(path.join(claudeDir, 'settings.json'))).toBe(before);
    expect(out).toEqual(['Capture is set up for Claude Code.']);
  });

  it('defers without recording a decline, then provisions from the saved membership without another login', async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    const rig = unjoinedRig();
    expect(await run([await invite(rig)], deps(rig, { provision: 'defer', agents: () => ['claude-code'] }))).toBe(true);
    expect(read(path.join(claudeDir, 'settings.json'))).toBeNull();
    expect(readProvisionRecord(home)).toBeNull();
    const membership = readDeploymentMembership('https://s', home);
    expect(membership).not.toBeNull();
    expect(runProvision([], { mycoHome: home, cwd: root, agents: () => ['claude-code'], stdout: (l) => out.push(l) })).toBe(true);
    expect(read(path.join(claudeDir, 'settings.json'))).toContain('--credential registry');
    expect(readDeploymentMembership('https://s', home)).toEqual(membership);
  });

  it('preserves an explicit decline even when the caller defers provisioning', async () => {
    const rig = unjoinedRig();
    expect(await run([await invite(rig), '--no-agents'], deps(rig, { provision: 'defer' }))).toBe(true);
    expect(readProvisionRecord(home)?.agents).toEqual([]);
  });

  for (const choice of ['now', 'defer', 'no-agents'] as const) for (const metadata of [false, true]) it(`confirms a backup-only alpha machine and provisions when requested (${metadata ? 'metadata' : 'digest'}, ${choice})`, async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    const vault = path.join(home, 'groves', 'legacy', 'myco.db');
    fs.mkdirSync(path.dirname(vault), { recursive: true });
    const db = new Database(vault);
    try { db.run('CREATE TABLE sessions (body TEXT)'); db.run("INSERT INTO sessions VALUES ('retained')"); } finally { db.close(); }
    const evidence = metadata ? legacyVaultStamp(vault) : { digest: readVaultContent(vault).digest };
    fs.mkdirSync(path.join(home, 'member'), { recursive: true });
    fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify({ backups: { [vault]: evidence } }), { mode: 0o600 });
    expect(legacyMigrationState(home).state).toBe('needs-destination');
    const rig = unjoinedRig();
    expect(await run([await invite(rig), ...(choice === 'no-agents' ? ['--no-agents'] : [])], deps(rig, { agents: () => ['claude-code'], provision: choice === 'defer' ? 'defer' : 'now' }))).toBe(true);
    expect(out).not.toContain(LEGACY_AGENT_DEFERRAL);
    expect(out.filter(line => line.includes('Earlier moves are unconfirmed'))).toEqual([
      'Earlier moves are unconfirmed; run `myco setup --cutover` to review each project destination, or preview manually with `myco cutover --dry-run`.',
    ]);
    if (choice === 'now') expect(read(path.join(claudeDir, 'settings.json'))).toContain('--credential registry');
    else expect(read(path.join(claudeDir, 'settings.json'))).toBeNull();
  });

  it('defers a backup-only machine whose legacy hooks still own capture', async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    const settings = path.join(claudeDir, 'settings.json');
    const legacy = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${home}/bin/myco hook session-start --symbiont claude-code --myco-managed` }] }] } });
    fs.writeFileSync(settings, legacy);
    const vault = path.join(home, 'groves', 'legacy', 'myco.db');
    fs.mkdirSync(path.dirname(vault), { recursive: true }); fs.writeFileSync(vault, 'retained');
    fs.mkdirSync(path.join(home, 'member'), { recursive: true });
    fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify({ backups: { [vault]: {} } }), { mode: 0o600 });
    const rig = unjoinedRig();
    expect(await run([await invite(rig)], deps(rig, { agents: () => { throw new Error('must defer legacy hooks'); } }))).toBe(true);
    expect(out).toContain('Agent setup is deferred because retained Myco 1.4 history has no complete migration receipt. Run myco setup --cutover to review and move it, or preview manually with myco cutover --dry-run.');
    expect(read(settings)).toBe(legacy);
  });

  for (const owned of [false, true]) it(`handover-pending defers only while legacy hooks still own capture (${owned})`, async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    const vault = path.join(home, 'groves', 'legacy', 'myco.db');
    fs.mkdirSync(path.dirname(vault), { recursive: true });
    const db = new Database(vault);
    try { db.run('CREATE TABLE sessions (body TEXT)'); } finally { db.close(); }
    fs.mkdirSync(path.join(home, 'member'), { recursive: true });
    fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify({ version: 2, backups: {}, migrations: {
      [vault]: { ...legacyVaultStamp(vault), digest: readVaultContent(vault).digest, projects: {} },
    } }), { mode: 0o600 });
    const settings = path.join(claudeDir, 'settings.json');
    if (owned) fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${home}/bin/myco hook session-start --myco-managed` }] }] } }));
    expect(legacyMigrationState(home).state).toBe('handover-pending');
    expect(legacyMigrationState(home).legacyOwnsCapture === true).toBe(owned);
    const rig = unjoinedRig();
    expect(await run([await invite(rig)], deps(rig, { agents: () => {
      if (owned) throw new Error('must defer legacy hooks');
      return ['claude-code'];
    } }))).toBe(true);
    expect(out.includes(LEGACY_AGENT_DEFERRAL)).toBe(owned);
    expect(read(settings)?.includes('--credential registry')).toBe(!owned);
  });

  it('defers legacy agents on every sign-in despite an existing membership and empty cutover record', async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    const settings = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settings, '{"legacy":"capture must stay"}');
    const vault = path.join(home, 'groves', 'legacy', 'myco.db');
    fs.mkdirSync(path.dirname(vault), { recursive: true });
    fs.writeFileSync(vault, 'retained vault');
    const rig = unjoinedRig();
    for (let attempt = 0; attempt < 2; attempt++) {
      out.length = 0;
      const memberId = readDeploymentMembership('https://s', home)?.memberId;
      const authority = await issueEnrollmentAuthority(rig.env.db, Date.now(), { issuer: { kind: 'operator' }, role: 'member', memberId });
      expect(await run([`https://s/join#${authority.key}`], deps(rig, { agents: () => { throw new Error('legacy agents must not be provisioned'); } }))).toBe(true);
      expect(out).toContain(LEGACY_AGENT_DEFERRAL);
      expect(readProvisionRecord(home)).toBeNull();
      expect(read(settings)).toBe('{"legacy":"capture must stay"}');
      expect(read(vault)).toBe('retained vault');
      fs.writeFileSync(path.join(home, 'member', 'cutover.json'), '{"version":1,"backups":{}}', { mode: 0o600 });
    }
    expect(err).toEqual([]);
  });

  for (const changed of [false, true]) it(`${changed ? 'defers again after capture changes' : 'provisions after complete receipt evidence'} on a migrated machine`, async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    const vault = path.join(home, 'groves', 'legacy', 'myco.db');
    fs.mkdirSync(path.dirname(vault), { recursive: true });
    const db = new Database(vault);
    db.run("CREATE TABLE sessions (body TEXT, project_id TEXT DEFAULT 'proj_legacy')");
    db.run("INSERT INTO sessions (body) VALUES ('retained')");
    db.close();
    const digest = readVaultContent(vault).digest;
    const stamp = legacyVaultStamp(vault);
    if (changed) {
      const write = new Database(vault);
      try { write.run("INSERT INTO sessions (body) VALUES ('new capture')"); } finally { write.close(); }
    }
    fs.mkdirSync(path.join(home, 'member'), { recursive: true });
    fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify({ version: 2, backups: { [vault]: { digest } }, handover: { at: 1, legacyHomes: [home], agents: [] }, migrations: { [vault]: { ...stamp, digest, projects: {
      proj_legacy: { destination: { serverUrl: 'https://s', key: deploymentKeyFor('https://s') }, vault: { state: 'complete', at: 1 }, transcripts: { state: 'none', at: 1 } },
    } } } }), { mode: 0o600 });
    const rig = unjoinedRig();
    expect(await run([await invite(rig)], deps(rig, { agents: () => ['claude-code'] }))).toBe(true);
    expect(out.includes(LEGACY_AGENT_DEFERRAL)).toBe(changed);
    expect(read(path.join(claudeDir, 'settings.json')) !== null).toBe(!changed);
  });

  for (const choice of ['now', 'defer', 'no-agents'] as const) it(`keeps sign-in successful with unreadable migration evidence (${choice})`, async () => {
    const vault = path.join(home, 'groves', 'legacy', 'myco.db');
    fs.mkdirSync(path.dirname(vault), { recursive: true });
    fs.writeFileSync(vault, 'retained vault');
    const record = path.join(home, 'member', 'cutover.json');
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, '{', { mode: 0o600 });
    const rig = unjoinedRig();
    expect(await run([await invite(rig), ...(choice === 'no-agents' ? ['--no-agents'] : [])], deps(rig, {
      provision: choice === 'defer' ? 'defer' : 'now', agents: () => { throw new Error('must not provision'); },
    }))).toBe(true);
    expect(readDeploymentMembership('https://s', home)).not.toBeNull();
    expect(out.some((line) => line.includes(`deferred: cannot read ${record}`))).toBe(choice === 'now');
    expect(err).toEqual([]);
  });

  for (const noAgents of [false, true]) it(`handles an unreadable legacy grove without failing sign-in (no agents: ${noAgents})`, async () => {
    const groves = path.join(home, 'groves');
    fs.mkdirSync(groves, { recursive: true });
    const original = fs.readdirSync;
    const read = spyOn(fs, 'readdirSync').mockImplementation((...args) => {
      if (String(args[0]) === groves) throw Object.assign(new Error('fixture unreadable grove'), { code: 'EACCES', path: groves });
      return Reflect.apply(original, fs, args);
    });
    try {
      const rig = unjoinedRig();
      expect(await run([await invite(rig), ...(noAgents ? ['--no-agents'] : [])], deps(rig, { agents: () => { throw new Error('must not provision'); } }))).toBe(true);
      expect(readDeploymentMembership('https://s', home)).not.toBeNull();
      expect(out.some((line) => line.includes(`deferred: cannot read ${groves}`))).toBe(!noAgents);
      expect(err).toEqual([]);
    } finally { read.mockRestore(); }
  });

  it.skipIf(process.platform === 'win32')('never executes a legacy binary during observation or deferred login', async () => {
    const vault = path.join(home, 'groves', 'legacy', 'myco.db');
    fs.mkdirSync(path.dirname(vault), { recursive: true });
    fs.writeFileSync(vault, 'retained vault');
    await withLegacyBinaryTraps(home, userHome, async (marker) => {
      expect(legacyMigrationState(home).state).toBe('unmoved');
      expect(fs.existsSync(marker)).toBe(false);
      const rig = unjoinedRig();
      expect(await run([await invite(rig)], deps(rig, { agents: () => { throw new Error('must defer legacy agents'); } }))).toBe(true);
      expect(out).toContain(LEGACY_AGENT_DEFERRAL);
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  it('asks which Deployment to provision for when this machine is a member of several and no folder names one', () => {
    for (const url of ['https://one.example', 'https://two.example']) {
      writeDeploymentMembership({ serverUrl: url, token: 'a'.repeat(43), machineId: 'm', joinedAt: 1, updatedAt: 1 } as never, { mycoHome: home } as never);
    }
    process.exitCode = 0;
    expect(runProvision([], { mycoHome: home, cwd: root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(false);
    expect(err.join('\n')).toContain('name one with --server');
    process.exitCode = 0;
  });
});

it('prints one final period after an agent conflict reason', () => {
  const lines = detectedProvisionLines({ provisioned: [], unchanged: [], heldSkills: [],
    skipped: [{ agent: 'codex', displayName: 'Codex', reason: 'Run myco member provision codex.' }] });
  expect(lines).toEqual(['Skipped Codex: Run myco member provision codex.']);
});
