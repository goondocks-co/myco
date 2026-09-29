/**
 * `myco cutover`, against the real worker and a machine laid out the way a 1.4
 * install leaves it: a 1.4 home with a vault, its claim on the agents' settings,
 * its hooks and MCP entry in the agents' global config beside a hook of the
 * person's own, and its daemon's launchd unit beside other homes' units.
 *
 * What it is judged by:
 *   - capture moves to 2.0 in place: every Myco hook and the MCP entry are the
 *     member's, and the person's own hook is kept;
 *   - 1.4 is taken out of every place it registered, including agents 2.0
 *     does not capture, and cannot come back: its unit, found by reading the
 *     unit files, is booted out and removed, and the claim names the 2.0 home;
 *   - every settings file is backed up, with its mode, before its first change;
 *   - nothing 1.4 wrote as data is changed; a verified copy is what the import
 *     reads, and running it again changes nothing;
 *   - a dry run changes nothing and plans exactly what the real run does;
 *   - it stops before its first change, dry run or not, where another
 *     installation holds anything it would need to take.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as runCutover, type CutoverDeps } from '@myco/cli/cutover.js';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { resolveServiceDaemonStatePath } from '@myco/grove/paths.js';
import { CREDENTIAL_FLAG } from '@myco/member/constants.js';
import { listRegistryEntries, writeDeploymentMembership } from '@myco/member/registry.js';
import { stopHomeDaemon } from '@myco/service/home-daemon.js';
import type { LaunchctlRunner } from '@myco/service/launchd.js';
import { resolvePackageRoot } from '@myco/symbionts/detect.js';
import { hookCommands } from '@myco/symbionts/member-hooks.js';
import { rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { memberRig, tempMycoHome, TEST_MACHINE_ID, type MemberRig } from '../member/helpers/server.js';

const SERVER = 'https://member-test.invalid';
const PROJECT = 'proj_1';
const NOW_S = Math.floor(Date.now() / 1000);
const DAEMON_LABEL = 'co.goondocks.myco';
const OTHER_DAEMON_LABEL = 'co.goondocks.myco.0ther000';
const WORKER_LABEL = 'co.goondocks.myco-worker.0ther000';

type RunOpts = { fetch?: MemberRig['fetch']; mycoHome?: string | null; env?: NodeJS.ProcessEnv; provision?: CutoverDeps['provision']; agents?: string[] };
interface Machine {
  rig: MemberRig;
  home: string;
  legacyHome: string;
  mycoHome: string;
  root: string;
  vault: string;
  agentsDir: string;
  /** Every launchctl call, and the labels launchd holds. */
  launchctl: { calls: string[][]; loaded: Set<string> };
  planned: string[][];
  done: string[];
  run: (args?: string[], opts?: RunOpts) => Promise<{ ok: boolean; out: string[]; err: string[] }>;
}

const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
const writeJson = (file: string, value: unknown): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };

