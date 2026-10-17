import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { loadManifests } from '@myco/symbionts/detect.js';
import { expandHome } from '@myco/paths/home.js';
import { MemberProvisionConflictError, MemberMcpConflictError, MemberPluginConflictError, SymbiontInstaller } from '@myco/symbionts/installer.js';
import { provisionGlobally, runProvision, provisionBackup } from '@myco/cli/member.js';
import { runHelperVerb } from '@myco/cli/member-helper.js';
import { keepCurrent, reportHarnesses, harnessRanAt } from '@myco/cli/member-keep-current.js';
import { readProvisionRecord, recordProvision, holdHookTrust } from '@myco/symbionts/member-provision-record.js';
import { writeDeploymentMembership, writeRegistryEntry, deploymentPath, REGISTRY_VERSION } from '@myco/member/registry.js';
import { updateProjectContext } from '@myco/member/context-cache.js';
import { MemberSpool } from '@myco/member/spool.js';
import { PROTOCOL_HEADER, MEMBER_PROTOCOL } from '@goondocks/myco-shared/member-protocol';
import { HARNESS_HEALTH_FEATURE, HARNESS_HELD_ELSEWHERE_FEATURE } from '@goondocks/myco-shared/harness-health';
import { run as update } from '@myco/cli/update.js';
import { setupChecks } from '@myco/cli/member-doctor.js';
import { memberRig } from '../member/helpers/server.js';
import { run as setup } from '@myco/cli/setup.js';
import { getPluginVersion } from '@myco/version.js';
import { parseProvisionedHarnessReport } from '@myco-server-worker/core/harness-health.js';
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
  try {
    for (const check of setupChecks(home)) {
      expect(check.detail.toLowerCase()).not.toMatch(/run `?myco doctor/);
      expect(check.detail).not.toContain('..');
      if (check.detail.includes('could not read')) expect(check.detail).toMatch(/Fix the file, then run `myco member provision (?:claude-code|codex)`/);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(agentHome, { recursive: true, force: true });
  }
});

it('repairs capture beside an unrelated stale Claude project entry', () => {
  provisionGlobally('claude-code', null, home, { serverUrl: SERVER });
  const file = path.join(agentHome, '.claude.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const folder = '/Users/x/my.app';
  const entry = { command: path.join(agentHome, 'deleted-install', 'bin', 'myco') };
  data.projects = { [folder]: { mcpServers: { myco: entry } } };
  fs.writeFileSync(file, JSON.stringify(data));
  fs.writeFileSync(path.join(agentHome, '.claude', 'settings.json'), '{}');
  const result = keepCurrent(home, { binaryFound: () => true });
  expect(result?.harnesses[0].state).toBe('ready');
  expect(result?.harnesses[0].toolsDeployment).toBeUndefined();
  expect(fs.readFileSync(path.join(agentHome, '.claude', 'settings.json'), 'utf8')).toContain('--credential registry');
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).projects[folder].mcpServers.myco).toEqual(entry);
});

it('records every harness at the shared provisioning operation, including unchanged installs', () => {
  recordProvision(home, { version: 'old', serverUrl: SERVER, agents: [] });
  for (const agent of ['codex', 'claude-code']) provisionGlobally(agent, null, home, { serverUrl: SERVER });
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code', 'codex']);
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  expect(readProvisionRecord(home)?.agents).toEqual(['claude-code', 'codex']);
});

it.each([MemberProvisionConflictError, MemberMcpConflictError, MemberPluginConflictError])('doctor chooses its remedy independently of reworded installer advice (%p)', (Conflict) => {
  recordProvision(home, { version: getPluginVersion(), serverUrl: SERVER, agents: ['codex'] });
  const problem = 'the global capture file cannot be read.';
  const remedy = 'Troubleshooting next: please run myco doctor --verbose before continuing.';
  const error = new Conflict(problem, remedy);
  const inspect = spyOn(SymbiontInstaller.prototype, 'memberToolsDeployment').mockImplementation(() => { throw error; });
  try {
    expect(error.problem).toBe(problem);
    expect(error.remedy).toBe(remedy);
    expect(error.message).toContain(remedy);
    const checks = setupChecks(home);
    expect(checks).toContainEqual(expect.objectContaining({ detail: "Codex's configuration could not be checked: the global capture file cannot be read. Review this configuration before changing global hooks or tools." }));
    for (const check of checks) {
      expect(check.detail).not.toMatch(/run `?myco doctor/i);
      expect(check.detail).not.toContain('..');
    }
    const result = keepCurrent(home, { binaryFound: () => true });
    expect(result?.localActions?.codex).toBe("the global capture file cannot be read. Run myco doctor to check Codex's capture configuration.");
    expect(result?.harnesses[0].state).toBe('repair_failed');
  } finally { inspect.mockRestore(); }
});

