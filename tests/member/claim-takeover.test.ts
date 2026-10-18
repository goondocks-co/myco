/** Home takeover uses the same provisioned hooks and MCP slots as ordinary member setup. */
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runJoin, runProvision, provisionAgents, recordNoAgents } from '@myco/cli/member.js';
import { run as update } from '@myco/cli/update.js';
import { readProvisionRecord, recordProvision } from '@myco/member/provision-record.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { claimSubsystem, SYMBIONT_CONFIG_SUBSYSTEM } from '@myco/member/subsystem-claim.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { hookCommands } from '@myco/symbionts/member-hooks.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';
import { memberRig } from './helpers/server.js';

const AGENTS = ['claude-code', 'codex', 'cursor', 'cline', 'opencode'];
const SERVER = 'https://myco.example';
let root: string;
let home: string;
let oldHome: string;
let newHome: string;
let restore: () => void;
let configs: string[];
let originals: Map<string, string>;
let savedPath: string | undefined;
const binary = (mycoHome: string) => path.join(mycoHome, 'bin', 'myco');
const put = (file: string, raw: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, raw); };
const membership = (mycoHome: string) => {
  writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome });
  recordDefaultDeployment(SERVER, { mycoHome });
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-claim-takeover-')));
  home = path.join(root, 'home');
  oldHome = path.join(home, 'old-home');
  newHome = path.join(home, 'new-home');
  fs.mkdirSync(newHome, { recursive: true });
  restore = bindSandboxChildHome(root, { HOME: home, MYCO_HOME: oldHome });
  savedPath = process.env.PATH;
  const tools = path.join(root, 'tools');
  for (const agent of AGENTS) {
    const manifest = loadManifests().find(manifest => manifest.name === agent)!;
    const file = path.join(tools, manifest.binary);
    put(file, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(file, 0o755);
  }
  process.env.PATH = tools + path.delimiter + savedPath;
  membership(oldHome);
  for (const mycoHome of [oldHome, newHome]) {
    put(binary(mycoHome), '#!/bin/sh\necho 2.0.0-alpha.0\n');
    fs.chmodSync(binary(mycoHome), 0o755);
  }
  const activity = path.join(home, '.local/share/opencode/opencode.db');
  fs.mkdirSync(path.dirname(activity), { recursive: true });
  const db = new Database(activity);
  db.run('CREATE TABLE session (id TEXT, time_updated INTEGER, parent_id TEXT)');
  db.close();
  const found = provisionAgents(AGENTS, oldHome, SERVER, null);
  expect(found.skipped).toEqual([]);
  configs = [...new Set(AGENTS.flatMap(agent => {
    const reg = loadManifests().find(manifest => manifest.name === agent)!.registration!;
    return [reg.globalHooksTarget!, ...reg.globalMcpTarget!.slice(0, 1).map(target => target.path)].map(file => path.join(home, file.replace(/^~\//, '')));
  }))];
  for (const file of configs.filter(file => file.endsWith('.ts'))) fs.appendFileSync(file, `\nconst retainedMycoBinary = "${binary(oldHome)}";\n`);
  originals = new Map(configs.map(file => [file, fs.readFileSync(file, 'utf8')]));
  process.env.MYCO_HOME = newHome;
  membership(newHome);
  recordNoAgents(newHome, SERVER);
});

afterEach(() => {
  restore();
  if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});

function assertTakenOver() {
  expect(readProvisionRecord(newHome)?.agents).toEqual([...AGENTS].sort());
  for (const file of configs) {
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(binary(oldHome));
    if (!file.endsWith('.ts')) expect(raw).toContain(binary(newHome));
    if (file.endsWith('.json') && raw.includes('"hooks"')) {
      const commands = hookCommands(JSON.parse(raw).hooks);
      expect(new Set(commands).size).toBe(commands.length);
    }
  }
  for (const agent of AGENTS) {
    const manifest = loadManifests().find(manifest => manifest.name === agent)!;
    const installer = new SymbiontInstaller(manifest, newHome, path.resolve('packages/myco'), false, newHome).withoutProjectRoot().forDeployment(SERVER);
    expect(installer.memberRegistrationCurrent()).toBe(true);
  }
}

async function claim() {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });
  try {
    await update(['--claim', '--skip-binary'], {
      home: newHome, runnerRecords: () => [],
      refreshMember: async () => {
        if (!runProvision(['--refresh'], { mycoHome: newHome, cwd: root, stdout: line => lines.push(line), stderr: line => lines.push(line) })) throw new Error('refresh failed');
      },
    });
  } finally { log.mockRestore(); }
  expect(process.exitCode ?? 0).toBe(0);
  return lines.join('\n');
}

for (const state of ['live', 'binary-missing', 'home-missing']) it(`joins with --no-agents then claims the prior agents with old home ${state}`, async () => {
  const rig = await memberRig();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  writeDeploymentMembership({ serverUrl: SERVER, token: rig.token, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 }, { mycoHome: newHome });
  const joined = await runJoin(['--project', 'proj_1', '--root', repo, '--no-agents', '--no-worker'], { mycoHome: newHome, cwd: repo, fetch: rig.fetch, stdout: () => {}, stderr: () => {} });
  expect(joined).not.toBeNull();
  expect(readProvisionRecord(newHome)?.agents).toEqual([]);
  claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, oldHome);
  if (state === 'binary-missing') fs.unlinkSync(binary(oldHome));
  if (state === 'home-missing') fs.rmSync(oldHome, { recursive: true });
  const said = await claim();
  assertTakenOver();
  for (const name of ['Claude Code', 'Codex', 'Cursor', 'Cline', 'OpenCode']) expect(said).toContain(name);
  for (const file of configs) expect(said).toContain(file);
  expect(said).not.toContain('leaves this entry alone');
  const backups = path.join(newHome, 'backups');
  const saved = fs.readdirSync(backups).flatMap(folder => fs.readdirSync(path.join(backups, folder), { recursive: true }).filter((file): file is string => typeof file === 'string').map(file => path.join(backups, folder, file))).filter(file => fs.statSync(file).isFile()).map(file => fs.readFileSync(file, 'utf8'));
  for (const raw of originals.values()) expect(saved).toContain(raw);
});