/** A launchd unit file as Myco writes one. */
function plist(label: string, argv: string[], env: Record<string, string>): string {
  const str = (v: string) => `<string>${v}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key>${str(label)}`
    + `<key>ProgramArguments</key><array>${argv.map(str).join('')}</array>`
    + `<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key>${str(v)}`).join('')}</dict>`
    + '<key>RunAtLoad</key><true/></dict></plist>\n';
}

/** A launchctl that answers for the labels it holds and drops one on bootout. */
function fakeLaunchctl(loaded: Set<string>, calls: string[][]): LaunchctlRunner {
  return {
    run: async (args) => {
      calls.push(args);
      const label = (args[args.length - 1] ?? '').split('/').pop() ?? '';
      if (args[0] === 'print') return loaded.has(label) ? { stdout: 'state = running', exitCode: 0 } : { stdout: `Could not find service "${label}" in domain`, exitCode: 113 };
      if (args[0] === 'bootout') loaded.delete(label);
      return { stdout: '', exitCode: 0 };
    },
  };
}

async function machine(opts: { legacyHome?: string } = {}): Promise<Machine> {
  const rig = await memberRig();
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cutover-')));
  const legacyHome = opts.legacyHome === undefined ? path.join(home, '.myco') : path.join(home, opts.legacyHome);
  const root = path.join(home, 'Repos', 'app');
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  const legacyBin = path.join(legacyHome, 'bin', 'myco');

  // The 1.4 vault.
  const vault = path.join(legacyHome, 'groves', 'grove_a', 'myco.db');
  fs.mkdirSync(path.dirname(vault), { recursive: true });
  const db = openDatabase(vault);
  createSchema(db);
  db.run('PRAGMA foreign_keys = OFF');
  db.run(`INSERT INTO sessions (id, agent, project_root, project_id, started_at, ended_at, status, title, created_at) VALUES (?, 'claude-code', ?, ?, ?, ?, 'completed', 'A 1.4 session', ?)`,
    ['00000000-0000-4000-8000-000000000001', root, PROJECT, NOW_S - 86_400 * 40, NOW_S - 86_400 * 40 + 600, NOW_S - 86_400 * 40]);
  db.run(`INSERT INTO prompt_batches (id, project_id, session_id, prompt_number, user_prompt, origin, started_at, created_at) VALUES (1, ?, ?, 1, 'hello from 1.4', 'human', ?, ?)`,
    [PROJECT, '00000000-0000-4000-8000-000000000001', NOW_S - 86_400 * 40, NOW_S - 86_400 * 40]);
  db.run(`INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at) VALUES ('gotcha-1', ?, 'user', 'gotcha', 'active', 'kept', ?)`, [PROJECT, NOW_S]);
  // The writer's pages are folded into the file before the byte comparison starts: the fixture's own
  // handle closing later must not read as the cutover writing the vault.
  db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();

  // 1.4's claim on the agents' settings, its hooks beside the person's own, and its MCP entry.
  fs.mkdirSync(path.join(legacyHome, 'claims'), { recursive: true });
  fs.writeFileSync(path.join(legacyHome, 'claims', 'symbiont-config.json'), JSON.stringify({ subsystem: 'symbiont-config', owner: legacyHome, pid: 1, claimed_at: 1 }));
  const hook = (event: string) => ({ hooks: [{ type: 'command', command: `${legacyBin} hook ${event} --symbiont claude-code --myco-managed` }] });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [hook('session-start')], Stop: [hook('stop'), { hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }, null, 2));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { myco: { command: legacyBin, args: ['mcp'] } } }, null, 2));

  // The 1.4 daemon's unit, beside another home's daemon and worker units.
  const agentsDir = path.join(home, 'LaunchAgents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, `${DAEMON_LABEL}.plist`), plist(DAEMON_LABEL, [legacyBin, 'daemon'], { MYCO_HOME: legacyHome }));
  fs.writeFileSync(path.join(agentsDir, `${OTHER_DAEMON_LABEL}.plist`), plist(OTHER_DAEMON_LABEL, ['/elsewhere/other/bin/myco', 'daemon'], { MYCO_HOME: '/elsewhere/other' }));
  fs.writeFileSync(path.join(agentsDir, `${WORKER_LABEL}.plist`), plist(WORKER_LABEL, ['/elsewhere/other/bin/myco', 'worker', '--server', SERVER], { MYCO_HOME: '/elsewhere/other' }));
  const launchctl = { calls: [] as string[][], loaded: new Set([DAEMON_LABEL, OTHER_DAEMON_LABEL, WORKER_LABEL]) };

  const mycoHome = tempMycoHome();
  writeDeploymentMembership({ serverUrl: SERVER, token: rig.token, tokenId: rig.tokenId, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome });

  const planned: string[][] = [];
  const done: string[] = [];
  const run: Machine['run'] = async (args = [], o = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const ok = await runCutover(args, {
      fetch: o.fetch ?? rig.fetch, mycoHome: o.mycoHome === null ? undefined : (o.mycoHome ?? mycoHome), machineId: TEST_MACHINE_ID,
      env: o.env ?? { ...process.env, HOME: home, MYCO_CLAIMS_HOME: legacyHome, MYCO_LAUNCH_AGENTS_DIR: agentsDir },
      sleep: async () => {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l), packageRoot: resolvePackageRoot(),
      agents: () => o.agents ?? ['claude-code'], platform: 'darwin',
      launchctl: fakeLaunchctl(launchctl.loaded, launchctl.calls),
      stopDaemon: async () => 'none',
      provision: o.provision,
      onPlan: (keys) => planned.push(keys),
      onAction: (key) => done.push(key),
    });
    return { ok, out, err };
  };
  return { rig, home, legacyHome, mycoHome, root, vault, agentsDir, launchctl, planned, done, run };
}

describe('myco cutover', () => {
  let m: Machine;
  let heldHome: string | undefined;
  let heldClaims: string | undefined;
  beforeEach(async () => {
    m = await machine();
    heldHome = process.env.HOME;
    heldClaims = process.env.MYCO_CLAIMS_HOME;
    process.env.HOME = m.home;
    process.env.MYCO_CLAIMS_HOME = m.legacyHome;
  });
  afterEach(() => {
    if (heldHome === undefined) delete process.env.HOME; else process.env.HOME = heldHome;
    if (heldClaims === undefined) delete process.env.MYCO_CLAIMS_HOME; else process.env.MYCO_CLAIMS_HOME = heldClaims;
  });

  const settingsFile = () => path.join(m.home, '.claude', 'settings.json');
  const claimOwner = (claimsHome: string) => (readJson(path.join(claimsHome, 'claims', 'symbiont-config.json')) as { owner: string }).owner;
  const bootouts = () => m.launchctl.calls.filter((c) => c[0] === 'bootout').map((c) => c[c.length - 1].split('/').pop());
  /** Every copy the cutovers so far hold of `file`, from their manifests. */
  const backupsOf = (file: string): string[] => {
    const root = path.join(m.mycoHome, 'backups');
    const folders = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => n.startsWith('cutover-')) : [];
    return folders.flatMap((folder) => (readJson(path.join(root, folder, 'manifest.json')).entries as Array<{ original: string; backup: string }>)
      .filter((e) => e.original === file).map((e) => e.backup));
  };
  /** Every file under `dir`, with a digest of its bytes. */
  const tree = (dir: string): Record<string, string> => Object.fromEntries((fs.readdirSync(dir, { recursive: true }) as string[]).sort()
    .filter((rel) => fs.statSync(path.join(dir, rel)).isFile())
    .map((rel) => [rel, sha(path.join(dir, rel))]));

  it('moves capture to 2.0 in place, takes 1.4 out for good, keeps the vault as it was, and brings its history; again changes nothing', async () => {
    const vaultBytes = sha(m.vault);
    const settingsBytes = fs.readFileSync(settingsFile(), 'utf8');
    fs.chmodSync(settingsFile(), 0o600);
    const first = await m.run();
    expect(first.err).toEqual([]);
    expect(first.ok).toBe(true);

    // The folder is connected; the claim names the 2.0 home, so a 1.4 daemon that comes back defers.
    expect(listRegistryEntries(m.mycoHome).map((e) => [e.root, e.projectId])).toEqual([[m.root, PROJECT]]);
    expect(claimOwner(m.legacyHome)).toBe(m.mycoHome);

    // The 1.4 daemon's unit, found by reading the unit files, is booted out and removed; no other unit is touched.
    expect(bootouts()).toEqual([DAEMON_LABEL]);
    expect(fs.readdirSync(m.agentsDir).sort()).toEqual([`${OTHER_DAEMON_LABEL}.plist`, `${WORKER_LABEL}.plist`].sort());

    // Every Myco hook is the member's; the person's own is kept; the MCP entry is the member's.
    const commands = hookCommands(readJson(settingsFile()).hooks);
    expect(commands).toContain('echo mine');
    expect(commands.filter((c) => c.includes('hook ')).every((c) => c.includes(CREDENTIAL_FLAG))).toBe(true);
    expect(commands.some((c) => c.includes(path.join(m.legacyHome, 'bin')))).toBe(false);
    const mcp = (readJson(path.join(m.home, '.claude.json')).mcpServers as Record<string, Record<string, unknown>>).myco;
    expect(mcp.url).toBe(`${SERVER}/mcp`);

    // Each settings file was backed up, with its mode, before its first change; the file keeps its mode.
    const [backup] = backupsOf(settingsFile());
    expect(backup.startsWith(path.join(m.mycoHome, 'backups', 'cutover-'))).toBe(true);
    expect(backup.endsWith(settingsFile())).toBe(true);
    expect(fs.readFileSync(backup, 'utf8')).toBe(settingsBytes);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(fs.statSync(settingsFile()).mode & 0o777).toBe(0o600);
    expect(backupsOf(path.join(m.home, '.claude.json'))).toHaveLength(1);
    expect(first.out.join('\n')).toContain(`to ${path.join(m.mycoHome, 'backups', 'cutover-')}`);
    expect(first.out.join('\n')).toContain(`     ${settingsFile()}`);
    expect(fs.readdirSync(path.join(m.home, '.claude')).some((n) => n.includes('bak'))).toBe(false);

    // The vault is untouched; a verified copy sits beside it; the history arrived, with its title.
    expect(sha(m.vault)).toBe(vaultBytes);
    const copies = fs.readdirSync(path.join(m.legacyHome, 'backups'));
    expect(copies.length).toBe(1);
    expect(fs.existsSync(path.join(m.legacyHome, 'backups', copies[0], 'grove_a', 'myco.db'))).toBe(true);
    const sqlite = m.rig.env.sqlite;
    expect(sqlite.query(`SELECT title FROM sessions WHERE project_id = ?`).all(PROJECT)).toEqual([{ title: 'A 1.4 session' }]);
    expect(sqlite.query(`SELECT id FROM spores WHERE project_id = ?`).all(PROJECT)).toEqual([{ id: 'gotcha-1' }]);

    const tables = ['sessions', 'prompt_batches', 'spores', 'events', 'transcripts'];
    const snapshot = () => Object.fromEntries(tables.map((t) => [t, m.rig.rows(t)]));
    const before = snapshot();
    const settingsAfter = fs.readFileSync(settingsFile(), 'utf8');
    const again = await m.run();
    expect(again.ok).toBe(true);
    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(settingsAfter);
    expect(fs.readdirSync(path.join(m.legacyHome, 'backups')).length).toBe(1);
    expect(bootouts()).toEqual([DAEMON_LABEL]);
    // A file the run left as it was keeps no second copy.
    expect(backupsOf(settingsFile())).toHaveLength(1);
    expect(again.out.join('\n')).not.toContain('backed up');
  });

  it('writes nothing inside a connected project but the member configs it means to change', async () => {
    // The project's own member hooks, which provisioning globally retires, and the person's own files beside them.
    const memberHook = `${path.join(m.mycoHome, 'bin', 'myco')} hook stop --symbiont claude-code ${CREDENTIAL_FLAG} registry --myco-managed`;
    writeJson(path.join(m.root, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: memberHook }] }] } });
    fs.writeFileSync(path.join(m.root, 'notes.md'), 'mine\n');
    const before = tree(m.root);
    const result = await m.run();
    expect(result.ok).toBe(true);
    const after = tree(m.root);
    const intended = new Set([path.join('.claude', 'settings.local.json'), '.mcp.json']);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((rel) => before[rel] !== after[rel]);
    expect(changed).toContain(path.join('.claude', 'settings.local.json'));
    expect(changed.filter((rel) => !intended.has(rel))).toEqual([]);
  });

  it('plans on a dry run exactly the changes the real run makes, and makes none of them', async () => {
    const settings = fs.readFileSync(settingsFile(), 'utf8');
    const vaultBytes = sha(m.vault);
    const events = m.rig.rows('events');
    const dry = await m.run(['--dry-run']);
    expect(dry.ok).toBe(true);
    expect(dry.out.join('\n')).toContain(`would connect ${m.root}`);
    expect(dry.out.join('\n')).toContain(`would stop and remove ${DAEMON_LABEL}`);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(settings);
    expect(claimOwner(m.legacyHome)).toBe(m.legacyHome);
    expect(listRegistryEntries(m.mycoHome)).toEqual([]);
    expect(fs.existsSync(path.join(m.legacyHome, 'backups'))).toBe(false);
    expect(fs.existsSync(path.join(m.mycoHome, 'backups'))).toBe(false);
    expect(m.launchctl.calls).toEqual([]);
    expect(sha(m.vault)).toBe(vaultBytes);
    expect(m.rig.rows('events')).toBe(events);
    expect(m.done).toEqual([]);

    const real = await m.run();
    expect(real.ok).toBe(true);
    expect(m.planned[0].length).toBeGreaterThan(0);
    expect(m.done).toEqual(m.planned[0]);
    expect(m.planned[1]).toEqual(m.planned[0]);
  });

  it('removes 1.4 from agents 2.0 does not capture and from every place 1.4.8 wrote, keeping the person\'s own entries', async () => {
    const legacyBin = path.join(m.legacyHome, 'bin', 'myco');
    const copilotHooks = path.join(m.home, '.copilot', 'hooks', 'myco-hooks.json');
    const copilotMcp = path.join(m.home, '.copilot', 'mcp-config.json');
    const vscodeMcp = path.join(m.home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    const clinePlugin = path.join(m.home, '.cline', 'plugins', 'myco.ts');
    writeJson(copilotHooks, { version: 1, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${legacyBin} hook session-start --symbiont copilot --myco-managed` }] }] } });
    writeJson(copilotMcp, { mcpServers: { myco: { type: 'stdio', command: legacyBin, args: ['mcp'] }, mine: { command: 'mine' } } });
    fs.chmodSync(copilotMcp, 0o640);
    writeJson(vscodeMcp, { servers: { myco: { type: 'stdio', command: legacyBin, args: ['mcp'] } } });
    fs.mkdirSync(path.dirname(clinePlugin), { recursive: true });
    fs.writeFileSync(clinePlugin, '// myco:plugin-marker — Myco owns this file\nexport default {};\n');
    // 1.4.8 wrote Claude Code's MCP entry into settings.json; 2.0 writes ~/.claude.json.
    writeJson(settingsFile(), { ...readJson(settingsFile()), mcpServers: { myco: { type: 'stdio', command: legacyBin, args: ['mcp'] } } });

    const dry = await m.run(['--dry-run']);
    expect(dry.ok).toBe(true);
    expect(dry.out.join('\n')).toContain(`GitHub Copilot: would remove the \`myco\` MCP entry from ${copilotMcp}; GitHub Copilot is no longer captured by Myco 2.0`);

    const result = await m.run();
    expect(result.err).toEqual([]);
    expect(result.ok).toBe(true);
    const said = result.out.join('\n');
    expect(said).toContain(`GitHub Copilot: removed 1 1.4 hooks from ${copilotHooks}; GitHub Copilot is no longer captured by Myco 2.0`);
    expect(said).toContain(`Cline: removed ${clinePlugin}; Cline is no longer captured by Myco 2.0`);
    expect(hookCommands(readJson(copilotHooks).hooks)).toEqual([]);
    expect(readJson(copilotMcp).mcpServers).toEqual({ mine: { command: 'mine' } });
    expect(fs.statSync(copilotMcp).mode & 0o777).toBe(0o640);
    expect(backupsOf(copilotMcp)).toHaveLength(1);
    expect(readJson(vscodeMcp).servers).toEqual({});
    expect(fs.existsSync(clinePlugin)).toBe(false);
    expect(backupsOf(clinePlugin)).toHaveLength(1);
    expect(readJson(settingsFile()).mcpServers).toEqual({});
  });

  it('refuses a member MCP entry of another Deployment before its first change', async () => {
    const other = '/elsewhere/member/bin/myco';
    writeJson(path.join(m.home, '.claude.json'), { mcpServers: { myco: { type: 'http', url: 'https://other.invalid/mcp', headersHelper: `${other} member mcp-headers ${CREDENTIAL_FLAG} registry --server https://other.invalid` } } });
    const unchanged = untouched();
    for (const args of [['--dry-run'], []]) {
      const result = await m.run(args);
      expect(result.ok).toBe(false);
      expect(result.err.join('\n')).toContain('belongs to another installation or Deployment');
      expect(result.err.join('\n')).toContain('Nothing was changed.');
      unchanged();
    }
  });

  it('refuses when every vault session was captured on another machine, and warns when some were', async () => {
    const db = openDatabase(m.vault);
    db.run(`UPDATE sessions SET machine_id = 'old_machine_1234'`);
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const unchanged = untouched();
    const refused = await m.run(['--dry-run']);
    expect(refused.ok).toBe(false);
    expect(refused.err.join('\n')).toContain(`every session in the 1.4 vaults was captured under another machine id (old_machine_1234: 1), not this machine's (${TEST_MACHINE_ID})`);
    unchanged();

    const again = openDatabase(m.vault);
    again.run('PRAGMA foreign_keys = OFF');
    again.run(`INSERT INTO sessions (id, agent, project_root, project_id, started_at, ended_at, status, machine_id, created_at) VALUES (?, 'claude-code', ?, ?, ?, ?, 'completed', ?, ?)`,
      ['00000000-0000-4000-8000-000000000009', m.root, PROJECT, NOW_S - 86_400 * 30, NOW_S - 86_400 * 30 + 60, TEST_MACHINE_ID, NOW_S - 86_400 * 30]);
    again.run('PRAGMA wal_checkpoint(TRUNCATE)');
    again.close();
    const warned = await m.run(['--dry-run']);
    expect(warned.ok).toBe(true);
    expect(warned.out.join('\n')).toContain(`warning: the 1.4 vaults record 1 sessions under old_machine_1234, not this machine's id (${TEST_MACHINE_ID})`);
  });

  it('refuses a daemon unit it cannot attribute to a home', async () => {
    fs.writeFileSync(path.join(m.agentsDir, 'co.goondocks.myco.anon.plist'), plist('co.goondocks.myco.anon', ['/opt/myco/bin/myco', 'daemon'], {}));
    const unchanged = untouched();
    const result = await m.run();
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('co.goondocks.myco.anon.plist runs `myco daemon` but names no home');
    unchanged();
  });

  it('imports nothing when a vault could not be copied', async () => {
    fs.writeFileSync(path.join(m.legacyHome, 'backups'), 'not a directory');
    const result = await m.run();
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('not every vault has a verified copy; nothing was imported');
    expect(m.rig.rows('spores')).toBe(0);
    expect(m.rig.rows('sessions')).toBe(0);
    expect(result.out.join('\n')).not.toContain('Cutover complete.');
  });

  it('takes a new copy of a vault that changed since the last run, and imports from it', async () => {
    expect((await m.run()).ok).toBe(true);
    const db = openDatabase(m.vault);
    db.run(`UPDATE spores SET content = 'changed in 1.4' WHERE id = 'gotcha-1'`);
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const again = await m.run();
    expect(again.ok).toBe(true);
    expect(again.out.join('\n')).toContain('the vault changed since the earlier copy');
    const copies = fs.readdirSync(path.join(m.legacyHome, 'backups')).sort();
    expect(copies.length).toBe(2);
    const latest = openDatabase(path.join(m.legacyHome, 'backups', copies[1], 'grove_a', 'myco.db'));
    expect(latest.query(`SELECT content FROM spores`).all()).toEqual([{ content: 'changed in 1.4' }]);
    latest.close();
  });

  it('takes a new copy when the one recorded no longer holds what the vault holds', async () => {
    expect((await m.run()).ok).toBe(true);
    const [first] = fs.readdirSync(path.join(m.legacyHome, 'backups'));
    const copy = openDatabase(path.join(m.legacyHome, 'backups', first, 'grove_a', 'myco.db'));
    copy.run(`UPDATE spores SET content = 'altered in the copy' WHERE id = 'gotcha-1'`);
    copy.run('PRAGMA wal_checkpoint(TRUNCATE)');
    copy.close();
    const again = await m.run();
    expect(again.ok).toBe(true);
    expect(again.out.join('\n')).not.toContain('copied earlier');
    expect(fs.readdirSync(path.join(m.legacyHome, 'backups')).length).toBe(2);
  });

  it('fails the run when the Deployment refuses a write', async () => {
    const refusing: MemberRig['fetch'] = async (input, init) =>
      String(input).endsWith('/spores/save') ? new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }) : m.rig.fetch(input, init);
    const result = await m.run([], { fetch: refusing });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('the Deployment refused or failed part of the 1.4 history');
    expect(result.out.join('\n')).not.toContain('Cutover complete.');
  });

  it('leaves the 1.4 service and its claim alone, and imports nothing, when an agent could not be pointed at 2.0', async () => {
    const result = await m.run([], { provision: () => ({ kind: 'refused', detail: 'the agent\'s settings could not be written' }) });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('The 1.4 service is left running');
    expect(bootouts()).toEqual([]);
    expect(fs.existsSync(path.join(m.agentsDir, `${DAEMON_LABEL}.plist`))).toBe(true);
    expect(claimOwner(m.legacyHome)).toBe(m.legacyHome);
    expect(fs.existsSync(path.join(m.legacyHome, 'backups'))).toBe(false);
    expect(m.rig.rows('spores')).toBe(0);
  });

  it('fails the run when the Deployment refuses the transcript import', async () => {
    const id = '00000000-0000-4000-8000-000000000002';
    const transcript = path.join(m.home, '.claude', 'projects', `-${rootSlug(m.root)}`, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: m.root, sessionId: id, message: { content: `after 1.4 ${'x'.repeat(5000)}` }, timestamp: '2026-08-01T10:00:00Z' })}\n`);
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(transcript, old, old);
    const refusing: MemberRig['fetch'] = async (input, init) => {
      const transcriptPlan = String(input).endsWith('/import/plan') && !String(init?.body ?? '').includes('"sessions"');
      return transcriptPlan ? new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }) : m.rig.fetch(input, init);
    };
    const result = await m.run([], { fetch: refusing });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('the transcript import stopped before it finished');
  });

  /** Everything the cutover would change, byte for byte, to show a refused run changed none of it. */
  const untouched = () => {
    const files = [settingsFile(), path.join(m.home, '.claude.json'), path.join(m.legacyHome, 'claims', 'symbiont-config.json')];
    const bytes = Object.fromEntries(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
    const units = fs.readdirSync(m.agentsDir).sort();
    const events = m.rig.rows('events');
    return () => {
      expect(Object.fromEntries(files.map((f) => [f, fs.readFileSync(f, 'utf8')]))).toEqual(bytes);
      expect(listRegistryEntries(m.mycoHome)).toEqual([]);
      expect(fs.existsSync(path.join(m.legacyHome, 'backups'))).toBe(false);
      expect(fs.existsSync(path.join(m.mycoHome, 'backups'))).toBe(false);
      expect(fs.readdirSync(m.agentsDir).sort()).toEqual(units);
      expect(m.launchctl.calls).toEqual([]);
      expect(m.rig.rows('events')).toBe(events);
    };
  };

  it('stops before its first change when another installation holds the agents\' settings, and names the flag', async () => {
    fs.writeFileSync(path.join(m.legacyHome, 'claims', 'symbiont-config.json'), JSON.stringify({ subsystem: 'symbiont-config', owner: '/elsewhere/.myco-other', pid: 1, claimed_at: 1 }));
    const unchanged = untouched();
    for (const args of [['--dry-run'], []]) {
      const result = await m.run(args);
      expect(result.ok).toBe(false);
      expect(result.err.join('\n')).toContain('/elsewhere/.myco-other holds your agents\' settings');
      expect(result.err.join('\n')).toContain('add `--legacy-home /elsewhere/.myco-other`');
      expect(result.err.join('\n')).toContain('Nothing was changed.');
      unchanged();
    }
  });

  it('stops before its first change when this machine is pinned to another home', async () => {
    fs.writeFileSync(path.join(m.legacyHome, 'runtime.home'), '/elsewhere/member-home\n');
    const unchanged = untouched();
    for (const args of [['--dry-run'], []]) {
      const result = await m.run(args);
      expect(result.ok).toBe(false);
      expect(result.err.join('\n')).toContain('this machine is pinned to /elsewhere/member-home');
      unchanged();
    }
  });

  it('stops before its first change when another home\'s hooks are in the agents\' settings, and names them and the flag', async () => {
    const other = '/elsewhere/.myco-other/bin/myco';
    const legacyBin = path.join(m.legacyHome, 'bin', 'myco');
    for (const foreign of [`${other} hook stop --symbiont claude-code --myco-managed`, `MYCO_HOME=/elsewhere/member-home ${legacyBin} hook stop --symbiont claude-code --myco-managed`]) {
      writeJson(settingsFile(), { hooks: { Stop: [{ hooks: [{ type: 'command', command: foreign }] }] } });
      const unchanged = untouched();
      for (const args of [['--dry-run'], []]) {
        const result = await m.run(args);
        expect(result.ok).toBe(false);
        expect(result.err.join('\n')).toContain(`belong to another installation (\`${foreign}\`)`);
        expect(result.err.join('\n')).toContain('--legacy-home /elsewhere/');
        unchanged();
      }
    }
  });

  it('cuts over into the home the machine pin names, and says so first, when the 1.4 hooks run through that pin', async () => {
    fs.writeFileSync(path.join(m.legacyHome, 'runtime.home'), `${m.mycoHome}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: m.home, MYCO_CLAIMS_HOME: m.legacyHome, MYCO_LAUNCH_AGENTS_DIR: m.agentsDir };
    delete env.MYCO_HOME;
    const unchanged = untouched();
    const dry = await m.run(['--dry-run'], { mycoHome: null, env });
    expect(dry.err).toEqual([]);
    expect(dry.ok).toBe(true);
    const said = dry.out.join('\n');
    expect(said).toContain(`into ${m.mycoHome} (chosen by the machine pin ${path.join(m.legacyHome, 'runtime.home')})`);
    expect(said).toContain(`would point Claude Code at ${m.mycoHome}, replacing the 1.4 hooks and MCP entry of ${m.legacyHome}`);
    unchanged();

    const real = await m.run([], { mycoHome: null, env });
    expect(real.err).toEqual([]);
    expect(real.ok).toBe(true);
    expect(listRegistryEntries(m.mycoHome).map((e) => e.root)).toEqual([m.root]);
    expect(hookCommands(readJson(settingsFile()).hooks).filter((c) => c.includes('hook ')).every((c) => c.includes(CREDENTIAL_FLAG))).toBe(true);
  });
});

describe('myco cutover on two 1.4 homes, one pinned as the 2.0 home (the owner\'s layout)', () => {
  it('stops the pinned home\'s daemon, points both homes\' claims at it, and takes 1.4 out of every agent, with no MYCO_CLAIMS_HOME', async () => {
    const m = await machine({ legacyHome: '.myco-dev' });
    const heldHome = process.env.HOME;
    const heldClaims = process.env.MYCO_CLAIMS_HOME;
    process.env.HOME = m.home;
    delete process.env.MYCO_CLAIMS_HOME;
    try {
      // ~/.myco is a 1.4 home too: a vault of its own, its claim, and the pin to ~/.myco-dev.
      const prod = path.join(m.home, '.myco');
      const prodVault = path.join(prod, 'groves', 'grove_p', 'myco.db');
      fs.mkdirSync(path.dirname(prodVault), { recursive: true });
      const db = openDatabase(prodVault);
      createSchema(db);
      db.run('PRAGMA foreign_keys = OFF');
      db.run(`INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at) VALUES ('prod-1', ?, 'user', 'gotcha', 'active', 'from ~/.myco', ?)`, [PROJECT, NOW_S]);
      db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
      fs.renameSync(path.join(m.legacyHome, 'claims'), path.join(prod, 'claims'));
      fs.writeFileSync(path.join(prod, 'claims', 'symbiont-config.json'), JSON.stringify({ subsystem: 'symbiont-config', owner: prod, pid: 1, claimed_at: 1 }));
      fs.writeFileSync(path.join(prod, 'runtime.home'), `${m.legacyHome}\n`);
      // The member lives in the pinned home.
      writeDeploymentMembership({ serverUrl: SERVER, token: m.rig.token, tokenId: m.rig.tokenId, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome: m.legacyHome });
      const devBin = path.join(m.legacyHome, 'bin', 'myco');
      const copilotMcp = path.join(m.home, '.copilot', 'mcp-config.json');
      writeJson(copilotMcp, { mcpServers: { myco: { type: 'stdio', command: devBin, args: ['mcp'] } } });
      writeJson(settingsFile(), { ...readJson(settingsFile()), mcpServers: { myco: { type: 'stdio', command: devBin, args: ['mcp'] } } });

      const env: NodeJS.ProcessEnv = { ...process.env, HOME: m.home, MYCO_LAUNCH_AGENTS_DIR: m.agentsDir };
      delete env.MYCO_HOME;
      delete env.MYCO_CLAIMS_HOME;
      const args = ['--legacy-home', prod, '--legacy-home', m.legacyHome];
      const dry = await m.run([...args, '--dry-run'], { mycoHome: null, env });
      expect(dry.err).toEqual([]);
      expect(dry.ok).toBe(true);
      const result = await m.run(args, { mycoHome: null, env });
      expect(result.err).toEqual([]);
      expect(result.ok).toBe(true);
      expect(m.done).toEqual(m.planned[0]);

      expect(bootouts()).toEqual([DAEMON_LABEL]);
      expect(fs.existsSync(path.join(m.agentsDir, `${DAEMON_LABEL}.plist`))).toBe(false);
      expect(claimOwner(prod)).toBe(m.legacyHome);
      expect(claimOwner(m.legacyHome)).toBe(m.legacyHome);
      expect(readJson(copilotMcp).mcpServers).toEqual({});
      expect(readJson(settingsFile()).mcpServers).toEqual({});
      expect(hookCommands(readJson(settingsFile()).hooks).filter((c) => c.includes('hook ')).every((c) => c.includes(CREDENTIAL_FLAG))).toBe(true);
      expect(m.rig.env.sqlite.query(`SELECT id FROM spores ORDER BY id`).all()).toEqual([{ id: 'gotcha-1' }, { id: 'prod-1' }]);
    } finally {
      if (heldHome === undefined) delete process.env.HOME; else process.env.HOME = heldHome;
      if (heldClaims === undefined) delete process.env.MYCO_CLAIMS_HOME; else process.env.MYCO_CLAIMS_HOME = heldClaims;
    }

    function settingsFile() { return path.join(m.home, '.claude', 'settings.json'); }
    function claimOwner(claimsHome: string) { return (readJson(path.join(claimsHome, 'claims', 'symbiont-config.json')) as { owner: string }).owner; }
    function bootouts() { return m.launchctl.calls.filter((c) => c[0] === 'bootout').map((c) => c[c.length - 1].split('/').pop()); }
  });
});

describe('asking a home\'s daemon to exit', () => {
  it('asks only the daemon whose pid the home records, on the port the home records', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-daemon-home-'));
    const statePath = resolveServiceDaemonStatePath(home);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ pid: 111, port: 45_678 }));
    const asked: string[] = [];
    const answering = (pid: number): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      asked.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/api/shutdown')) { pid = -1; return new Response('', { status: 202 }); }
      if (pid < 0) throw new Error('gone');
      return Response.json({ myco: true, pid });
    }) as typeof fetch;
    expect(await stopHomeDaemon(home, answering(222))).toBe('not-this-home');
    expect(asked.some((a) => a.startsWith('POST'))).toBe(false);
    expect(asked[0]).toBe('GET http://127.0.0.1:45678/health');
    asked.length = 0;
    expect(await stopHomeDaemon(home, answering(111))).toBe('stopped');
    expect(asked).toContain('POST http://127.0.0.1:45678/api/shutdown');
  });
});

describe('the `myco cutover` command', () => {
  it('exits non-zero when the cutover does not complete', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cutover-cli-'));
    const cli = path.join(resolvePackageRoot(), 'src', 'cli.ts');
    const env = { ...process.env, HOME: home, MYCO_HOME: path.join(home, '.myco') };
    const refused = spawnSync(process.execPath, [cli, 'cutover', '--dry-run'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(refused.stderr).toContain('myco cutover: this machine is not signed in to a Deployment');
    expect(refused.status).toBe(2);
    expect(spawnSync(process.execPath, [cli, 'cutover', '--help'], { env, encoding: 'utf8', timeout: 60_000 }).status).toBe(0);
  });
});
