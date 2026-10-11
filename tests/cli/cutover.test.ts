import { refuseImportAfter } from '../setup/fixtures/interruption.js';
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
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as runCutover, planCutover, runCutover as executeCutoverPlan, type CutoverDeps } from '@myco/cli/cutover.js';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { resolveServiceDaemonStatePath } from '@myco/grove/paths.js';
import { CREDENTIAL_FLAG } from '@myco/member/constants.js';
import { listRegistryEntries, registryEntryPath, writeRegistryEntry, writeDeploymentMembership } from '@myco/member/registry.js';
import { routedSpoolDir } from '@myco/member/routing.js';
import { deploymentKeyFor } from '@myco/member/registry.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { legacyMigrationState, readCutoverState } from '@myco/member/legacy-migration.js';
import { provisionGlobally } from '@myco/cli/member.js';
import { stopHomeDaemon } from '@myco/service/home-daemon.js';
import type { LaunchctlRunner } from '@myco/service/launchd.js';
import { resolvePackageRoot } from '@myco/symbionts/detect.js';
import { hookCommands } from '@myco/symbionts/member-hooks.js';
import { resolveManagedBinaryPath } from '@myco/symbionts/installer.js';
import { rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { memberRig, tempMycoHome, TEST_MACHINE_ID, type MemberRig } from '../member/helpers/server.js';

const SERVER = 'https://member-test.invalid';
const PROJECT = 'proj_1';
const NOW_S = Math.floor(Date.now() / 1000);
const DAEMON_LABEL = 'co.goondocks.myco';
const OTHER_DAEMON_LABEL = 'co.goondocks.myco.0ther000';
const WORKER_LABEL = 'co.goondocks.myco-worker.0ther000';

type RunOpts = { stopDaemon?: CutoverDeps['stopDaemon']; signal?: AbortSignal; fetch?: MemberRig['fetch']; mycoHome?: string | null; env?: NodeJS.ProcessEnv; provision?: CutoverDeps['provision']; agents?: string[]; unitDirs?: CutoverDeps['unitDirs'] };
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
      signal: o.signal, fetch: o.fetch ?? rig.fetch, mycoHome: o.mycoHome === null ? undefined : (o.mycoHome ?? mycoHome), machineId: TEST_MACHINE_ID,
      env: o.env ?? { ...process.env, HOME: home, MYCO_LAUNCH_AGENTS_DIR: agentsDir },
      sleep: async () => {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l), packageRoot: resolvePackageRoot(),
      agents: () => o.agents ?? ['claude-code'], platform: 'darwin',
      launchctl: fakeLaunchctl(launchctl.loaded, launchctl.calls),
      stopDaemon: o.stopDaemon ?? (async () => 'none'),
      provision: o.provision,
      unitDirs: o.unitDirs,
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
  beforeEach(async () => {
    m = await machine();
    heldHome = process.env.HOME;
    process.env.HOME = m.home;
  });
  afterEach(() => {
    if (heldHome === undefined) delete process.env.HOME; else process.env.HOME = heldHome;
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


  for (const [kind, fix] of [
    ['edge', 'Cloudflare Security Events'], ['edge-mid', 'Cloudflare Security Events'], ['worker', 'check this machine'], ['server', 'check its health'],
    ['refused', 'correct the source record'], ['large', 'reduce that record'],
    ['interrupted', 'resume safely'],
  ] as const) {
    it(`prints grouped causes and stoppedBy when cutover meets ${kind}`, async () => {
      const controller = new AbortController();
      const edge = refuseImportAfter(2, m.rig.fetch);
      const fetch: MemberRig['fetch'] = async (input, init) => {
        const route = new URL(new Request(input, init).url).pathname;
        if (kind === 'edge-mid' && ['/import/plan', '/events', '/blobs'].includes(route)) return edge.fetchImpl(input, init);
        if (kind === 'worker' && route === '/import/plan') return new Response('forbidden', { status: 403, headers: { 'x-myco-protocol': '1' } });
        if (route === '/import/plan' && (kind === 'edge' || kind === 'server')) return new Response('upstream', { status: kind === 'edge' ? 403 : 500 });
        if (route === '/events') {
          if (kind === 'interrupted') { controller.abort(); throw new DOMException('stopped', 'AbortError'); }
          if (kind === 'refused' || kind === 'large') return Response.json({ persisted: false, code: kind === 'large' ? 'body_cap' : 'invalid_field', reason: 'fixture' }, { headers: { 'x-myco-protocol': '1' } });
        }
        return m.rig.fetch(input, init);
      };
      const result = await m.run([], { fetch, signal: controller.signal });
      expect(result.ok).toBe(false);
      const output = result.out.join('\n');
      expect(output).toMatch(/\d+ records? or uploads?:/);
      expect(output).toContain(fix);
      if (kind === 'edge-mid' || kind === 'refused' || kind === 'large') expect(output).not.toContain('stoppedBy:');
      else expect(output.split('\n').filter((l) => l.includes('stoppedBy:')).join('\n')).toContain(fix);
      if (kind === 'edge') expect(output).toContain('likely a security rule');
      if (kind === 'interrupted') {
        const resumed = await m.run();
        expect(resumed.ok).toBe(true);
      }
    });
  }

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
    // Antigravity's 1.4 plugin: its hooks file, and the manifest that goes with it.
    const legacyBin = path.join(m.legacyHome, 'bin', 'myco');
    const plugin = path.join(m.home, '.gemini', 'config', 'plugins', 'myco');
    writeJson(path.join(plugin, 'hooks.json'), { myco: { Stop: [{ type: 'command', command: `${legacyBin} hook stop --symbiont antigravity --myco-managed` }] } });
    writeJson(path.join(plugin, 'plugin.json'), { name: 'myco' });
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
    expect(m.planned[0].filter((o) => o.includes(plugin))).toHaveLength(2);
    expect(m.done).toEqual(m.planned[0]);
    expect(m.planned[1]).toEqual(m.planned[0]);
    expect(fs.existsSync(path.join(plugin, 'hooks.json'))).toBe(false);
    expect(fs.existsSync(path.join(plugin, 'plugin.json'))).toBe(false);
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
    expect(said).toContain(`GitHub Copilot: removed 1 1.4 hook from ${copilotHooks}; GitHub Copilot is no longer captured by Myco 2.0`);
    expect(said).toContain(`Cline: removed ${clinePlugin}`);
    expect(said).not.toContain('Cline is no longer captured');
    expect(hookCommands(readJson(copilotHooks).hooks)).toEqual([]);
    expect(readJson(copilotMcp).mcpServers).toEqual({ mine: { command: 'mine' } });
    expect(fs.statSync(copilotMcp).mode & 0o777).toBe(0o640);
    expect(backupsOf(copilotMcp)).toHaveLength(1);
    expect(readJson(vscodeMcp).servers).toEqual({});
    expect(fs.existsSync(clinePlugin)).toBe(false);
    expect(backupsOf(clinePlugin)).toHaveLength(1);
    expect(readJson(settingsFile()).mcpServers).toEqual({});
  });

  it('keeps a 2.0 member plugin, and refuses another home\'s plugin', async () => {
    const clinePlugin = path.join(m.home, '.cline', 'plugins', 'myco.ts');
    fs.mkdirSync(path.dirname(clinePlugin), { recursive: true });
    const memberPlugin = `// myco:plugin-marker — Myco owns this file\nconst args = ["hook", verb, "--symbiont", "cline", "${CREDENTIAL_FLAG}", "registry"];\n`;
    fs.writeFileSync(clinePlugin, memberPlugin);
    const kept = await m.run();
    expect(kept.err).toEqual([]);
    expect(fs.readFileSync(clinePlugin, 'utf8')).toBe(memberPlugin);

    const other = await machine();
    try {
      process.env.HOME = other.home;
      const foreignPlugin = path.join(other.home, '.cline', 'plugins', 'myco.ts');
      fs.mkdirSync(path.dirname(foreignPlugin), { recursive: true });
      fs.writeFileSync(foreignPlugin, '// myco:plugin-marker\nconst bin = "/elsewhere/other/bin/myco";\n');
      const refused = await other.run();
      expect(refused.ok).toBe(false);
      expect(refused.err.join('\n')).toContain(`${foreignPlugin} holds a Myco plugin of another installation`);
      expect(fs.existsSync(foreignPlugin)).toBe(true);
    } finally {
      process.env.HOME = m.home;
    }
  });

  it('takes 1.4 out of each connected folder, Claude Code\'s per-folder entries and the skill links', async () => {
    const legacyBin = path.join(m.legacyHome, 'bin', 'myco');
    const projectSettings = path.join(m.root, '.claude', 'settings.json');
    const projectMcp = path.join(m.root, '.mcp.json');
    writeJson(projectSettings, { hooks: { Stop: [{ hooks: [{ type: 'command', command: `${legacyBin} hook stop --symbiont claude-code --myco-managed` }, { type: 'command', command: 'echo mine' }] }] } });
    writeJson(projectMcp, { mcpServers: { myco: { type: 'stdio', command: legacyBin, args: ['mcp'] }, mine: { command: 'mine' } } });
    const claudeJson = path.join(m.home, '.claude.json');
    writeJson(claudeJson, { ...readJson(claudeJson), projects: { [m.root]: { mcpServers: { myco: { command: legacyBin, args: ['mcp'] } }, allowedTools: ['x'] } } });
    // A 1.4 skill link, where 2.0 has the same skill, and one where it has none.
    for (const name of ['myco', 'myco-old']) fs.mkdirSync(path.join(m.legacyHome, 'skills', name), { recursive: true });
    fs.mkdirSync(path.join(m.mycoHome, 'skills', 'myco'), { recursive: true });
    const skills = path.join(m.home, '.claude', 'skills');
    fs.mkdirSync(skills, { recursive: true });
    for (const name of ['myco', 'myco-old']) fs.symlinkSync(path.join(m.legacyHome, 'skills', name), path.join(skills, name));

    const dry = (await m.run(['--dry-run'])).out.join('\n');
    expect(dry).toContain(`would point the skill link ${path.join(skills, 'myco')} (now to ${path.join(m.legacyHome, 'skills', 'myco')}) at ${path.join(m.mycoHome, 'skills', 'myco')}`);
    expect(dry).toContain(`would remove the skill link ${path.join(skills, 'myco-old')} (to ${path.join(m.legacyHome, 'skills', 'myco-old')}); ${m.mycoHome} has no such skill`);
    const result = await m.run();
    expect(result.err).toEqual([]);
    expect(result.ok).toBe(true);
    expect(hookCommands(readJson(projectSettings).hooks)).toEqual(['echo mine']);
    expect(readJson(projectMcp).mcpServers).toEqual({ mine: { command: 'mine' } });
    const projects = readJson(claudeJson).projects as Record<string, Record<string, unknown>>;
    expect(projects[m.root]).toEqual({ mcpServers: {}, allowedTools: ['x'] });
    expect(fs.readlinkSync(path.join(skills, 'myco'))).toBe(path.join(m.mycoHome, 'skills', 'myco'));
    expect(fs.existsSync(path.join(skills, 'myco-old'))).toBe(false);
    // Every one of them, and the unit, the claim, the pin and the folder's registry entry, is in the manifest; restore.md undoes them.
    const [folder] = fs.readdirSync(path.join(m.mycoHome, 'backups'));
    const dir = path.join(m.mycoHome, 'backups', folder);
    const entries = (readJson(path.join(dir, 'manifest.json')).entries as Array<Record<string, string>>);
    const originals = entries.map((e) => e.original);
    expect(originals).toEqual(expect.arrayContaining([projectSettings, projectMcp, claudeJson, path.join(skills, 'myco'), path.join(skills, 'myco-old'),
      path.join(m.agentsDir, `${DAEMON_LABEL}.plist`), path.join(m.legacyHome, 'claims', 'symbiont-config.json'), path.join(m.legacyHome, 'runtime.home')]));
    expect(entries.find((e) => e.original === path.join(skills, 'myco-old'))?.link).toBe(path.join(m.legacyHome, 'skills', 'myco-old'));
    expect(fs.existsSync(entries.find((e) => e.original === path.join(m.agentsDir, `${DAEMON_LABEL}.plist`))!.backup)).toBe(true);
    const restore = fs.readFileSync(path.join(dir, 'restore.md'), 'utf8');
    expect(restore).toContain(`ln -sfn '${path.join(m.legacyHome, 'skills', 'myco-old')}' '${path.join(skills, 'myco-old')}'`);
    expect(restore).toContain(`rm -f '${path.join(m.legacyHome, 'runtime.home')}'`);
    expect(restore).toContain(`'${path.join(m.agentsDir, `${DAEMON_LABEL}.plist`)}'`);
    expect(result.out.join('\n')).toContain(`run the commands in ${path.join(dir, 'restore.md')}`);
  });

  it('plans a removal for every MCP file of an agent that provisioning does not write (Cline)', async () => {
    const legacyBin = path.join(m.legacyHome, 'bin', 'myco');
    const written = path.join(m.home, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
    const other = path.join(m.home, '.cline', 'mcp.json');
    for (const file of [written, other]) writeJson(file, { mcpServers: { myco: { type: 'stdio', command: legacyBin, args: ['mcp'] }, mine: { command: 'mine' } } });
    const result = await m.run([], { agents: ['claude-code', 'cline'] });
    expect(result.err).toEqual([]);
    expect(result.ok).toBe(true);
    // Provisioning wrote the member's entry into the one file it writes; the other file's 1.4 entry was planned and removed.
    const member = (readJson(written).mcpServers as Record<string, Record<string, unknown>>).myco;
    expect(JSON.stringify(member)).toContain(CREDENTIAL_FLAG);
    expect(readJson(other).mcpServers).toEqual({ mine: { command: 'mine' } });
    expect(m.planned[0].some((o) => o.startsWith(`remove ${other} :: mcp`))).toBe(true);
    expect(m.planned[0].some((o) => o.startsWith(`remove ${written} `))).toBe(false);
    expect(m.done).toEqual(m.planned[0]);
  });

  it('leaves no empty hook group or event behind, and keeps every entry that is not Myco\'s', async () => {
    const legacy = (event: string) => ({ type: 'command', command: `${path.join(m.legacyHome, 'bin', 'myco')} hook ${event} --symbiont claude-code --myco-managed` });
    const projectSettings = path.join(m.root, '.claude', 'settings.json');
    writeJson(projectSettings, {
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        SessionStart: [{ hooks: [legacy('session-start')] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [legacy('pre-tool-use')] }, { matcher: 'Edit', hooks: [{ type: 'command', command: 'lint' }] }],
        Stop: [{ hooks: [legacy('stop'), { type: 'command', command: 'echo mine' }] }],
      },
    });
    const result = await m.run();
    expect(result.ok).toBe(true);
    expect(readJson(projectSettings)).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'lint' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
      },
    });
  });

  it('points a connected folder\'s runtime pin at the 2.0 binary when it names a 1.4 binary, and backs it up', async () => {
    const pin = path.join(m.root, '.myco', 'runtime.command');
    fs.mkdirSync(path.dirname(pin), { recursive: true });
    fs.writeFileSync(pin, `${path.join(m.legacyHome, 'bin', 'myco')}\n`, { mode: 0o644 });
    const dry = await m.run(['--dry-run']);
    expect(dry.out.join('\n')).toContain(`would point ${pin} (now \`${path.join(m.legacyHome, 'bin', 'myco')}\`, a 1.4 binary) at ${resolveManagedBinaryPath(m.mycoHome)}`);
    const result = await m.run();
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(pin, 'utf8').trim()).toBe(resolveManagedBinaryPath(m.mycoHome));
    expect(backupsOf(pin)).toHaveLength(1);
  });

  it('fails when a 1.4 registration is still there once every change is made', async () => {
    const legacyBin = path.join(m.legacyHome, 'bin', 'myco');
    const copilotMcp = path.join(m.home, '.copilot', 'mcp-config.json');
    const provision: CutoverDeps['provision'] = (agent, root, home, opts) => {
      const outcome = provisionGlobally(agent, root, home, opts);
      writeJson(copilotMcp, { mcpServers: { myco: { command: legacyBin, args: ['mcp'] } } });
      return outcome;
    };
    const result = await m.run([], { provision });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain(`${copilotMcp} still holds a 1.4 registration`);
    expect(bootouts()).toEqual([]);
  });

  it('fails the run when the vault import is refused outright', async () => {
    const olderServer: MemberRig['fetch'] = async (input, init) => {
      const res = await m.rig.fetch(input, init);
      if (!String(input).endsWith('/import/plan')) return res;
      const body = await res.json() as Record<string, unknown>;
      delete body.sessions;
      return Response.json(body);
    };
    const result = await m.run([], { fetch: olderServer });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('update the Deployment');
  });

  it('passes an MCP entry for its own Deployment before the folder is connected', async () => {
    expect((await m.run()).ok).toBe(true);
    for (const entry of listRegistryEntries(m.mycoHome)) fs.rmSync(registryEntryPath(entry.root!, m.mycoHome));
    const again = await m.run(['--dry-run']);
    expect(again.err).toEqual([]);
    expect(again.ok).toBe(true);
  });

  it('removes the unit file it read even when the file is named for another label', async () => {
    fs.renameSync(path.join(m.agentsDir, `${DAEMON_LABEL}.plist`), path.join(m.agentsDir, 'co.goondocks.myco.renamed.plist'));
    const result = await m.run();
    expect(result.ok).toBe(true);
    expect(bootouts()).toEqual([DAEMON_LABEL]);
    expect(fs.existsSync(path.join(m.agentsDir, 'co.goondocks.myco.renamed.plist'))).toBe(false);
  });

  it('refuses a 1.4 unit that starts at boot rather than stopping it as a user unit', async () => {
    const boot = path.join(m.home, 'LaunchDaemons');
    fs.mkdirSync(boot, { recursive: true });
    fs.renameSync(path.join(m.agentsDir, `${DAEMON_LABEL}.plist`), path.join(boot, `${DAEMON_LABEL}.plist`));
    const result = await m.run([], { unitDirs: [{ dir: m.agentsDir, scope: 'user' }, { dir: boot, scope: 'boot' }] });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain(`${path.join(boot, `${DAEMON_LABEL}.plist`)} starts ${m.legacyHome}'s 1.4 daemon at boot`);
    expect(m.launchctl.calls).toEqual([]);
    expect(fs.existsSync(path.join(boot, `${DAEMON_LABEL}.plist`))).toBe(true);
  });

  it('refuses a member MCP entry of another Deployment before its first change', async () => {
    const other = '/elsewhere/member/bin/myco';
    writeJson(path.join(m.home, '.claude.json'), { mcpServers: { myco: { type: 'http', url: 'https://other.invalid/mcp', headersHelper: `${other} member mcp-headers ${CREDENTIAL_FLAG} registry --server https://other.invalid` } } });
    const unchanged = untouched();
    for (const args of [['--dry-run'], []]) {
      const result = await m.run(args);
      expect(result.ok).toBe(false);
      expect(result.err.join('\n')).toContain("Claude Code's Myco tools stay on https://other.invalid");
      expect(result.err.join('\n')).toContain('myco doctor');
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

  for (const interrupted of [false, true]) it(`reports why the transcript import ${interrupted ? 'was interrupted' : 'was refused'}`, async () => {
    const controller = new AbortController();
    const id = '00000000-0000-4000-8000-000000000002';
    const transcript = path.join(m.home, '.claude', 'projects', `-${rootSlug(m.root)}`, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: m.root, sessionId: id, message: { content: `after 1.4 ${'x'.repeat(5000)}` }, timestamp: '2026-08-01T10:00:00Z' })}\n`);
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(transcript, old, old);
    const refusing: MemberRig['fetch'] = async (input, init) => {
      const transcriptPlan = String(input).endsWith('/import/plan') && !String(init?.body ?? '').includes('"sessions"');
      if (transcriptPlan && interrupted) { controller.abort(); throw new DOMException('stopped', 'AbortError'); }
      return transcriptPlan ? new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }) : m.rig.fetch(input, init);
    };
    const result = await m.run([], { fetch: refusing, signal: controller.signal });
    expect(result.ok).toBe(false);
    if (interrupted) {
      expect(result.out.some((line) => line.startsWith('9.'))).toBe(false);
      expect(result.out.join('\n')).toMatch(/stoppedBy:.*you stopped the import; run the same command again to resume safely/);
    }
    expect(result.err.join('\n')).toMatch(/the transcript import stopped before it finished \(proj_1: [^)]+\)/);
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
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: m.home, MYCO_LAUNCH_AGENTS_DIR: m.agentsDir };
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
  it('stops the pinned home\'s daemon, points both homes\' claims at it, and takes 1.4 out of every agent', async () => {
    const m = await machine({ legacyHome: '.myco-dev' });
    const heldHome = process.env.HOME;
    process.env.HOME = m.home;
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
      const args = ['--legacy-home', prod, '--legacy-home', m.legacyHome, '--route', `${PROJECT}=${SERVER}`];
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
    const refused = spawnSync(process.execPath, [cli, 'cutover', '--dry-run'], { env, cwd: home, encoding: 'utf8', timeout: 60_000 });
    expect(refused.stderr).toContain('myco cutover: this machine is not signed in to a Deployment');
    expect(refused.status).toBe(2);
    expect(spawnSync(process.execPath, [cli, 'cutover', '--help'], { env, cwd: home, encoding: 'utf8', timeout: 60_000 }).status).toBe(0);
  });
});


describe('cutover project destinations and receipts', () => {
  let m: Machine;
  let personal: MemberRig;
  let homelab: string;
  let heldHome: string | undefined;
  const PERSONAL = 'https://personal.invalid';
  const HOMELAB = 'proj_homelab';
  beforeEach(async () => {
    m = await machine();
    heldHome = process.env.HOME; process.env.HOME = m.home;
    personal = await memberRig({ projectId: HOMELAB });
    homelab = path.join(m.home, 'Repos', 'homelab');
    fs.mkdirSync(homelab, { recursive: true }); execFileSync('git', ['init', '-q', homelab]);
    writeDeploymentMembership({ serverUrl: PERSONAL, token: personal.token, tokenId: personal.tokenId, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome: m.mycoHome });
    writeRegistryEntry({ version: 2, root: homelab, projectId: HOMELAB, serverUrl: PERSONAL, token: personal.token, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome: m.mycoHome });
    recordDefaultDeployment(SERVER, { mycoHome: m.mycoHome });
    const db = openDatabase(m.vault);
    try {
      db.run('PRAGMA foreign_keys=OFF');
      db.run("INSERT INTO sessions (id,agent,project_root,project_id,started_at,ended_at,status,title,created_at) VALUES ('00000000-0000-4000-8000-000000000002','claude-code',?,?,?,?,'completed','personal session',?)", [homelab, HOMELAB, NOW_S - 86400, NOW_S - 86000, NOW_S - 86400]);
      db.run("INSERT INTO spores (id,project_id,agent_id,observation_type,status,content,created_at) VALUES ('personal-spore',?,'user','gotcha','active','personal only',?)", [HOMELAB, NOW_S]);
      db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { db.close(); }
  });
  afterEach(() => { if (heldHome === undefined) delete process.env.HOME; else process.env.HOME = heldHome; });
  const fetchBoth: MemberRig['fetch'] = (input, init) => {
    const req = new Request(input, init);
    return new URL(req.url).origin === PERSONAL ? personal.fetch(req) : m.rig.fetch(req);
  };
  const projectsOn = (rig: MemberRig, table: string) => rig.env.sqlite.query(`SELECT DISTINCT project_id FROM ${table} ORDER BY project_id`).all();

  it('previews first, then places homelab only on personal and every other project only on work', async () => {
    let requests = 0;
    const fetch: MemberRig['fetch'] = (input, init) => { requests += 1; return fetchBoth(input, init); };
    const before = sha(m.vault);
    const dry = await m.run(['--dry-run'], { fetch, agents: [] });
    expect(dry.ok).toBe(true); expect(requests).toBe(0); expect(sha(m.vault)).toBe(before);
    expect(dry.out.join('\n')).toContain(`${HOMELAB} from ${m.vault}: to ${PERSONAL}`);
    expect(dry.out.join('\n')).toContain(`${PROJECT} from ${m.vault}: to ${SERVER}`);
    expect(fs.existsSync(path.join(m.mycoHome, 'member', 'cutover.json'))).toBe(false);
    const result = await m.run([], { fetch, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    for (const table of ['sessions', 'spores', 'events']) {
      expect(projectsOn(personal, table)).toEqual([{ project_id: HOMELAB }]);
      expect(projectsOn(m.rig, table)).toEqual([{ project_id: PROJECT }]);
    }
    expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
    const state = readCutoverState(m.mycoHome);
    expect(state.version).toBe(2);
    expect(state.migrations![m.vault].projects[HOMELAB].destination).toMatchObject({ serverUrl: PERSONAL });
    expect(state.migrations![m.vault].projects[PROJECT].destination).toMatchObject({ serverUrl: SERVER });
    expect(sha(m.vault)).toBe(before);
  });

  it('refuses to route a bound personal repository to the work default', async () => {
    const result = await m.run(['--route', `${HOMELAB}=${SERVER}`], { fetch: fetchBoth, agents: [] });
    expect(result.ok).toBe(false); expect(result.err.join('\n')).toContain(`routes to ${PERSONAL}`);
    expect(personal.rows('events')).toBe(0); expect(m.rig.rows('events')).toBe(0);
  });

  it('preserves skipped project spools byte for byte, and preserves the skip on retry', async () => {
    const spool = routedSpoolDir({ serverUrl: PERSONAL, projectId: HOMELAB }, m.mycoHome);
    fs.mkdirSync(spool, { recursive: true });
    fs.writeFileSync(path.join(spool, 'destination.json'), JSON.stringify({ serverUrl: PERSONAL, projectId: HOMELAB }), { mode: 0o600 });
    const file = path.join(spool, 'outbox.ndjson'); fs.writeFileSync(file, 'retained spool bytes');
    const before = sha(file);
    const first = await m.run(['--route', `${PROJECT}=${SERVER}`, '--skip', HOMELAB], { fetch: fetchBoth, agents: [] });
    expect(first.err).toEqual([]); expect(first.ok).toBe(true); expect(sha(file)).toBe(before);
    expect(personal.rows('events')).toBe(0);
    expect((await m.run([], { fetch: fetchBoth, agents: [] })).ok).toBe(true);
    expect(personal.rows('events')).toBe(0); expect(sha(file)).toBe(before);
    expect(readCutoverState(m.mycoHome).migrations![m.vault].projects[HOMELAB].destination).toMatchObject({ skip: true });
  });

  it('resumes after interruption between destinations without uploading the completed destination again', async () => {
    const stop = new AbortController();
    const interrupted: MemberRig['fetch'] = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).origin === PERSONAL) stop.abort();
      return fetchBoth(req);
    };
    expect((await m.run([], { fetch: interrupted, signal: stop.signal, agents: [] })).ok).toBe(false);
    const state = readCutoverState(m.mycoHome);
    expect(state.migrations![m.vault].projects[PROJECT].vault?.state).toBe('complete');
    expect(state.migrations![m.vault].projects[HOMELAB].vault?.state).not.toBe('complete');
    let workUploads = 0;
    const resumed: MemberRig['fetch'] = (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).origin === SERVER && req.method === 'POST' && (new URL(req.url).pathname === '/events' || new URL(req.url).pathname.startsWith('/blobs/'))) workUploads += 1;
      return fetchBoth(req);
    };
    const result = await m.run([], { fetch: resumed, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true); expect(workUploads).toBe(0);
    expect(projectsOn(personal, 'sessions')).toEqual([{ project_id: HOMELAB }]);
  });

  it('upgrades a completed alpha backup-only record without a second upload', async () => {
    expect((await m.run([], { fetch: fetchBoth, agents: [] })).ok).toBe(true);
    const record = path.join(m.mycoHome, 'member', 'cutover.json');
    const state = readCutoverState(m.mycoHome);
    fs.writeFileSync(record, JSON.stringify({ backups: state.backups }));
    expect(legacyMigrationState(m.mycoHome).state).toBe('needs-destination');
    let uploads = 0;
    const confirming: MemberRig['fetch'] = (input, init) => {
      const req = new Request(input, init); const route = new URL(req.url).pathname;
      if (req.method === 'POST' && (route === '/events' || route.startsWith('/blobs/'))) uploads += 1;
      return fetchBoth(req);
    };
    const result = await m.run([], { fetch: confirming, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true); expect(uploads).toBe(0);
    expect(readCutoverState(m.mycoHome).version).toBe(2); expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
  });

  it('refuses an undecided project and names route and skip commands', () => {
    fs.unlinkSync(path.join(m.mycoHome, 'member', 'default.json'));
    fs.unlinkSync(registryEntryPath(homelab, m.mycoHome));
    const plan = planCutover(m.mycoHome, { homeDir: m.home });
    expect(plan.blockers.join('\n')).toContain(`--route ${PROJECT}=<url> or --skip ${PROJECT}`);
  });

  it('reads local machine identity instead of a stored destination identity without writing during preview', () => {
    writeDeploymentMembership({ serverUrl: SERVER, token: m.rig.token, machineId: 'older-membership-machine', joinedAt: 1, updatedAt: 2 }, { mycoHome: m.mycoHome });
    const deps = { agents: () => [], unitDirs: [] };
    const before = sha(path.join(m.mycoHome, 'machine_id'));
    const plan = planCutover(m.mycoHome, { homeDir: m.home, dryRun: true }, deps);
    expect(plan.blockers).toEqual([]);
    expect(plan.machineId).toBe(TEST_MACHINE_ID);
    expect(sha(path.join(m.mycoHome, 'machine_id'))).toBe(before);
  });

  it('allows every project to be skipped without a membership or import identity', async () => {
    fs.rmSync(path.join(m.mycoHome, 'member', 'deployments'), { recursive: true, force: true });
    fs.unlinkSync(path.join(m.mycoHome, 'machine_id'));
    const db = openDatabase(m.vault);
    try { db.run("UPDATE sessions SET machine_id='retained-legacy-machine'"); db.run('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
    const deps = { agents: () => [], unitDirs: [], stopDaemon: async () => 'none' as const, stdout: () => {}, stderr: () => {} };
    const plan = planCutover(m.mycoHome, { homeDir: m.home, skips: new Set([PROJECT, HOMELAB]) }, deps);
    expect(plan.blockers).toEqual([]);
    expect((await executeCutoverPlan(plan, deps)).ok).toBe(true);
    expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
    expect(fs.existsSync(path.join(m.mycoHome, 'machine_id'))).toBe(false);
  });

  it('hands over project-local legacy registrations at skipped roots while keeping foreign entries and history', async () => {
    const legacyMcp = path.join(homelab, '.cursor', 'mcp.json');
    const foreignMcp = path.join(homelab, '.codex', 'config.toml');
    writeJson(legacyMcp, { mcpServers: { myco: { command: `${m.legacyHome}/bin/myco`, args: ['mcp'] }, mine: { command: 'mine' } } });
    fs.mkdirSync(path.dirname(foreignMcp), { recursive: true });
    fs.writeFileSync(foreignMcp, '[mcp_servers.myco]\ncommand = "/foreign/bin/myco"\nargs = ["mcp"]\n');
    const foreignBefore = sha(foreignMcp), vaultBefore = sha(m.vault), legacyBefore = sha(legacyMcp);
    const preview = await m.run(['--skip', PROJECT, '--skip', HOMELAB, '--dry-run'], { agents: [] });
    expect(preview.err).toEqual([]); expect(preview.ok).toBe(true);
    expect(preview.out.join('\n')).toContain(legacyMcp);
    expect(sha(legacyMcp)).toBe(legacyBefore);
    const result = await m.run(['--skip', PROJECT, '--skip', HOMELAB], { agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    expect(readJson(legacyMcp)).toEqual({ mcpServers: { mine: { command: 'mine' } } });
    expect(sha(foreignMcp)).toBe(foreignBefore); expect(sha(m.vault)).toBe(vaultBefore);
    expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
    expect(projectsOn(m.rig, 'sessions')).toEqual([]); expect(projectsOn(personal, 'sessions')).toEqual([]);
  });

  it('reports a skipped checkout that cannot safely hand over project registrations', () => {
    fs.rmSync(path.join(homelab, '.git'), { recursive: true });
    const plan = planCutover(m.mycoHome, { homeDir: m.home, skips: new Set([HOMELAB]) }, { agents: () => [], unitDirs: [] });
    expect(plan.blockers.join('\n')).toContain(`skipped folder ${homelab} is unsafe to inspect`);
  });

  it('does not let skipped foreign-machine sessions block routed spore history', async () => {
    const db = openDatabase(m.vault);
    try {
      db.run('PRAGMA foreign_keys=OFF');
      db.run('DELETE FROM prompt_batches WHERE project_id=?', [PROJECT]);
      db.run('DELETE FROM sessions WHERE project_id=?', [PROJECT]);
      db.run("UPDATE sessions SET machine_id='retained-legacy-machine' WHERE project_id=?", [HOMELAB]);
      db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { db.close(); }
    const result = await m.run(['--skip', HOMELAB, '--route', `${PROJECT}=${SERVER}`], { fetch: fetchBoth, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    expect(projectsOn(m.rig, 'spores')).toEqual([{ project_id: PROJECT }]);
    expect(projectsOn(personal, 'spores')).toEqual([]);
    expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
  });

  it('executes the exact revalidated preparation without a third agent discovery', async () => {
    let discoveries = 0;
    const deps = { agents: () => { discoveries += 1; return discoveries > 2 ? ['codex'] : []; }, unitDirs: [], stdout: () => {} };
    const plan = planCutover(m.mycoHome, { homeDir: m.home, dryRun: true }, deps);
    expect((await executeCutoverPlan(plan, deps)).ok).toBe(true);
    expect(discoveries).toBe(2);
    expect(fs.existsSync(path.join(m.home, '.codex', 'config.toml'))).toBe(false);
  });

  it('includes handover and copies in the preview and refuses newly added registrations', async () => {
    const deps = { agents: () => [], unitDirs: [], machineId: TEST_MACHINE_ID, stopDaemon: async () => 'none' as const };
    const plan = planCutover(m.mycoHome, { homeDir: m.home, dryRun: true }, deps);
    expect(plan.blockers).toEqual([]);
    expect(plan.handover.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.projects.find((p) => p.projectId === HOMELAB)?.counts).toMatchObject({ sessions: 1, spores: 1 });
    expect(plan.handover.flatMap((s) => s.actions).some((a) => a.outcomes.includes(`connect ${m.root}`))).toBe(true);
    expect(plan.copies).toEqual([expect.objectContaining({ vault: m.vault, reused: false })]);
    const settings = path.join(m.home, '.claude', 'settings.json');
    const config = readJson(settings) as { hooks: Record<string, unknown> };
    config.hooks.SessionEnd = [{ hooks: [{ type: 'command', command: `${m.legacyHome}/bin/myco hook session-end --myco-managed` }] }];
    writeJson(settings, config);
    const before = sha(settings);
    const errors: string[] = [];
    expect((await executeCutoverPlan(plan, { ...deps, stderr: (l) => errors.push(l) })).ok).toBe(false);
    expect(errors.join('\n')).toContain('handover actions changed after the preview');
    expect(sha(settings)).toBe(before);
    expect(fs.existsSync(path.join(m.mycoHome, 'member', 'cutover.json'))).toBe(false);
  });

  it('allows a vault write between planning and lease revalidation, then copies the latest history', async () => {
    const stopped: string[] = [];
    const deps = { fetch: fetchBoth, agents: () => [], unitDirs: [], machineId: TEST_MACHINE_ID, stdout: () => {},
      stopDaemon: async (home: string) => { stopped.push(home); return 'stopped' as const; } };
    const plan = planCutover(m.mycoHome, { homeDir: m.home }, deps);
    const db = openDatabase(m.vault);
    try { db.run("UPDATE spores SET content='changed' WHERE id='gotcha-1'"); } finally { db.close(); }
    const errors: string[] = [];
    expect((await executeCutoverPlan(plan, { ...deps, stderr: (l) => errors.push(l) })).ok).toBe(true);
    expect(errors).toEqual([]);
    expect(stopped).toContain(m.legacyHome);
    expect(m.rig.env.sqlite.query("SELECT content FROM spores WHERE id='gotcha-1'").get()).toEqual({ content: 'changed' });
    expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
  });

  for (const override of [null, 'MYCO_PROJECT_ROOT', 'MYCO_VAULT_DIR'] as const) for (const rootless of [false, true]) it(`requires a disposition for an unrouted ${rootless ? 'rootless' : 'absent'} project with ${override ?? 'no project override'}`, async () => {
    fs.rmSync(m.root, { recursive: true });
    if (rootless) {
      const db = openDatabase(m.vault);
      try { db.run('UPDATE sessions SET project_root=NULL WHERE project_id=?', [PROJECT]); } finally { db.close(); }
    }
    const held = override === null ? undefined : process.env[override];
    if (override !== null) process.env[override] = m.root;
    try {
      const plan = planCutover(m.mycoHome, { homeDir: m.home });
      expect(plan.projects.find(p => p.projectId === PROJECT)?.destination).toEqual({ kind: 'undecided' });
      expect(plan.blockers.join('\n')).toContain(`--route ${PROJECT}=<url> or --skip ${PROJECT}`);
      const explicit = await m.run(['--server', SERVER, '--dry-run'], { fetch: fetchBoth, agents: [] });
      expect(explicit.err).toEqual([]); expect(explicit.ok).toBe(true);
      expect(explicit.out.join('\n')).toContain(`${PROJECT} from ${m.vault}: to ${SERVER} (no repository route; sent to --server)`);
    } finally {
      if (override !== null) { if (held === undefined) delete process.env[override]; else process.env[override] = held; }
    }
  });

  it('refuses a repository rebound after the preview before any request or cutover record', async () => {
    const binding = { version: 2 as const, root: m.root, projectId: PROJECT, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 };
    writeRegistryEntry({ ...binding, serverUrl: SERVER, token: m.rig.token }, { mycoHome: m.mycoHome });
    let requests = 0;
    const errors: string[] = [];
    const deps = { fetch: ((input, init) => { requests += 1; return fetchBoth(input, init); }) as MemberRig['fetch'],
      agents: () => [], unitDirs: [], machineId: TEST_MACHINE_ID, stopDaemon: async () => 'none' as const,
      stdout: () => {}, stderr: (line: string) => errors.push(line) };
    const plan = planCutover(m.mycoHome, { homeDir: m.home }, deps);
    expect(plan.blockers).toEqual([]);
    expect(plan.projects.find(p => p.projectId === PROJECT)?.destination).toEqual({ kind: 'destination', serverUrl: SERVER });
    writeRegistryEntry({ ...binding, serverUrl: PERSONAL, token: personal.token }, { mycoHome: m.mycoHome });
    expect((await executeCutoverPlan(plan, deps)).ok).toBe(false);
    expect(errors.join('\n')).toContain('changed after the preview');
    expect(requests).toBe(0);
    expect(fs.existsSync(path.join(m.mycoHome, 'member', 'cutover.json'))).toBe(false);
  });

  it('names a present non-git folder in its destination blocker', () => {
    fs.rmSync(path.join(m.root, '.git'), { recursive: true });
    const plan = planCutover(m.mycoHome, { homeDir: m.home });
    expect(plan.projects.find(p => p.projectId === PROJECT)?.destination).toEqual({ kind: 'undecided' });
    expect(plan.blockers.join('\n')).toContain(`${m.root} is not a repository`);
    expect(plan.blockers.join('\n')).toContain(`--route ${PROJECT}=<url> or --skip ${PROJECT}`);
  });

  it('labels a present unbound repository destination as default-derived', async () => {
    const result = await m.run(['--dry-run'], { agents: [] });
    expect(result.ok).toBe(true);
    expect(result.out.join('\n')).toContain(`${PROJECT} from ${m.vault}: to ${SERVER} (default Deployment; no repository route)`);
  });

  it('does not carry completion to a re-routed destination when aborted before import', async () => {
    expect((await m.run([], { fetch: fetchBoth, agents: [] })).ok).toBe(true);
    fs.rmSync(m.root, { recursive: true });
    fs.unlinkSync(registryEntryPath(m.root, m.mycoHome));
    const stopped = new AbortController();
    stopped.abort();
    const result = await m.run(['--route', `${PROJECT}=${PERSONAL}`], { fetch: fetchBoth, agents: [], signal: stopped.signal });
    expect(result.ok).toBe(false);
    const receipt = readCutoverState(m.mycoHome).migrations![m.vault].projects[PROJECT];
    expect(receipt.destination).toMatchObject({ serverUrl: PERSONAL });
    expect(receipt.vault?.state).not.toBe('complete');
    expect(legacyMigrationState(m.mycoHome).state).not.toBe('moved');
    expect(projectsOn(personal, 'sessions')).toEqual([{ project_id: HOMELAB }]);
  });

  it('refuses a real vault write across the copy before uploading anything', async () => {
    let copying = false;
    let reads = 0;
    const original = fs.statSync;
    const stat = spyOn(fs, 'statSync').mockImplementation((...args) => {
      if (copying && String(args[0]) === m.vault && ++reads === 2) {
        const db = openDatabase(m.vault);
        try { db.run("UPDATE spores SET content='write during copy' WHERE id='gotcha-1'"); } finally { db.close(); }
      }
      return Reflect.apply(original, fs, args);
    });
    const errors: string[] = [];
    try {
      const deps = { fetch: fetchBoth, agents: () => [], unitDirs: [], machineId: TEST_MACHINE_ID,
        stopDaemon: async () => 'none' as const, stderr: (line: string) => errors.push(line),
        stdout: (line: string) => { if (line.startsWith('7. ')) copying = true; } };
      const plan = planCutover(m.mycoHome, { homeDir: m.home }, deps);
      expect((await executeCutoverPlan(plan, deps)).ok).toBe(false);
      expect(errors.join('\n')).toContain('changed while it was copied');
      expect(m.rig.rows('events')).toBe(0); expect(personal.rows('events')).toBe(0);
    } finally { stat.mockRestore(); }
  });

  it('keeps an absent-root project on its confirmed destination after the default changes', async () => {
    expect((await m.run([], { fetch: fetchBoth, agents: [] })).ok).toBe(true);
    fs.rmSync(m.root, { recursive: true }); fs.unlinkSync(registryEntryPath(m.root, m.mycoHome));
    recordDefaultDeployment(PERSONAL, { mycoHome: m.mycoHome, replace: true });
    const result = await m.run([], { fetch: fetchBoth, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    expect(readCutoverState(m.mycoHome).migrations![m.vault].projects[PROJECT].destination).toMatchObject({ serverUrl: SERVER });
    expect(projectsOn(personal, 'sessions')).toEqual([{ project_id: HOMELAB }]);
  });

  it('imports mapped transcripts from an absent checkout into its connected replacement', async () => {
    const replacement = path.join(m.home, 'Repos', 'replacement');
    fs.mkdirSync(replacement, { recursive: true }); execFileSync('git', ['init', '-q', replacement]);
    writeRegistryEntry({ version: 2, root: replacement, projectId: PROJECT, serverUrl: SERVER, token: m.rig.token, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome: m.mycoHome });
    fs.rmSync(m.root, { recursive: true });
    const id = '00000000-0000-4000-8000-000000000003';
    const transcript = path.join(m.home, '.claude', 'projects', `-${rootSlug(m.root)}`, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: m.root, sessionId: id, message: { content: 'retained mapped transcript' }, timestamp: '2026-08-01T10:00:00Z' })}\n`);
    const old = new Date(Date.now() - 3 * 60 * 60_000); fs.utimesSync(transcript, old, old);
    const result = await m.run(['--map', `${m.root}=${replacement}`, '--route', `${PROJECT}=${SERVER}`], { fetch: fetchBoth, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    expect(m.rig.env.sqlite.query('SELECT session_id FROM sessions WHERE session_id=?').all(id)).toEqual([{ session_id: id }]);
    expect(readCutoverState(m.mycoHome).migrations![m.vault].projects[PROJECT].transcripts?.state).toBe('complete');
  });

  it('receipts describe the verified copy after the last 1.4 write during handover', async () => {
    const result = await m.run([], { fetch: fetchBoth, agents: [], stopDaemon: async () => {
      const db = openDatabase(m.vault);
      try { db.run("UPDATE spores SET content='last 1.4 write' WHERE id='gotcha-1'"); db.run('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
      return 'stopped';
    } });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
  });

  it('refuses new project destinations that appear during handover before uploading anything', async () => {
    const result = await m.run([], { fetch: fetchBoth, agents: [], stopDaemon: async () => {
      const db = openDatabase(m.vault);
      try { db.run("UPDATE spores SET project_id='proj_new' WHERE id='gotcha-1'"); db.run('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
      return 'stopped';
    } });
    expect(result.ok).toBe(false); expect(result.err.join('\n')).toContain('projects or folders changed during handover');
    expect(m.rig.rows('events')).toBe(0); expect(personal.rows('events')).toBe(0);
  });

  it('keeps per-destination receipts when the source changes and a project is skipped', async () => {
    expect((await m.run([], { fetch: fetchBoth, agents: [] })).ok).toBe(true);
    const old = readCutoverState(m.mycoHome).migrations![m.vault];
    const db = openDatabase(m.vault);
    try { db.run("UPDATE spores SET content='later 1.4 write' WHERE id='gotcha-1'"); } finally { db.close(); }
    expect((await m.run(['--skip', PROJECT], { fetch: fetchBoth, agents: [] })).ok).toBe(true);
    const receipt = readCutoverState(m.mycoHome).migrations![m.vault].projects[PROJECT];
    expect(receipt.destination).toMatchObject({ skip: true });
    expect(receipt.destinations![deploymentKeyFor(SERVER)]).toMatchObject({ digest: old.digest, vault: { state: 'complete' } });
  });

  it('requires an explicit disposition when the old folder now belongs to another Project', () => {
    writeRegistryEntry({ version: 2, root: m.root, projectId: 'proj_unrelated', serverUrl: PERSONAL, token: personal.token, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome: m.mycoHome });
    expect(planCutover(m.mycoHome, { homeDir: m.home }).blockers.join('\n')).toContain(`--route ${PROJECT}=<url> or --skip ${PROJECT}`);
    const explicit = planCutover(m.mycoHome, { homeDir: m.home, routes: new Map([[PROJECT, SERVER]]) });
    expect(explicit.blockers).toEqual([]);
    expect(explicit.projects.find((p) => p.projectId === PROJECT)?.destination).toEqual({ kind: 'destination', serverUrl: SERVER });
  });
});
