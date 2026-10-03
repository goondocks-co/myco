import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { loadManifests } from '@myco/symbionts/detect.js';
import { expandHome } from '@myco/paths/home.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { provisionGlobally, runProvision, provisionBackup } from '@myco/cli/member.js';
import { runHelperVerb } from '@myco/cli/member-helper.js';
import { keepCurrent, reportHarnesses, harnessRanAt } from '@myco/cli/member-keep-current.js';
import { readProvisionRecord, recordProvision, holdHookTrust } from '@myco/symbionts/member-provision-record.js';
import { writeDeploymentMembership, writeRegistryEntry, REGISTRY_VERSION } from '@myco/member/registry.js';
import { updateProjectContext } from '@myco/member/context-cache.js';
import { spoolDirFor } from '@myco/member/spool.js';
import { PROTOCOL_HEADER, MEMBER_PROTOCOL } from '@goondocks/myco-shared/member-protocol';
import { HARNESS_HEALTH_FEATURE } from '@goondocks/myco-shared/harness-health';
import { run as update } from '@myco/cli/update.js';
import { setupChecks } from '@myco/cli/member-doctor.js';
import { memberRig } from '../member/helpers/server.js';
import { readAttention } from '@myco-server-worker/core/attention.js';

const SERVER = 'https://myco.example';
let home: string;
let agentHome: string;
const saved = { HOME: process.env.HOME, MYCO_HOME: process.env.MYCO_HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, PATH: process.env.PATH };
const hooks = () => path.join(agentHome, '.codex', 'hooks.json');
const config = () => path.join(agentHome, '.codex', 'config.toml');
beforeEach(() => {
  agentHome = fs.mkdtempSync(path.join(process.env.ROUTR_TEST_HOME_BASE ?? os.tmpdir(), 'myco-keep-current-'));
  home = path.join(agentHome, 'myco');
  process.env.HOME = agentHome;
  process.env.MYCO_HOME = home;
  process.env.CODEX_HOME = path.join(agentHome, '.codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(agentHome, '.claude');
  const bin = path.join(agentHome, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const binary of ['codex', 'claude']) fs.writeFileSync(path.join(bin, binary), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
  writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(agentHome, { recursive: true, force: true });
});

it('records every harness at the shared provisioning operation, including unchanged installs', () => {
  recordProvision(home, { version: 'old', serverUrl: SERVER, agents: [] });
  for (const agent of ['codex', 'claude-code']) provisionGlobally(agent, null, home, { serverUrl: SERVER });
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code', 'codex']);
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code', 'codex']);
});

it('the next CLI helper pass restores deleted hooks and MCP byte for byte and preserves unrelated config', async () => {
  fs.mkdirSync(path.dirname(config()), { recursive: true });
  fs.writeFileSync(config(), 'model = "personal-model"\n\n[features]\nhooks = true\n\n[mcp_servers.other]\ncommand = "other"\n');
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const originalHooks = fs.readFileSync(hooks(), 'utf8');
  const originalConfig = fs.readFileSync(config(), 'utf8');
  fs.unlinkSync(hooks());
  fs.writeFileSync(config(), originalConfig.slice(0, originalConfig.indexOf('[mcp_servers.myco]')));
  await runHelperVerb(['--project', 'proj_test', '--home', home, '--stderr'], { pass: async () => {}, lingerMs: 0 });
  expect(fs.readFileSync(hooks(), 'utf8')).toBe(originalHooks);
  expect(fs.readFileSync(config(), 'utf8')).toBe(originalConfig);
  expect(parseToml(originalConfig)).toMatchObject({ model: 'personal-model', mcp_servers: { other: { command: 'other' } } });
});

it('backfills an empty record from surviving owned MCP registration and repairs hooks on update', async () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const original = fs.readFileSync(hooks(), 'utf8');
  recordProvision(home, { version: 'old', serverUrl: SERVER, agents: [] }, { replace: true });
  fs.unlinkSync(hooks());
  await update([]);
  expect(readProvisionRecord(home)?.agents).toEqual(['codex']);
  expect(fs.readFileSync(hooks(), 'utf8')).toBe(original);
});

it('update runs the same repair and leaves a healthy setup byte for byte unchanged', async () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const original = fs.readFileSync(hooks(), 'utf8');
  const healthyRecord = fs.readFileSync(path.join(home, 'member', 'provisioned.json'), 'utf8');
  const healthyMtime = fs.statSync(hooks()).mtimeMs;
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].state).toBe('ready');
  expect(fs.statSync(hooks()).mtimeMs).toBe(healthyMtime);
  expect(fs.readFileSync(path.join(home, 'member', 'provisioned.json'), 'utf8')).toBe(healthyRecord);
  fs.unlinkSync(hooks());
  await update([]);
  expect(fs.readFileSync(hooks(), 'utf8')).toBe(original);
  const record = fs.readFileSync(path.join(home, 'member', 'provisioned.json'), 'utf8');
  const modified = fs.statSync(hooks()).mtimeMs;
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses).toEqual([{ id: 'codex', provisioned: true, state: 'trust_required', hookRepairAt: expect.any(Number), action: "Restart Codex and trust Myco's hooks" }]);
  expect(fs.statSync(hooks()).mtimeMs).toBe(modified);
  expect(fs.readFileSync(path.join(home, 'member', 'provisioned.json'), 'utf8')).toBe(record);
});