it('discovers managed agents with no previous claim and overrides an empty new record', async () => {
  await claim();
  assertTakenOver();
});

it('unions prior choices with this home choices, rather than replacing them', async () => {
  recordProvision(oldHome, { version: 'test', serverUrl: SERVER, agents: ['claude-code'] }, { replace: true });
  recordProvision(newHome, { version: 'test', serverUrl: SERVER, agents: ['cursor'] });
  claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, oldHome);
  await claim();
  expect(readProvisionRecord(newHome)?.agents).toEqual(['claude-code', 'cursor']);
});

it('provisions missing-binary entries in place while the old home still exists', () => {
  fs.unlinkSync(binary(oldHome));
  const found = provisionAgents(AGENTS, newHome, SERVER, null);
  expect(found.skipped).toEqual([]);
  assertTakenOver();
  expect(found.notices?.join('\n')).toContain('replaced Myco entry');
});

it('keeps a no-agents record empty beside dynamic owned plugins during ordinary refresh', () => {
  for (const [file, raw] of originals) if (file.endsWith('.ts')) put(file, raw.split('\nconst retainedMycoBinary')[0]);
  const before = new Map(configs.map(file => [file, fs.readFileSync(file, 'utf8')]));
  for (let pass = 0; pass < 2; pass++) expect(runProvision(['--refresh'], { mycoHome: newHome, cwd: root, stdout: () => {}, stderr: () => {} })).toBe(true);
  expect(readProvisionRecord(newHome)?.agents).toEqual([]);
  expect(readProvisionRecord(newHome)?.discoverAgents).toBe(false);
  for (const [file, raw] of before) expect(fs.readFileSync(file, 'utf8')).toBe(raw);
});

for (const peerClaim of [false, true]) it(`leaves another live home alone with peer claim=${peerClaim}`, () => {
  if (peerClaim) claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, oldHome);
  const found = provisionAgents(AGENTS, newHome, SERVER, null);
  expect(found.skipped.length).toBe(AGENTS.length);
  for (const [file, raw] of originals) expect(fs.readFileSync(file, 'utf8')).toBe(raw);
});

for (const entry of [{ url: 'https://unrelated.example/mcp' }, { command: 'fixture', args: ['mcp'] }, { url: SERVER + '/mcp', headersHelper: 'fixture' }]) it(`preserves unowned hooks and MCP slot ${JSON.stringify(entry)} under an explicit claim`, () => {
  const hooks = path.join(home, '.claude', 'settings.json');
  const tools = path.join(home, '.claude.json');
  const unowned = `${binary(oldHome)} hook stop`;
  put(hooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: unowned }] }] } }));
  if ('command' in entry) entry.command = binary(oldHome);
  if ('headersHelper' in entry) entry.headersHelper = `${binary(oldHome)} member mcp-headers --server ${SERVER}`;
  put(tools, JSON.stringify({ mcpServers: { myco: entry } }));
  claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, newHome);
  const before = fs.readFileSync(tools, 'utf8');
  const found = provisionAgents(['claude-code'], newHome, SERVER, null);
  expect(found.skipped.length).toBe(1);
  expect(fs.readFileSync(tools, 'utf8')).toBe(before);
  fs.unlinkSync(tools);
  expect(provisionAgents(['claude-code'], newHome, SERVER, null).skipped).toEqual([]);
  expect(hookCommands(JSON.parse(fs.readFileSync(hooks, 'utf8')).hooks)).toContain(unowned);
});

it('reports no agents and why when an explicit claim finds no managed setup', async () => {
  for (const file of configs) fs.unlinkSync(file);
  const said = await claim();
  expect(said).toContain('Agents refreshed: no (no agents selected for this home');
  expect(said).not.toContain('Agents refreshed: yes');
  expect(readProvisionRecord(newHome)?.agents).toEqual([]);
});

it('removes an owned same-home alternate MCP key while preserving an unowned alternate', async () => {
  await claim();
  const file = path.join(home, '.claude.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.servers = { myco: structuredClone(data.mcpServers.myco) };
  data.mcp = { myco: { command: 'unrelated-tool' } };
  put(file, JSON.stringify(data));
  const found = provisionAgents(['claude-code'], newHome, SERVER, null);
  expect(found.skipped).toEqual([]);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(after.servers).toBeUndefined();
  expect(after.mcp.myco).toEqual({ command: 'unrelated-tool' });
  expect(after.mcpServers.myco.headersHelper).toContain(binary(newHome));
});

it('reports only rewritten global entries beside a read-only Claude project override', async () => {
  const file = path.join(home, '.claude.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const folder = path.join(root, 'project-override');
  const entry = structuredClone(data.mcpServers.myco);
  data.projects = { [folder]: { mcpServers: { myco: entry } } };
  put(file, JSON.stringify(data));
  const said = await claim();
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).projects[folder].mcpServers.myco).toEqual(entry);
  expect(said).not.toContain(`projects.${folder}.mcpServers.myco`);
  expect(said).toContain(`replaced Myco entry in ${file}: mcpServers.myco`);
});