it('the next CLI helper pass restores deleted hooks and MCP byte for byte and preserves unrelated config', async () => {
  fs.mkdirSync(path.dirname(config()), { recursive: true });
  fs.writeFileSync(config(), 'model = "personal-model"\n\n[features]\nhooks = true\n\n[mcp_servers.other]\ncommand = "other"\n');
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const originalHooks = fs.readFileSync(hooks(), 'utf8');
  const originalConfig = fs.readFileSync(config(), 'utf8');
  fs.unlinkSync(hooks());
  fs.writeFileSync(config(), originalConfig.slice(0, originalConfig.indexOf('[mcp_servers.myco]')));
  await runHelperVerb(['--project', 'proj_test', '--server', SERVER, '--home', home, '--stderr'], { pass: async () => {}, lingerMs: 0 });
  expect(fs.readFileSync(hooks(), 'utf8')).toBe(originalHooks);
  expect(fs.readFileSync(config(), 'utf8')).toBe(originalConfig);
  expect(parseToml(originalConfig)).toMatchObject({ model: 'personal-model', mcp_servers: { other: { command: 'other' } } });
});

it('backfills an empty record from surviving owned MCP registration and repairs hooks on update', async () => {
  provisionGlobally('codex', null, home, { serverUrl: SERVER });
  const original = fs.readFileSync(hooks(), 'utf8');
  recordProvision(home, { version: 'old', serverUrl: SERVER, agents: [] }, { replace: true });
  fs.unlinkSync(hooks());
  await update([], { resolveRefs: async () => null, refreshMember: async () => { if (!runProvision(['--refresh'], { mycoHome: home, cwd: agentHome })) throw new Error('refresh failed'); } });
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
  await update([], { resolveRefs: async () => null, refreshMember: async () => { if (!runProvision(['--refresh'], { mycoHome: home, cwd: agentHome })) throw new Error('refresh failed'); } });
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
  const result = keepCurrent(home);
  expect(result?.harnesses[0]).toMatchObject({ state: 'repair_failed', action: 'Fix the file, then run `myco member provision codex`.' });
  expect(result?.localActions?.codex).toContain('Fix the file, then run `myco member provision codex`.');
  expect(setupChecks(home).map(check => check.detail).join('\n')).toContain('Fix the file, then run `myco member provision codex`.');
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
  expect(setupChecks(home)[0]).toMatchObject({ status: 'warn', detail: expect.stringContaining('capture configuration is missing or stale') });
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
  updateProjectContext(new MemberSpool(entry, { mycoHome: home }).dir, home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  await reportHarnesses(report, home, Date.now() + 10_000, { entry, fetch });
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!.url).pathname).toBe('/members/harnesses/report');
  expect(await requests[0]!.json()).toEqual({ harnesses: report.harnesses });
});