it.skipIf(process.platform === 'win32')('reports a removed binary, an unwritable config and renewed hook trust, keeping every harness recorded', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  expect(keepCurrent(home, { binaryFound: () => false })?.harnesses[0].state).toBe('ready');
  fs.unlinkSync(hooks());
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0]).toMatchObject({ state: 'trust_required', action: "Restart Codex and trust Myco's hooks" });
  fs.unlinkSync(config());
  fs.chmodSync(path.dirname(config()), 0o500);
  try {
    expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0]).toMatchObject({ state: 'unwritable', action: "Allow Myco to write Codex's configuration" });
    expect(readProvisionRecord(home)?.agents).toEqual(['codex']);
  } finally { fs.chmodSync(path.dirname(config()), 0o700); }
});

it('never overwrites unreadable user config and retries a failed repair without forgetting the harness', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  fs.writeFileSync(config(), 'invalid TOML [');
  expect(keepCurrent(home)?.harnesses[0].state).toBe('repair_failed');
  expect(fs.readFileSync(config(), 'utf8')).toBe('invalid TOML [');
  expect(readProvisionRecord(home)?.agents).toEqual(['codex']);
});

it('repairs stale hooks and MCP from the recorded binary when the current runtime pin moves', () => {
  const oldBinary = path.join(home, 'bin', 'myco-old');
  const newBinary = path.join(home, 'bin', 'myco-new');
  fs.mkdirSync(path.dirname(oldBinary), { recursive: true });
  for (const binary of [oldBinary, newBinary]) fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'runtime.command'), `${oldBinary}\n`);
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  fs.writeFileSync(path.join(home, 'runtime.command'), `${newBinary}\n`);
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].state).toBe('trust_required');
  expect(fs.readFileSync(hooks(), 'utf8')).toContain(newBinary);
  expect(fs.readFileSync(hooks(), 'utf8')).not.toContain(oldBinary);
  expect(fs.readFileSync(config(), 'utf8')).toContain(newBinary);
  expect(readProvisionRecord(home)?.binaries?.codex).toBe(newBinary);
});

it('doctor names missing hooks or MCP without writing any configuration', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  expect(setupChecks(home)[0].status).toBe('ok');
  fs.unlinkSync(hooks());
  expect(setupChecks(home)[0]).toMatchObject({ status: 'warn', detail: expect.stringContaining('hooks or MCP entry are missing or stale') });
  expect(fs.existsSync(hooks())).toBe(false);
  keepCurrent(home, { binaryFound: () => true });
  fs.writeFileSync(config(), '[features]\nhooks = true\n');
  expect(setupChecks(home)[0].status).toBe('warn');
  expect(fs.readFileSync(config(), 'utf8')).not.toContain('[mcp_servers.myco]');
});

it('reports repair status only after the Deployment advertises the feature', async () => {
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_test', root: agentHome, serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 };
  writeRegistryEntry(entry, { mycoHome: home });
  const report = { serverUrl: SERVER, ready: [], harnesses: [{ id: 'codex', provisioned: true as const, state: 'binary_missing' as const, action: 'Install Codex again' }] };
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json({ persisted: true }, { headers: { [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL) } });
  };
  await reportHarnesses(report, home, Date.now() + 10_000, { entry, fetch });
  expect(requests).toHaveLength(0);
  updateProjectContext(spoolDirFor(entry.projectId, home), home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  await reportHarnesses(report, home, Date.now() + 10_000, { entry, fetch });
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!.url).pathname).toBe('/members/harnesses/report');
  expect(await requests[0]!.json()).toEqual({ harnesses: report.harnesses });
});

it('reports from the newest project advertisement and logs a missing feature once per state change', async () => {
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_old', root: agentHome, serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 };
  writeRegistryEntry(entry, { mycoHome: home });
  writeRegistryEntry({ ...entry, projectId: 'proj_new', root: path.join(agentHome, 'other') }, { mycoHome: home });
  updateProjectContext(spoolDirFor(entry.projectId, home), home, (cache) => { cache.features = ['turn']; cache.featuresAt = 1; });
  const newest = spoolDirFor('proj_new', home);
  updateProjectContext(newest, home, (cache) => { cache.features = ['turn', HARNESS_HEALTH_FEATURE]; cache.featuresAt = 2; });
  const report = { serverUrl: SERVER, ready: [], harnesses: [] };
  let sent = 0;
  const fetch = async () => { sent++; return Response.json({ persisted: true }, { headers: { [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL) } }); };
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const pass = () => reportHarnesses(report, home, Date.now() + 10_000, { entry, fetch });
  try {
    await pass();
    expect(sent).toBe(1);
    expect(stderr).not.toHaveBeenCalled();
    updateProjectContext(newest, home, (cache) => { cache.features = ['turn']; cache.featuresAt = 3; });
    await pass(); await pass();
    expect(sent).toBe(1);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('harness-health-v1 not advertised');
    updateProjectContext(newest, home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; cache.featuresAt = 4; });
    await pass();
    updateProjectContext(newest, home, (cache) => { cache.features = []; cache.featuresAt = 5; });
    await pass(); await pass();
    expect(stderr).toHaveBeenCalledTimes(2);
  } finally { stderr.mockRestore(); }
});