it('reports from the newest project advertisement and logs a missing feature once per state change', async () => {
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_old', root: agentHome, serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 };
  writeRegistryEntry(entry, { mycoHome: home });
  writeRegistryEntry({ ...entry, projectId: 'proj_new', root: path.join(agentHome, 'other') }, { mycoHome: home });
  updateProjectContext(new MemberSpool(entry, { mycoHome: home }).dir, home, (cache) => { cache.features = ['turn']; cache.featuresAt = 1; });
  const newest = new MemberSpool({ projectId: 'proj_new', serverUrl: SERVER }, { mycoHome: home }).dir;
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
  updateProjectContext(new MemberSpool(entry, { mycoHome: home }).dir, home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  await runHelperVerb(['--project', entry.projectId, '--server', SERVER, '--home', home, '--stderr'], { fetch: rig.fetch, lingerMs: 0 });
  expect((await readAttention(rig.env.serverEnv, Date.now())).items).toContainEqual(expect.objectContaining({
    kind: 'harness_needs_repair', machineId: 'machine_1', harness: 'codex', state: 'repair_failed', action: 'Fix the file, then run `myco member provision codex`.',
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
  updateProjectContext(new MemberSpool(entry, { mycoHome: home }).dir, home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  await reportHarnesses(repaired, home, Date.now() + 10_000, { entry, fetch: async () => { throw new Error('offline'); } });
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].state).toBe('trust_required');
  updateProjectContext(new MemberSpool(entry, { mycoHome: home }).dir, home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
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
  const installer = new SymbiontInstaller(loadManifests().find((m) => m.name === 'codex')!, home, path.resolve('packages/myco'), false, home).withoutProjectRoot().forDeployment(SERVER);
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
  const root = path.join(agentHome, '.codex', 'sessions', '2026', '10', '04');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'rollout-2026-10-04-11111111-1111-1111-1111-111111111111.jsonl');
  fs.writeFileSync(file, 'private session content');
  const at = Math.trunc(Date.now() / 1000) * 1000;
  fs.utimesSync(file, at / 1000, at / 1000);
  const read = spyOn(fs, 'readFileSync');
  try {
    expect(harnessRanAt(loadManifests().find((m) => m.name === 'codex')!)).toBe(at);
    expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].ranAt).toBe(at);
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
  updateProjectContext(new MemberSpool(entry, { mycoHome: home }).dir, home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
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
  await update([], { resolveRefs: async () => null, refreshMember: async () => { if (!runProvision(['--refresh'], { mycoHome: home, cwd: agentHome })) throw new Error('refresh failed'); } });
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
  await runHelperVerb(['--project', 'proj_test', '--server', SERVER, '--home', home, '--stderr'], {
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
  updateProjectContext(new MemberSpool(entry, { mycoHome: home }).dir, home, (cache) => { cache.features = [HARNESS_HEALTH_FEATURE]; });
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

const OTHER_SERVER = 'https://other.myco.example';

function toolsHeldElsewhere(agent = 'claude-code'): string {
  writeDeploymentMembership({ serverUrl: OTHER_SERVER, token: 'B'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  provisionGlobally(agent, null, home, { serverUrl: OTHER_SERVER });
  recordProvision(home, { version: 'old', serverUrl: SERVER, agents: [agent] }, { replace: true });
  return agent === 'claude-code' ? path.join(agentHome, '.claude.json') : config();
}

for (const agent of ['claude-code', 'codex']) it(`keeps ${agent}'s tools held by another member Deployment settled while refreshing an older setup version`, async () => {
  const target = toolsHeldElsewhere(agent);
  const priorChecks = setupChecks(home);
  expect(priorChecks.some(check => check.detail.includes('use other.myco.example'))).toBe(true);
  expect(priorChecks.some(check => check.status === 'warn' && check.detail.includes('this is'))).toBe(true);
  expect(priorChecks.map(check => check.detail).join(' ')).not.toContain('member provision');
  const initialStatus: string[] = [];
  await setup(['--status'], { mycoHome: home, cwd: agentHome, agents: () => [agent], stdout: line => initialStatus.push(line), stderr: line => { throw new Error(line); } });
  expect(initialStatus.join('\n')).toContain('use other.myco.example');
  expect(initialStatus.join('\n')).not.toContain('member provision');
  expect(readProvisionRecord(home)?.version).toBe('old');
  const before = harnessFiles().map(file => [file, fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs]);
  const install = spyOn(SymbiontInstaller.prototype, 'install');
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const first = keepCurrent(home, { binaryFound: () => true });
    expect(first?.harnesses).toEqual([{ id: agent, provisioned: true, state: 'held_elsewhere', toolsDeployment: OTHER_SERVER }]);
    expect(first?.harnesses[0].action).toBeUndefined();
    expect(readProvisionRecord(home)?.version).toBe(getPluginVersion());
    expect(readProvisionRecord(home)?.agents).toEqual([agent]);
    const stateFile = path.join(home, 'member', 'harness-states.json');
    const stateTime = fs.statSync(stateFile).mtimeMs;
    expect(keepCurrent(home, { binaryFound: () => true })).toEqual(first);
    expect(fs.statSync(stateFile).mtimeMs).toBe(stateTime);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('use other.myco.example');
    expect(String(stderr.mock.calls[0]?.[0])).not.toContain('member provision');
    expect(install).toHaveBeenCalledTimes(1);
    expect(harnessFiles().map(file => [file, fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs])).toEqual(before);
    const checks = setupChecks(home);
    expect(checks.every(check => check.status === 'ok')).toBe(true);
    expect(checks[0].detail).toContain('use other.myco.example');
    expect(checks.map(check => check.detail).join(' ')).not.toContain('member provision');
    const lines: string[] = [];
    await setup(['--status'], { mycoHome: home, cwd: agentHome, agents: () => [agent], stdout: line => lines.push(line), stderr: line => { throw new Error(line); }, fetch: async () => { throw new Error('no network in status'); } });
    expect(lines.join('\n')).toContain(checks[0].detail);
    expect(lines.filter(line => line.includes('Agent hooks:')).join('\n')).not.toContain('member provision');
    expect(fs.readFileSync(target, 'utf8')).toContain(OTHER_SERVER);
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replaceAll(OTHER_SERVER, SERVER));
    expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].state).toBe('ready');
    expect(install).toHaveBeenCalledTimes(1);
  } finally { install.mockRestore(); stderr.mockRestore(); }
});

for (const kind of ['foreign', 'legacy', 'same-deployment', 'mismatched-helper']) it(`keeps ${kind} MCP conflicts classified as repair failures`, () => {
  const target = toolsHeldElsewhere();
  const file = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (kind === 'foreign') file.mcpServers.myco.headersHelper = file.mcpServers.myco.headersHelper.replace(/.* member mcp-headers/, '/opt/other-myco member mcp-headers');
  if (kind === 'legacy') file.mcpServers.myco = { command: '/opt/myco-1.4', args: ['mcp'] };
  if (kind === 'same-deployment') {
    file.mcpServers.myco.url = SERVER + '/mcp';
    file.mcpServers.myco.headersHelper = file.mcpServers.myco.headersHelper.replace(OTHER_SERVER, SERVER).replace('--credential registry', '--credential env');
  }
  if (kind === 'mismatched-helper') file.mcpServers.myco.headersHelper = file.mcpServers.myco.headersHelper.replace(OTHER_SERVER, SERVER);
  fs.writeFileSync(target, JSON.stringify(file));
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0]).toMatchObject({ state: 'repair_failed', action: expect.stringContaining('myco doctor') });
});

it('omits held tools for the older feature set, clears prior repair attention, and reports them after upgrade', async () => {
  const rig = await memberRig();
  rig.env.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('machine_1', 'mem_machine_1', ?)`, [Date.now()]);
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_1', root: agentHome, serverUrl: SERVER, token: rig.token, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 };
  writeRegistryEntry(entry, { mycoHome: home });
  toolsHeldElsewhere();
  const result = keepCurrent(home, { binaryFound: () => true })!;
  const spool = new MemberSpool(entry, { mycoHome: home }).dir;
  updateProjectContext(spool, home, cache => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  const bodies: Array<{ harnesses: Array<{ state: string }> }> = [];
  const accepted: boolean[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.clone().json() as { harnesses: Array<{ state: string }> };
    bodies.push(body);
    // The compatibility fixture accepts only harness-health-v1 states and fields.
    const oldStates = ['ready', 'binary_missing', 'unwritable', 'trust_required', 'repair_failed'];
    if (bodies.length === 1 && (body.harnesses.some(fact => !oldStates.includes(fact.state)) || parseProvisionedHarnessReport(body) === null)) {
      accepted.push(false);
      return Response.json({ persisted: false, code: 'invalid_field' }, { headers: { [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL) } });
    }
    const answer = await rig.fetch(request);
    accepted.push((await answer.clone().json() as { persisted: boolean }).persisted);
    return answer;
  };
  await rig.fetch(new Request(SERVER + '/members/harnesses/report', { method: 'POST', headers: { authorization: 'Bearer ' + rig.token, 'content-type': 'application/json', [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL) }, body: JSON.stringify({ harnesses: [{ id: 'claude-code', provisioned: true, state: 'repair_failed', action: 'Repair it' }] }) }));
  expect((await readAttention(rig.env.serverEnv, Date.now())).items.some(item => item.kind === 'harness_needs_repair')).toBe(true);
  await reportHarnesses(result, home, Date.now() + 10_000, { entry, fetch });
  expect(bodies).toEqual([{ harnesses: [] }]);
  expect(accepted).toEqual([true]);
  expect((await readAttention(rig.env.serverEnv, Date.now())).items.some(item => item.kind === 'harness_needs_repair')).toBe(false);
  updateProjectContext(spool, home, cache => { cache.features = [HARNESS_HEALTH_FEATURE, HARNESS_HELD_ELSEWHERE_FEATURE]; });
  await reportHarnesses(result, home, Date.now() + 10_000, { entry, fetch });
  expect(bodies[1]).toEqual({ harnesses: result.harnesses });
  expect(accepted).toEqual([true, true]);
});


it('repairs deleted capture hooks before settling held tools, preserving the MCP entry', () => {
  const target = toolsHeldElsewhere();
  const hookFile = path.join(agentHome, '.claude', 'settings.json');
  const original = fs.readFileSync(hookFile, 'utf8');
  const mcp = fs.readFileSync(target, 'utf8');
  fs.unlinkSync(hookFile);
  const result = keepCurrent(home, { binaryFound: () => true });
  expect(fs.readFileSync(hookFile, 'utf8')).toBe(original);
  expect(result?.harnesses[0]).toMatchObject({ state: 'held_elsewhere', toolsDeployment: OTHER_SERVER });
  expect(fs.readFileSync(target, 'utf8')).toBe(mcp);
  expect(readProvisionRecord(home)?.version).toBe(getPluginVersion());
  const before = fs.statSync(hookFile).mtimeMs;
  keepCurrent(home, { binaryFound: () => true });
  expect(fs.statSync(hookFile).mtimeMs).toBe(before);
});

it('reports unrepairable capture independently of held tools without taking the entry or settling the record', () => {
  const target = toolsHeldElsewhere();
  const before = fs.readFileSync(target, 'utf8');
  const hookFile = path.join(agentHome, '.claude', 'settings.json');
  fs.unlinkSync(hookFile);
  fs.mkdirSync(hookFile);
  const fact = keepCurrent(home, { binaryFound: () => true })?.harnesses[0];
  expect(fact?.state).toBe('repair_failed');
  expect(fact?.toolsDeployment).toBeUndefined();
  expect(fact?.action).toBe('Fix the file, then run `myco member provision claude-code`.');
  expect(readProvisionRecord(home)?.version).toBe('old');
  expect(fs.readFileSync(target, 'utf8')).toBe(before);
});

it('doctor and status check missing skills and old versions even when tools use another Deployment', async () => {
  toolsHeldElsewhere();
  const manifest = loadManifests().find(m => m.name === 'claude-code')!;
  const folder = expandHome(manifest.registration!.globalSkillsTarget!);
  const skill = fs.readdirSync(folder)[0]!;
  fs.unlinkSync(path.join(folder, skill));
  const checks = setupChecks(home);
  expect(checks.some(check => check.status === 'warn' && check.detail.includes('skills are missing'))).toBe(true);
  expect(checks.some(check => check.status === 'warn' && check.detail.includes('this is'))).toBe(true);
  expect(checks.map(check => check.detail).join(' ')).not.toContain('member provision');
  const lines: string[] = [];
  await setup(['--status', '--json'], { mycoHome: home, cwd: agentHome, agents: () => ['claude-code'], stdout: line => lines.push(line), stderr: line => { throw new Error(line); } });
  const status = JSON.parse(lines.join('\n')).observations.find((fact: { id: string }) => fact.id === 'machine.agents');
  expect(status.detail).not.toContain('member provision');
  expect(status).toMatchObject({ state: 'incomplete', informational: false, detail: expect.stringContaining('skills are missing') });
  expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].state).toBe('held_elsewhere');
  expect(fs.existsSync(path.join(folder, skill))).toBe(true);
});

it('refuses to settle tools pointing at a Deployment this home no longer has a membership for', async () => {
  const target = toolsHeldElsewhere();
  const before = fs.readFileSync(target, 'utf8');
  fs.unlinkSync(deploymentPath(OTHER_SERVER, home));
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  let result;
  let logged: unknown[][] = [];
  try {
    result = keepCurrent(home, { binaryFound: () => true });
    logged = stderr.mock.calls.map(args => [...args]);
  } finally { stderr.mockRestore(); }
  const fact = result?.harnesses[0];
  expect(fact?.state).toBe('repair_failed');
  expect(fact?.toolsDeployment).toBeUndefined();
  const copy = "Claude Code's Myco tools point at https://other.myco.example; this machine is no longer connected there. Run `myco login https://other.myco.example`, or remove `mcpServers.myco` in `~/.claude.json` and run `myco member provision --refresh`.";
  expect(result?.localActions?.['claude-code']).toBe(copy);
  expect(logged).toEqual([[`[myco] keep-current: ${copy}\n`]]);
  expect(fact?.action).toBe("Claude Code's Myco tools point at a Myco this machine is no longer connected to. Open myco doctor on that machine for its address and reconnection steps.");
  const lines: string[] = [];
  runProvision(['--refresh'], { mycoHome: home, cwd: agentHome, stdout: line => lines.push(line) });
  expect(lines).toEqual([copy]);
  const entry = { version: REGISTRY_VERSION, projectId: 'proj_1', root: agentHome, serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 };
  const dir = new MemberSpool(entry, { mycoHome: home }).dir;
  updateProjectContext(dir, home, cache => { cache.features = [HARNESS_HEALTH_FEATURE]; });
  let report = '';
  await reportHarnesses(result ?? null, home, Date.now() + 10_000, { entry, fetch: async (_input, init) => {
    report = String(init?.body);
    return Response.json({ persisted: true }, { headers: { [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL) } });
  } });
  expect(report).toContain('repair_failed');
  expect(report).not.toContain(OTHER_SERVER);
  expect(report).not.toContain('localActions');
  const checks = setupChecks(home);
  expect(checks).toContainEqual(expect.objectContaining({ status: 'warn', detail: copy }));
  for (const check of checks) {
    expect(check.detail.toLowerCase()).not.toContain('run myco doctor');
    expect(check.detail).not.toContain('..');
    expect(check.detail).not.toContain('member provision claude-code');
    expect(check.detail).not.toContain("stay on");
  }
  expect(parseProvisionedHarnessReport({ harnesses: [fact] })).not.toBeNull();
  expect(readProvisionRecord(home)?.version).toBe('old');
  expect(fs.readFileSync(target, 'utf8')).toBe(before);
  const file = JSON.parse(before);
  delete file.mcpServers.myco;
  fs.writeFileSync(target, JSON.stringify(file));
  expect(runProvision(['--refresh'], { mycoHome: home, cwd: agentHome, stdout: () => {} })).toBe(true);
  expect(JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers.myco.url).toBe(SERVER + '/mcp');
});

it('keeps the machine.agents JSON contract and settles held tools in guided setup', async () => {
  const target = toolsHeldElsewhere();
  const before = fs.readFileSync(target, 'utf8');
  const lines: string[] = [];
  const errors: string[] = [];
  const fetch = Object.assign(async (input: string | URL | Request) => {
    const route = new URL(input instanceof Request ? input.url : input).pathname;
    if (route === '/health') return Response.json({ ok: true });
    if (route === '/auth/login') return new Response(null, { status: 302, headers: { location: 'https://github.com/login/oauth/authorize?client_id=fixture&redirect_uri=https%3A%2F%2Fmyco.example%2Fauth%2Fcallback' } });
    if (route === '/members/status') return Response.json({ target: 'fixture' }, { headers: { [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL) } });
    throw new Error('unexpected fixture route ' + route);
  }, { preconnect: () => {} });
  const deps = { mycoHome: home, cwd: agentHome, agents: () => ['claude-code'], stdout: (line: string) => lines.push(line), stderr: (line: string) => errors.push(line), fetch, ask: async () => null };
  writeRegistryEntry({ version: REGISTRY_VERSION, projectId: 'proj_1', root: agentHome, serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  const code = await setup(['--join', SERVER, '--no-runner', '--yes'], deps);
  expect({ code, errors }).toEqual({ code: 0, errors: [] });
  expect(lines.join('\n')).toContain('use other.myco.example');
  expect(lines.join('\n')).not.toContain('member provision');
  expect(fs.readFileSync(target, 'utf8')).toBe(before);
  lines.length = 0;
  await setup(['--status', '--json'], deps);
  const body = JSON.parse(lines.join('\n'));
  const agents = body.observations.find((fact: { id: string }) => fact.id === 'machine.agents');
  expect(agents).toMatchObject({ state: 'complete', informational: true, detail: expect.stringContaining('use other.myco.example') });
  expect(body.observations.some((fact: { id: string }) => fact.id === 'machine.tools')).toBe(false);
});


it('repairs a moved runtime pin without taking held tools or losing their ownership on later passes', () => {
  const oldBinary = path.join(home, 'old', 'myco');
  const newBinary = path.join(home, 'new', 'myco');
  for (const binary of [oldBinary, newBinary]) {
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(home, 'runtime.command'), oldBinary + '\n');
  writeDeploymentMembership({ serverUrl: OTHER_SERVER, token: 'B'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
  provisionGlobally('claude-code', null, home, { serverUrl: OTHER_SERVER });
  recordProvision(home, { version: 'old', serverUrl: SERVER, agents: ['claude-code'] });
  fs.writeFileSync(path.join(home, 'runtime.command'), newBinary + '\n');
  const first = keepCurrent(home, { binaryFound: () => true });
  expect(first?.harnesses[0]).toMatchObject({ state: 'held_elsewhere', toolsDeployment: OTHER_SERVER });
  const target = path.join(agentHome, '.claude.json');
  const entry = JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers.myco;
  expect(entry.url).toBe(OTHER_SERVER + '/mcp');
  expect(entry.headersHelper).toContain(newBinary);
  expect(entry.headersHelper).not.toContain(oldBinary);
  expect(fs.readFileSync(path.join(agentHome, '.claude', 'settings.json'), 'utf8')).toContain(newBinary);
  expect(readProvisionRecord(home)?.binaries?.['claude-code']).toBe(newBinary);
  const before = harnessFiles().map(file => [file, fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs]);
  expect(keepCurrent(home, { binaryFound: () => true })).toEqual(first);
  expect(harnessFiles().map(file => [file, fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs])).toEqual(before);
});

for (const agent of ['claude-code', 'codex']) for (const surface of ['hooks', 'mcp', 'helper']) for (const linked of surface === 'helper' ? [false] : [false, true]) it(`does not hold ${agent}'s stale ${surface} elsewhere or overwrite them during repair${linked ? ' through a linked config' : ''}`, async () => {
  if (surface === 'hooks') provisionGlobally(agent, null, home, { serverUrl: SERVER });
  const tools = surface === 'hooks' ? agent === 'claude-code' ? path.join(agentHome, '.claude.json') : config() : toolsHeldElsewhere(agent);
  const target = surface !== 'hooks' ? tools : agent === 'codex' ? hooks() : path.join(agentHome, '.claude', 'settings.json');
  const binary = path.join(agentHome, 'deleted', 'bin', 'myco');
  const entry = { command: binary, args: ['mcp'] };
  const original = fs.readFileSync(target, 'utf8');
  const currentBinary = agent === 'codex' && surface !== 'hooks'
    ? (parseToml(original) as { mcp_servers: { myco: { http_headers_helper: string } } }).mcp_servers.myco.http_headers_helper.split(' ')[0]
    : surface === 'helper' ? (JSON.parse(original) as { mcpServers: { myco: { headersHelper: string } } }).mcpServers.myco.headersHelper.split(' ')[0] : '';
  const replacedHelper = original.replaceAll(JSON.stringify(currentBinary).slice(1, -1), JSON.stringify(binary).slice(1, -1));
  if (surface === 'helper') expect(replacedHelper).not.toBe(original);
  fs.writeFileSync(target, surface === 'helper' ? replacedHelper : surface === 'hooks' ? JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: `${binary} hook stop --credential registry --myco-managed` }] }] } })
    : agent === 'codex' ? `[mcp_servers.myco]\ncommand = ${JSON.stringify(binary)}\nargs = ["mcp"]\n` : JSON.stringify({ mcpServers: { myco: entry } }));
  if (linked) {
    const destination = path.join(agentHome, 'dotfiles', `${agent}-${surface}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(target, destination);
    fs.symlinkSync(destination, target);
  }
  const before = fs.readFileSync(target);
  expect(setupChecks(home).some(check => check.toolsDeployment !== undefined)).toBe(false);
  const result = keepCurrent(home, { binaryFound: () => true });
  expect(result?.harnesses[0].state).toBe(surface === 'hooks' ? agent === 'codex' ? 'trust_required' : 'ready' : 'repair_failed');
  expect(result?.harnesses[0].toolsDeployment).toBeUndefined();
  if (surface !== 'hooks') {
    if (agent === 'codex') expect(parseToml(fs.readFileSync(target, 'utf8')).mcp_servers).toEqual(parseToml(before.toString()).mcp_servers);
    else expect(fs.readFileSync(target)).toEqual(before);
  }
  else expect(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.Stop).toContainEqual(JSON.parse(before.toString()).hooks.Stop[0]);
  const lines: string[] = [];
  await setup(['--status'], { mycoHome: home, cwd: agentHome, agents: () => [agent], stdout: line => lines.push(line), stderr: line => { throw new Error(line); } });
  expect(lines.join('\n')).not.toMatch(/use other.myco.example|held elsewhere|another installation|another Deployment/);
  if (surface !== 'hooks') {
    if (agent === 'codex') expect(parseToml(fs.readFileSync(target, 'utf8')).mcp_servers).toEqual(parseToml(before.toString()).mcp_servers);
    else expect(fs.readFileSync(target)).toEqual(before);
  }
  else expect(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.Stop).toContainEqual(JSON.parse(before.toString()).hooks.Stop[0]);
});

it('logs stale-blocked tools once until the entry changes', () => {
  provisionGlobally('claude-code', null, home, { serverUrl: SERVER });
  const file = path.join(agentHome, '.claude.json');
  const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const block = (name: string) => fs.writeFileSync(file, JSON.stringify({ mcpServers: { myco: { command: path.join(agentHome, name, 'bin', 'myco') } } }));
    block('deleted-install');
    expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].state).toBe('repair_failed');
    expect(keepCurrent(home, { binaryFound: () => true })?.harnesses[0].state).toBe('repair_failed');
    expect(write.mock.calls.filter(args => String(args[0]).includes('stale Myco entry'))).toHaveLength(1);
    block('another-deleted-install');
    keepCurrent(home, { binaryFound: () => true });
    expect(write.mock.calls.filter(args => String(args[0]).includes('stale Myco entry'))).toHaveLength(2);
  } finally { write.mockRestore(); }
});