it('an unrepairable helper pass reaches Deployment Health through the real report route', async () => {
  const rig = await memberRig();
  rig.env.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('machine_1', 'mem_machine_1', ?)`, [Date.now()]);
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_1', root: agentHome, serverUrl: SERVER, token: rig.token, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 };
  writeRegistryEntry(entry, { mycoHome: home });
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  fs.writeFileSync(config(), 'invalid TOML [');
  updateProjectContext(spoolDirFor(entry.projectId, home), home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  await runHelperVerb(['--project', entry.projectId, '--home', home, '--stderr'], { fetch: rig.fetch, lingerMs: 0 });
  expect((await readAttention(rig.env.serverEnv, Date.now())).items).toContainEqual(expect.objectContaining({
    kind: 'harness_needs_repair', machineId: 'machine_1', harness: 'codex', state: 'repair_failed', action: 'Run myco member provision codex to see what needs fixing',
  }));
  expect(fs.readFileSync(config(), 'utf8')).toBe('invalid TOML [');
});

it('retains a trust action through offline reporting, then clears the local hold only on accepted delivery', async () => {
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_1', root: agentHome, serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 };
  writeRegistryEntry(entry, { mycoHome: home });
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  fs.unlinkSync(hooks());
  const repaired = keepCurrent(home, { binaryFound: () => true });
  expect(repaired?.harnesses[0].state).toBe('trust_required');
  updateProjectContext(spoolDirFor(entry.projectId, home), home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  await reportHarnesses(repaired, home, Date.now() + 10_000, { entry, fetch: async () => { throw new Error('offline'); } });
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].state).toBe('trust_required');
  updateProjectContext(spoolDirFor(entry.projectId, home), home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  await reportHarnesses(repaired, home, Date.now() + 10_000, { entry, fetch: async () => Response.json({ persisted: true }, { headers: { [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL) } }) });
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].state).toBe('ready');
});

function harnessFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (file === home || item.isSymbolicLink()) continue;
      if (item.isDirectory()) walk(file); else if (item.isFile()) files.push(file);
    }
  };
  walk(agentHome);
  return files;
}

it('healthy passes preserve bytes inode and mtime of every harness file across all nine manifests', () => {
  expect(loadManifests()).toHaveLength(9);
  for (const manifest of loadManifests()) {
    const reg = manifest.registration;
    const targets = [reg?.globalHooksTarget, reg?.globalSettingsTarget, ...(Array.isArray(reg?.globalMcpTarget) ? reg.globalMcpTarget : [reg?.globalMcpTarget])];
    for (const target of targets) {
      if (target === undefined || !/\.(json|toml)$/.test(target)) continue;
      const file = expandHome(target);
      if (fs.existsSync(file)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, file.endsWith('.toml') ? 'personal = true\n' : JSON.stringify({ personal: true }));
    }
    expect(provisionGlobally(manifest.name, null, home, { serverUrl: SERVER }).kind).not.toBe('refused');
  }
  expect(readProvisionRecord(home)?.agents).toEqual(loadManifests().filter((manifest) => manifest.registration?.memberHooksTarget).map((manifest) => manifest.name).sort());
  const claude = path.join(agentHome, '.claude.json');
  fs.writeFileSync(claude, JSON.stringify(JSON.parse(fs.readFileSync(claude, 'utf8'))));
  const snapshots = harnessFiles().map((file) => ({ file, bytes: fs.readFileSync(file), stat: fs.statSync(file) }));
  const install = spyOn(SymbiontInstaller.prototype, 'install');
  try {
    keepCurrent(home, { binaryFound: () => true });
    keepCurrent(home, { binaryFound: () => true });
    expect(install).not.toHaveBeenCalled();
  } finally { install.mockRestore(); }
  for (const { file, bytes, stat } of snapshots) {
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fs.statSync(file).ino).toBe(stat.ino);
    expect(fs.statSync(file).mtimeMs).toBe(stat.mtimeMs);
  }
});

it('manual installer preserves parsed JSON and TOML even when formatting differs', () => {
  for (const agent of ['codex', 'claude-code']) provisionGlobally(agent, null, home, { serverUrl: SERVER });
  const claude = path.join(agentHome, '.claude.json');
  fs.writeFileSync(claude, JSON.stringify(JSON.parse(fs.readFileSync(claude, 'utf8'))));
  const files = [config(), claude];
  const before = files.map((file) => ({ bytes: fs.readFileSync(file), stat: fs.statSync(file) }));
  for (const agent of ['codex', 'claude-code']) provisionGlobally(agent, null, home, { serverUrl: SERVER });
  files.forEach((file, i) => {
    expect(fs.readFileSync(file)).toEqual(before[i]!.bytes);
    expect(fs.statSync(file).ino).toBe(before[i]!.stat.ino);
    expect(fs.statSync(file).mtimeMs).toBe(before[i]!.stat.mtimeMs);
  });
});

it('a healthy pass cannot overwrite a concurrent harness trust approval', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const originalRename = fs.renameSync;
  const write = spyOn(fs, 'renameSync');
  write.mockImplementation((oldPath, newPath) => {
    if (String(newPath) === config()) fs.appendFileSync(config(), '\n[projects.personal]\ntrust_level = "trusted"\n');
    return originalRename(oldPath, newPath);
  });
  try {
    fs.appendFileSync(config(), '\n[projects.personal]\ntrust_level = "trusted"\n');
    const before = fs.readFileSync(config());
    keepCurrent(home, { binaryFound: () => true });
    expect(fs.readFileSync(config())).toEqual(before);
    expect(write.mock.calls.some(([, file]) => String(file) === config())).toBe(false);
  } finally { write.mockRestore(); }
});

it('hook currency ignores group order and preserves another tools index after Myco', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const data = JSON.parse(fs.readFileSync(hooks(), 'utf8'));
  const event = Object.keys(data.hooks)[0]!;
  data.hooks[event].push({ hooks: [{ type: 'command', command: 'other-tool' }] });
  fs.writeFileSync(hooks(), JSON.stringify(data));
  const before = fs.statSync(hooks());
  keepCurrent(home, { binaryFound: () => true });
  expect(fs.readFileSync(hooks(), 'utf8')).toBe(JSON.stringify(data));
  expect(fs.statSync(hooks()).ino).toBe(before.ino);
  const installer = new SymbiontInstaller(loadManifests().find((m) => m.name === 'codex')!, home, path.resolve('packages/myco'), false, undefined, null, 'member-global', home).withoutProjectRoot().forDeployment(SERVER);
  installer.installMemberHooks();
  expect(JSON.parse(fs.readFileSync(hooks(), 'utf8')).hooks[event]).toEqual(data.hooks[event]);
});

it('settings drift is repaired through the same installer', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  fs.writeFileSync(config(), fs.readFileSync(config(), 'utf8').replace('hooks = true', 'hooks = false'));
  keepCurrent(home, { binaryFound: () => true });
  expect(parseToml(fs.readFileSync(config(), 'utf8')).features).toMatchObject({ hooks: true });
});

it('reports only mtimes from harness activity files and never their contents', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const root = path.join(agentHome, '.codex', 'sessions');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, 'private session content');
  fs.utimesSync(file, 1700000000, 1700000000);
  const read = spyOn(fs, 'readFileSync');
  try {
    expect(harnessRanAt(loadManifests().find((m) => m.name === 'codex')!)).toBe(1700000000000);
    expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].ranAt).toBe(1700000000000);
    expect(read.mock.calls.some(([target]) => String(target) === file)).toBe(false);
  } finally { read.mockRestore(); }
});

it('GUI install evidence works without a CLI and never hides pending trust', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  expect(keepCurrent(home, { binaryFound: () => false })?.harnesses[0].state).toBe('ready');
  fs.unlinkSync(hooks());
  expect(keepCurrent(home, { binaryFound: () => false })?.harnesses[0].state).toBe('trust_required');
});

it('identical accepted reports are skipped while changed activity is delivered', async () => {
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_1', root: agentHome, serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 };
  writeRegistryEntry(entry, { mycoHome: home });
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  updateProjectContext(spoolDirFor(entry.projectId, home), home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  let calls = 0;
  const fetch = async () => { calls++; return Response.json({ persisted: true }, { headers: { [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL) } }); };
  const result = keepCurrent(home, { binaryFound: () => true });
  await reportHarnesses(result, home, Date.now() + 10_000, { entry, fetch });
  await reportHarnesses(result, home, Date.now() + 10_000, { entry, fetch });
  expect(calls).toBe(1);
  result!.harnesses[0]!.ranAt = Date.now();
  await reportHarnesses(result, home, Date.now() + 10_000, { entry, fetch });
  expect(calls).toBe(2);
});

it('remove opts out through the installer and keeps unrelated settings across helper and update', async () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  fs.appendFileSync(config(), '\n[projects.personal]\ntrust_level = "trusted"\n');
  expect(runProvision(['--remove', 'codex'], { mycoHome: home, cwd: agentHome, stdout: () => {} })).toBe(true);
  expect(readProvisionRecord(home)?.agents).toEqual([]);
  keepCurrent(home, { binaryFound: () => true });
  await update([]);
  expect(fs.existsSync(hooks())).toBe(false);
  expect(parseToml(fs.readFileSync(config(), 'utf8')).mcp_servers).toBeUndefined();
  expect(parseToml(fs.readFileSync(config(), 'utf8')).projects).toMatchObject({ personal: { trust_level: 'trusted' } });
});

it('automatic repair keeps bounded backups of changed original config', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const stale = fs.readFileSync(config(), 'utf8').replace('hooks = true', 'hooks = false');
  fs.writeFileSync(config(), stale);
  keepCurrent(home, { binaryFound: () => true });
  const root = path.join(home, 'backups');
  const folders = fs.readdirSync(root).filter((name) => name.startsWith('member-provision-'));
  expect(folders).toHaveLength(1);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, folders[0]!, 'manifest.json'), 'utf8'));
  const copy = manifest.entries.find((entry: { original: string }) => entry.original === config());
  expect(fs.readFileSync(copy.backup, 'utf8')).toBe(stale);
  for (let i = 0; i < 12; i++) {
    const dir = path.join(root, `member-provision-2000-${i}`);
    fs.mkdirSync(dir, { recursive: true });
  }
  provisionBackup(home);
  expect(fs.readdirSync(root).filter((name) => name.startsWith('member-provision-')).length).toBeLessThanOrEqual(9);
});

it('keep-current failure never interrupts the helper capture delivery', async () => {
  let delivered = false;
  await runHelperVerb(['--project', 'proj_test', '--home', home, '--stderr'], {
    keepCurrent: () => { throw new Error('repair unavailable'); },
    pass: async () => { delivered = true; }, lingerMs: 0,
  });
  expect(delivered).toBe(true);
});

it('nonready state logs once across passes even when the Deployment cannot accept health reports', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  fs.unlinkSync(hooks());
  const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    keepCurrent(home, { binaryFound: () => true });
    keepCurrent(home, { binaryFound: () => true });
    expect(write.mock.calls.filter(([line]) => String(line).includes("Restart Codex and trust"))).toHaveLength(1);
  } finally { write.mockRestore(); }
});

it('changing Deployment URL preserves every provisioned harness and its binary', () => {
  recordProvision(home, { version: 'one', serverUrl: SERVER, agents: ['codex'], binaries: { codex: '/old/myco' } });
  recordProvision(home, { version: 'two', serverUrl: 'https://second.example', agents: ['claude-code'], binaries: { 'claude-code': '/new/myco' } });
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code', 'codex']);
  expect(readProvisionRecord(home)?.binaries).toEqual({ codex: '/old/myco', 'claude-code': '/new/myco' });
});

it('a provisioned harness with neither binary nor install evidence is reported missing without recreating it', () => {
  provisionGlobally('claude-code', null, home, { serverUrl: SERVER });
  fs.rmSync(path.join(agentHome, '.claude'), { recursive: true });
  fs.rmSync(path.join(agentHome, '.claude.json'));
  const exists = fs.existsSync;
  const check = spyOn(fs, 'existsSync').mockImplementation((file) => String(file).startsWith('/Applications/') ? false : exists(file));
  try {
    expect(keepCurrent(home, { binaryFound: () => false })?.harnesses[0].state).toBe('binary_missing');
    expect(fs.existsSync(path.join(agentHome, '.claude'))).toBe(false);
  } finally { check.mockRestore(); }
});

it('shared matcher groups preserve foreign commands on healthy passes and drift repair', () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const data = JSON.parse(fs.readFileSync(hooks(), 'utf8'));
  const event = Object.keys(data.hooks)[0]!;
  data.hooks[event][0].hooks.push({ type: 'command', command: 'other-tool' });
  fs.writeFileSync(hooks(), JSON.stringify(data));
  const before = fs.readFileSync(hooks());
  keepCurrent(home, { binaryFound: () => true });
  expect(fs.readFileSync(hooks())).toEqual(before);
  data.hooks[event][0].hooks[0].command += ' --stale';
  fs.writeFileSync(hooks(), JSON.stringify(data));
  keepCurrent(home, { binaryFound: () => true });
  const repaired = JSON.parse(fs.readFileSync(hooks(), 'utf8'));
  expect(repaired.hooks[event][0].hooks).toContainEqual({ type: 'command', command: 'other-tool' });
});

it('reordered Myco groups are current without entering the installer', () => {
  const render = SymbiontInstaller.prototype.renderMemberHooks;
  const template = spyOn(SymbiontInstaller.prototype, 'renderMemberHooks').mockImplementation(function (source) {
    const block = render.call(this, source);
    if (block === null) return block;
    const event = Object.keys(block)[0]!;
    const group = (block[event] as Record<string, unknown>[])[0]!;
    return { ...block, [event]: [group, { ...group, matcher: 'extra-matcher' }] };
  });
  try {
    provisionGlobally('codex', null, home, { serverUrl: SERVER });
    const data = JSON.parse(fs.readFileSync(hooks(), 'utf8'));
    const event = Object.keys(data.hooks)[0]!;
    data.hooks[event].reverse();
    fs.writeFileSync(hooks(), JSON.stringify(data));
    const install = spyOn(SymbiontInstaller.prototype, 'install');
    try {
      keepCurrent(home, { binaryFound: () => true });
      expect(install).not.toHaveBeenCalled();
      expect(fs.readFileSync(hooks(), 'utf8')).toBe(JSON.stringify(data));
    } finally { install.mockRestore(); }
  } finally { template.mockRestore(); }
});

it('a second hook repair changes the report even when its state action and activity time match', async () => {
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_1', root: agentHome, serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 };
  writeRegistryEntry(entry, { mycoHome: home });
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  updateProjectContext(spoolDirFor(entry.projectId, home), home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  holdHookTrust(home, 'codex', "Restart Codex and trust Myco's hooks");
  const reports: unknown[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    reports.push(JSON.parse(String(init?.body)));
    return Response.json({ persisted: true }, { headers: { [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL) } });
  };
  await reportHarnesses(keepCurrent(home, { binaryFound: () => true }), home, Date.now() + 10_000, { entry, fetch });
  holdHookTrust(home, 'codex', "Restart Codex and trust Myco's hooks");
  await reportHarnesses(keepCurrent(home, { binaryFound: () => true }), home, Date.now() + 10_000, { entry, fetch });
  expect(reports).toHaveLength(2);
  expect(reports[0]).not.toEqual(reports[1]);
});
