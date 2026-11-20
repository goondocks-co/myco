/**
 * `myco member provision <agent> [--root <dir>]` writes an agent's member hooks
 * and MCP entry for a project this machine has already joined, from the
 * recorded membership — the same provisioning `join --provision` runs, reading
 * and writing no token.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { run as runMemberCli, memberHarnessStatus, provisionGlobally, previewGlobalProvision, provisionAgents, detectedProvisionLines } from '@myco/cli/member.js';
import { CREDENTIAL_FLAG } from '@myco/member/constants.js';
import { readRegistryEntry, REGISTRY_VERSION, writeRegistryEntry, writeDeploymentMembership } from '@myco/member/registry.js';
import { detectMachineInstalledSymbionts, loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { setupChecks } from '@myco/cli/member-doctor.js';
import { planWritePaths } from '@myco/member/plan-files.js';
import { folderTranscriptDiscovery, harnessSettingsFolders, settingsFolderCandidates } from '@myco/symbionts/settings-folders.js';
import { silentRepository } from '@myco/member/auto-join.js';
import { locateTranscript } from '@myco/member/legacy-import.js';
import { enumerateTranscripts, sessionIdFromTranscriptPath } from '@myco/symbionts/transcript-discovery.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { resolveDeploymentUpstream } from '@myco/mcp/deployment-upstream.js';
import { hookCommands } from '@myco/symbionts/member-hooks.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';
import { holdHookTrust, recordProvision, reconcileProvisionAgents, provisionRecordPath, readProvisionRecord, readProvisionRecordStrict } from '@myco/symbionts/member-provision-record.js';

const TOKEN = 'A'.repeat(43);
const SERVER = 'https://myco.example';
let mycoHome: string;
let root: string;
let agentHome: string;
let restoreHome: () => void;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-provision-')));
  agentHome = path.join(root, 'agent-home');
  mycoHome = path.join(agentHome, '.myco');
  fs.mkdirSync(mycoHome, { recursive: true });
  fs.writeFileSync(path.join(mycoHome, 'machine_id'), 'm1');
  restoreHome = bindSandboxChildHome(root, { HOME: agentHome, MYCO_HOME: mycoHome });
  execFileSync('git', ['init', '-q', root]);
});
afterEach(() => {
  restoreHome();
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});

const join = (): void => writeRegistryEntry({
  version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl: SERVER, token: TOKEN, root, machineId: 'm1', joinedAt: 1, updatedAt: 1,
}, { mycoHome });

async function provision(args: string[]): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  await runMemberCli(['provision', ...args], {
    mycoHome, cwd: root, env: {}, packageRoot: resolvePackageRoot(),
    stdin: () => { throw new Error('provision must not read a token'); },
    stdout: (l) => out.push(l), stderr: (l) => err.push(l),
  });
  return { out, err };
}

describe('myco member provision', () => {
  for (const kind of ['membership', 'project']) it(`clears only the joined Deployment pending logouts on a successful ${kind} join`, () => {
    const other = 'https://other.example';
    const binaries = { 'claude-code': '/fixture/myco', cursor: '/fixture/myco' };
    const pendingTrust = { cursor: { action: 'review', at: 1 } };
    recordProvision(mycoHome, { version: 'test', serverUrl: SERVER, agents: ['claude-code', 'cursor'], binaries, pendingTrust, pendingLogout: { 'claude-code': [SERVER, other], cursor: [SERVER] } });
    if (kind === 'project') join();
    else writeDeploymentMembership({ serverUrl: SERVER + '/', token: TOKEN, machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
    expect(readProvisionRecord(mycoHome)).toMatchObject({ serverUrl: SERVER, agents: ['claude-code', 'cursor'], binaries, pendingTrust, pendingLogout: { 'claude-code': [other] } });
  });

  it('filters malformed pending logout entries for lenient readers while strict readers refuse the record', () => {
    recordProvision(mycoHome, { version: 'test', serverUrl: SERVER, agents: ['claude-code', 'cursor'] });
    const file = provisionRecordPath(mycoHome);
    const raw = JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pendingLogout: { 'claude-code': [SERVER], cursor: SERVER, unknown: [42] } });
    fs.writeFileSync(file, raw);
    expect(readProvisionRecord(mycoHome)).toMatchObject({ serverUrl: SERVER, agents: ['claude-code', 'cursor'], pendingLogout: { 'claude-code': [SERVER] } });
    expect(() => readProvisionRecordStrict(mycoHome)).toThrow('agent setup record');
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  });

  it('names the file and provision command when an agent config cannot be parsed', async () => {
    join();
    provisionGlobally('codex', root, mycoHome, { serverUrl: SERVER });
    const file = path.join(agentHome, '.codex', 'config.toml');
    fs.writeFileSync(file, 'invalid TOML [');
    const { err } = await provision(['codex', '--root', root]);
    expect(err.join('\n')).toContain(file);
    expect(err.join('\n')).toContain('Fix the file, then run `myco member provision codex`.');
    expect(fs.readFileSync(file, 'utf8')).toBe('invalid TOML [');
  });

  for (const recorded of [SERVER, 'https://left.example']) it(`allows provisioning for the survivor with pending logout and record on ${recorded}`, () => {
    join();
    recordProvision(mycoHome, { version: 'test', serverUrl: recorded, agents: ['claude-code'], pendingLogout: { 'claude-code': ['https://left.example'] } });
    expect(provisionGlobally('claude-code', root, mycoHome, { serverUrl: SERVER }).kind).toBe('provisioned');
    expect(fs.readFileSync(path.join(agentHome, '.claude', 'settings.json'), 'utf8')).toContain('--credential registry');
  });

  it('refuses an explicitly selected pending logout destination beside a surviving recorded destination', () => {
    recordProvision(mycoHome, { version: 'test', serverUrl: SERVER, agents: ['claude-code'], pendingLogout: { 'claude-code': ['https://left.example'] } });
    const outcome = provisionGlobally('claude-code', null, mycoHome, { serverUrl: 'https://left.example' });
    expect(outcome).toMatchObject({ kind: 'refused', detail: expect.stringContaining('waiting for `myco logout https://left.example` to finish') });
    expect(fs.existsSync(path.join(agentHome, '.claude', 'settings.json'))).toBe(false);
  });

  for (const pendingLogout of [null, [], { 'claude-code': 'https://left.example' }, { 'claude-code': [42] }]) it(`refuses malformed pending logout state ${JSON.stringify(pendingLogout)} before provisioning`, () => {
    recordProvision(mycoHome, { version: 'test', serverUrl: SERVER, agents: ['claude-code'] });
    const file = provisionRecordPath(mycoHome);
    const raw = JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pendingLogout });
    fs.writeFileSync(file, raw);
    expect(() => provisionGlobally('claude-code', null, mycoHome, { serverUrl: SERVER })).toThrow('agent setup record');
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    expect(fs.existsSync(path.join(agentHome, '.claude', 'settings.json'))).toBe(false);
  });

  it('retains an uncapturable agent pending logout while pruning an ordinary uncapturable choice', () => {
    const binary = path.join(mycoHome, 'bin', 'myco');
    recordProvision(mycoHome, { version: 'test', serverUrl: SERVER, agents: ['copilot', 'windsurf'], binaries: { copilot: binary, windsurf: binary }, pendingTrust: { copilot: { action: 'review', at: 1 } }, pendingLogout: { copilot: [SERVER] } });
    const record = reconcileProvisionAgents(mycoHome, { version: 'test', serverUrl: SERVER, discovered: [] }, new Set(['copilot', 'windsurf']));
    expect(record.agents).toEqual(['copilot']);
    expect(record.binaries).toEqual({ copilot: binary });
    expect(record.pendingTrust).toEqual({ copilot: { action: 'review', at: 1 } });
    expect(record.pendingLogout).toEqual({ copilot: [SERVER] });
  });

  it('leaves stale Codex tools with a credential marker during uninstall', () => {
    join();
    const file = path.join(agentHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const helper = `${root}/deleted-install/bin/myco member mcp-headers --credential registry --server ${SERVER}`;
    const before = `[mcp_servers.myco]\nurl = "${SERVER}/mcp"\nhttp_headers_helper = ${JSON.stringify(helper)}\n`;
    fs.writeFileSync(file, before);
    const installer = new SymbiontInstaller(loadManifests().find(m => m.name === 'codex')!, root, resolvePackageRoot(), false, mycoHome).forDeployment(SERVER);
    expect(installer.memberRegistrationPresent()).toBe(false);
    installer.uninstallMemberRegistration();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  for (const agent of ['pi', 'opencode']) it(`reports a partially set up ${agent} without claiming no agent is installed`, () => {
    join();
    const manifest = loadManifests().find(m => m.name === agent)!;
    const file = path.join(agentHome, manifest.registration!.globalHooksTarget!.replace(/^~\//, ''));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const before = `// myco:plugin-marker\nconst binary = "${root}/deleted-install/bin/myco";\n`;
    fs.writeFileSync(file, before);
    const lines = detectedProvisionLines(provisionAgents([agent], mycoHome, SERVER, root));
    expect(lines.join('\n')).toContain('capture hooks are not set up');
    expect(lines.join('\n')).not.toMatch(/No supported agent|Capture is set up|tools are not set up|provisioned .* globally/);
    expect(lines).toContain(`Capture is not set up for ${manifest.displayName}.`);
    expect(lines[0]).toBe(agent === 'opencode' ? 'Tools and skills are set up for OpenCode.' : 'Skills are set up for Pi.');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('reports tools without claiming a stale capture plugin was installed', () => {
    join();
    const manifest = loadManifests().find(m => m.name === 'opencode')!;
    const file = path.join(agentHome, manifest.registration!.globalHooksTarget!.replace(/^~\//, ''));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const before = `// myco:plugin-marker\nconst binary = "${root}/deleted-install/bin/myco";\n`;
    fs.writeFileSync(file, before);
    const outcome = provisionGlobally('opencode', root, mycoHome, { serverUrl: SERVER });
    expect(outcome.kind).toBe('provisioned');
    if (outcome.kind !== 'provisioned') throw new Error('Expected tools beside the stale plugin');
    expect(outcome.detail).toContain('(tools, skills)');
    expect(outcome.detail).not.toContain('(plugin');
    expect(outcome.detail).toContain('capture hooks are not set up');
    expect(outcome.captureReady).toBe(false);
    const lines = detectedProvisionLines(provisionAgents(['opencode'], mycoHome, SERVER, root));
    expect(lines[0]).toBe('Capture is not set up for OpenCode.');
    expect(lines.join('\n')).not.toContain('provisioned OpenCode globally');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('replaces a marked stale hook in an outdated member hook group while refreshing capture', () => {
    join();
    provisionGlobally('claude-code', root, mycoHome, { serverUrl: SERVER });
    const file = path.join(agentHome, '.claude', 'settings.json');
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    const stale = { type: 'command', command: `${root}/deleted-install/bin/myco hook stop --myco-managed`, timeout: 3 };
    const bytes = JSON.stringify(stale);
    const outdated = structuredClone(current);
    delete outdated.hooks.PostToolUse;
    delete outdated.hooks.PostToolUseFailure;
    outdated.hooks.Stop[0].hooks[0].timeout = 999;
    outdated.hooks.Stop[0].hooks.push(stale);
    fs.writeFileSync(file, JSON.stringify(outdated));
    provisionGlobally('claude-code', root, mycoHome, { serverUrl: SERVER });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.hooks.PostToolUse).toEqual(current.hooks.PostToolUse);
    expect(after.hooks.PostToolUseFailure).toEqual(current.hooks.PostToolUseFailure);
    const remaining = after.hooks.Stop.flatMap((group: { hooks: unknown[] }) => group.hooks);
    expect(remaining.filter((hook: unknown) => JSON.stringify(hook) === bytes)).toHaveLength(0);
    expect(remaining.filter((hook: { command: string }) => hook.command !== stale.command)).toEqual(current.hooks.Stop.flatMap((group: { hooks: unknown[] }) => group.hooks));
    expect(new SymbiontInstaller(loadManifests().find(m => m.name === 'claude-code')!, root, resolvePackageRoot(), false, mycoHome).forDeployment(SERVER).memberRegistrationCurrent()).toBe(true);
  });

  for (const key of ['mcpServers', 'servers']) it(`preserves a stale ${key} entry and sets up every other writable surface`, () => {
    join();
    const file = path.join(agentHome, '.claude.json');
    const entry = { command: path.join(root, 'deleted-install', 'bin', 'myco') };
    fs.writeFileSync(file, JSON.stringify({ [key]: { myco: entry } }));
    const preview = previewGlobalProvision('claude-code', root, mycoHome, SERVER);
    expect(preview.kind).toBe('ready');
    if (preview.kind !== 'ready') throw new Error('Expected a writable preview');
    expect(preview.targets.hooks).not.toBeNull();
    expect(preview.targets.mcp.length).toBe(key === 'mcpServers' ? 0 : 1);
    const outcome = provisionGlobally('claude-code', root, mycoHome, { serverUrl: SERVER });
    expect(outcome.kind).toBe('provisioned');
    if (outcome.kind !== 'provisioned') throw new Error('Expected provisioning beside the stale entry');
    expect(outcome.detail.split('\n')[0]).toBe(key === 'mcpServers' ? 'provisioned Claude Code globally (hooks, skills, settings)' : 'provisioned Claude Code globally (hooks, tools, skills, settings)');
    expect(outcome.detail).toContain(key === 'mcpServers' ? 'tools are not set up' : 'nothing else is affected');
    expect(outcome.detail).not.toContain('(hooks and MCP)');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[key].myco).toEqual(entry);
    expect(fs.readFileSync(path.join(agentHome, '.claude', 'settings.json'), 'utf8')).toContain('--credential registry');
    if (key !== 'mcpServers') expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.myco.url).toBe(`${SERVER}/mcp`);
  });

  it('writes the agent\'s hooks and remote MCP entry from the recorded membership, leaves the membership as it was, and reports an unchanged pass', async () => {
    join();
    const before = readRegistryEntry(root, mycoHome);
    const first = await provision(['codex']);
    expect(first.err).toEqual([]);
    expect(first.out).toEqual(['provisioned Codex globally (hooks, tools, skills, settings)']);
    const config = parseToml(fs.readFileSync(path.join(agentHome, '.codex', 'config.toml'), 'utf8')) as { mcp_servers: { myco: { url: string; http_headers_helper: string } } };
    expect(config.mcp_servers.myco.url).toBe(`${SERVER}/mcp`);
    expect(config.mcp_servers.myco.http_headers_helper).toContain(`member mcp-headers ${CREDENTIAL_FLAG} registry --server ${SERVER}`);
    expect(fs.existsSync(path.join(agentHome, '.codex', 'hooks.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.codex'))).toBe(false);
    expect(fs.readFileSync(path.join(agentHome, '.codex', 'config.toml'), 'utf8')).not.toContain(TOKEN);
    expect(readRegistryEntry(root, mycoHome)).toEqual(before);

    const second = await provision(['codex', '--root', root]);
    expect(second.out).toEqual(['no global registration changes for Codex']);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('refuses without writing on a machine with no membership and for an unknown agent, and provisions every detected agent when none is named', async () => {
    const unjoined = await provision(['codex']);
    expect(unjoined.err.join('\n')).toContain('no membership recorded on this machine — sign in with `myco login <address>` first');
    expect(process.exitCode).toBe(2);
    expect(fs.existsSync(path.join(root, '.codex'))).toBe(false);

    join();
    process.exitCode = 0;
    expect((await provision(['no-such-agent'])).err.join('\n')).toContain('unknown agent "no-such-agent"');
    expect(process.exitCode).toBe(2);

    process.exitCode = 0;
    expect((await provision([])).err).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('refuses before any write when the global Codex config declares a stdio myco server or cannot be parsed, and accepts a remote one with its own options', async () => {
    join();
    const globalConfig = path.join(agentHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
    try {
      fs.writeFileSync(globalConfig, '[mcp_servers.myco]\ncommand = "/opt/myco"\nargs = ["mcp"]\n');
      const refused = await provision(['codex']);
      expect(refused.out).toEqual([]);
      expect(refused.err.join('\n')).toContain(globalConfig);
      expect(refused.err.join('\n')).toContain('myco cutover --dry-run');
      expect(process.exitCode).toBe(2);
      expect(fs.existsSync(path.join(root, '.codex'))).toBe(false);

      process.exitCode = 0;
      fs.writeFileSync(globalConfig, '[mcp_servers.myco\ncommand = "old"\n');
      const unreadable = await provision(['codex']);
      expect(unreadable.out).toEqual([]);
      expect(unreadable.err.join('\n')).toContain(`could not read ${globalConfig}`);
      expect(process.exitCode).toBe(2);
      expect(fs.existsSync(path.join(root, '.codex'))).toBe(false);

      process.exitCode = 0;
      fs.writeFileSync(globalConfig, '[mcp_servers.other]\ncommand = "other"\n');
      expect((await provision(['codex'])).out).toEqual(['provisioned Codex globally (hooks, tools, skills, settings)']);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      fs.rmSync(path.dirname(globalConfig), { recursive: true, force: true });
    }
  });

  // POSIX only: a managed binary lives at `<home>/bin/myco` there, while Windows
  // keeps one `%LOCALAPPDATA%\Myco\bin\myco.exe` whatever the home is.
  it.skipIf(process.platform === 'win32')('names the binary of the project\'s own home in every hook command and MCP helper it writes, whether that home is passed or pinned', async () => {
    const savedMycoHome = process.env.MYCO_HOME;
    delete process.env.MYCO_HOME;
    const defaultHome = path.join(agentHome, '.myco');
    const binary = (home: string): string => {
      const file = path.join(home, 'bin', 'myco');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
      return file;
    };
    const defaultBinary = binary(defaultHome);
    const memberBinary = binary(mycoHome);
    const emitted = (global = true): string[] => {
      const targetRoot = global ? agentHome : root;
      const codexHooks = JSON.parse(fs.readFileSync(path.join(targetRoot, '.codex', 'hooks.json'), 'utf8')) as { hooks: unknown };
      const claudeHooks = JSON.parse(fs.readFileSync(path.join(targetRoot, '.claude', global ? 'settings.json' : 'settings.local.json'), 'utf8')) as { hooks: unknown };
      const codex = parseToml(fs.readFileSync(path.join(targetRoot, '.codex', 'config.toml'), 'utf8')) as { mcp_servers: { myco: { http_headers_helper: string } } };
      const claude = JSON.parse(fs.readFileSync(path.join(targetRoot, global ? '.claude.json' : '.mcp.json'), 'utf8')) as { mcpServers: { myco: { headersHelper: string } } };
      return [...hookCommands(codexHooks.hooks), ...hookCommands(claudeHooks.hooks), codex.mcp_servers.myco.http_headers_helper, claude.mcpServers.myco.headersHelper];
    };
    try {
      join();
      // Passed: `member provision` hands the installer the home it resolved.
      await provision(['codex']);
      await provision(['claude-code']);
      const passed = emitted();
      expect(passed.length).toBeGreaterThan(2);
      for (const command of passed) expect({ command, binary: command.split(' ')[0] }).toEqual({ command, binary: memberBinary });

      // Pinned: an installer given no home reads the project's pin, not the machine's default.
      fs.rmSync(path.join(root, '.codex'), { recursive: true, force: true });
      fs.rmSync(path.join(root, '.claude'), { recursive: true, force: true });
      fs.rmSync(path.join(root, '.mcp.json'), { force: true });
      fs.mkdirSync(path.join(root, '.myco'), { recursive: true });
      fs.writeFileSync(path.join(root, '.myco', 'runtime.home'), `${mycoHome}\n`, { mode: 0o644 });
      for (const name of ['codex', 'claude-code']) {
        const manifest = loadManifests().find((m) => m.name === name)!;
        new SymbiontInstaller(manifest, root, resolvePackageRoot(), false).install();
      }
      for (const command of emitted()) expect({ command, binary: command.split(' ')[0] }).toEqual({ command, binary: memberBinary });

    } finally {
      if (savedMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedMycoHome;
      fs.rmSync(path.join(defaultHome, 'bin'), { recursive: true, force: true });
    }
  });
});

it('migrates an owned Codex HTTP entry to session routing when its project moves to another Deployment', async () => {
  join();
  const first = await provision(['codex']);
  expect(first.err).toEqual([]);
  const config = path.join(agentHome, '.codex', 'config.toml');
  const before = parseToml(fs.readFileSync(config, 'utf8')) as { mcp_servers: { myco: { http_headers_helper: string } } };
  writeRegistryEntry({
    version: REGISTRY_VERSION, projectId: 'proj_other', serverUrl: 'https://other.example',
    token: TOKEN, root, machineId: 'm1', joinedAt: 1, updatedAt: 2,
  }, { mycoHome });
  const migrated = await provision(['codex']);
  expect(migrated.err).toEqual([]);
  const after = parseToml(fs.readFileSync(config, 'utf8')) as { mcp_servers: { myco: unknown } };
  expect(after.mcp_servers.myco).toEqual({ command: before.mcp_servers.myco.http_headers_helper.split(' ')[0],
    args: ['mcp', CREDENTIAL_FLAG, 'registry'], env_vars: ['MYCO_HOME'] });
  expect(resolveDeploymentUpstream('registry', { cwd: root, mycoHome, env: {} })?.mcpUrl.href).toBe('https://other.example/mcp');
});

for (const holder of ['hook', 'same-url'] as const) it(`keeps another 2.0 ${holder} holder without prescribing cutover`, async () => {
  join();
  expect((await provision(['codex'])).err).toEqual([]);
  const file = path.join(agentHome, '.codex', holder === 'hook' ? 'hooks.json' : 'config.toml');
  const original = fs.readFileSync(file, 'utf8');
  const currentBinary = holder === 'hook'
    ? hookCommands(JSON.parse(original).hooks)[0].split(' ')[0]
    : (parseToml(original) as { mcp_servers: { myco: { http_headers_helper: string } } }).mcp_servers.myco.http_headers_helper.split(' ')[0];
  const encodedBinary = JSON.stringify(currentBinary).slice(1, -1);
  const foreignHome = path.join(agentHome, 'other-myco');
  fs.mkdirSync(foreignHome);
  const foreignBinary = path.join(foreignHome, 'bin', 'myco');
  fs.mkdirSync(path.dirname(foreignBinary));
  fs.writeFileSync(foreignBinary, 'fixture');
  fs.writeFileSync(file, original.replaceAll(encodedBinary, JSON.stringify(foreignBinary).slice(1, -1)).replaceAll(currentBinary, foreignBinary));
  const before = fs.readFileSync(file, 'utf8');
  const refused = await provision(['codex']);
  expect(refused.out).toEqual([]);
  expect(refused.err.join('\n')).toContain(holder === 'hook' ? 'Capture stays with the other 2.0 installation.' : "Codex's Myco tools stay on https://myco.example");
  expect(refused.err.join('\n')).toContain('myco doctor');
  expect(refused.err.join('\n')).not.toContain('myco cutover');
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
});

/** A Claude Code folder as Claude Code leaves it once it has run there. */
function claudeFolder(folder: string): string {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '.claude.json'), '{}\n');
  return folder;
}

/** The hook commands a folder's settings register; none when the file is absent. */
const hooksIn = (folder: string): string[] => {
  const file = path.join(folder, 'settings.json');
  return fs.existsSync(file) ? hookCommands((JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks?: unknown }).hooks) : [];
};
const manifest = (name: string) => loadManifests().find((candidate) => candidate.name === name)!;
const joined = (lines: { out: string[]; err: string[] }) => ({ out: lines.out.join('\n'), err: lines.err.join('\n') });
const doctorWords = () => setupChecks(mycoHome).map((check) => `${check.status} ${check.detail}`).join('\n');
const codexHooksSetting = (folder: string) => (parseToml(fs.readFileSync(path.join(folder, 'config.toml'), 'utf8')).features as { hooks?: unknown } | undefined)?.hooks;

/**
 * A person with several accounts for one agent keeps a settings folder per account. Myco writes into the folders the
 * agent's variable names, the person names, or Myco set up before; it only reports a folder it finds in the home
 * folder, keeps each folder's own state, removes its entries from every one, and says in doctor what it knows.
 */
describe('settings folders', () => {
  let variable: string | undefined;
  beforeEach(() => { variable = process.env.CLAUDE_CONFIG_DIR; delete process.env.CLAUDE_CONFIG_DIR; join(); });
  afterEach(() => { if (variable === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = variable; });

  it('writes only where the variable, the person or the record says, reads a relative variable from the working directory, and only reports marked home folders', () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'config.json'), '{}\n');
    const marked = claudeFolder(path.join(agentHome, '.claude-work'));
    const linked = path.join(agentHome, 'linked-marker');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(outside, 'config.json'), path.join(linked, '.claude.json'));
    const unrelated = path.join(agentHome, 'unrelated-app');
    fs.mkdirSync(path.join(unrelated, 'data', 'settings'), { recursive: true });
    fs.mkdirSync(path.join(unrelated, 'data', 'logs'));
    claudeFolder(path.join(root, 'relative-config'));

    const env = { HOME: agentHome, CLAUDE_CONFIG_DIR: 'relative-config' };
    expect(harnessSettingsFolders(manifest('claude-code'), mycoHome, { env, cwd: root })).toEqual([
      { path: path.join(agentHome, '.claude'), origin: 'default' },
      { path: path.join(root, 'relative-config'), origin: 'variable' },
    ]);
    expect(settingsFolderCandidates(loadManifests(), mycoHome, { env, cwd: root })).toEqual(new Map([['claude-code', [marked]]]));

    provisionGlobally('claude-code', null, mycoHome, { serverUrl: SERVER });
    provisionGlobally('cline', null, mycoHome, { serverUrl: SERVER });
    for (const folder of [marked, linked]) expect(hooksIn(folder)).toEqual([]);
    expect(fs.existsSync(path.join(unrelated, 'plugins'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'config.json'), 'utf8')).toBe('{}\n');
    expect(doctorWords()).toContain(`warn ~/.claude-work holds the files Claude Code writes in a settings folder, but Myco has not been told to use it, so sessions run from it are not captured. If it is one of your Claude Code folders, run \`myco member provision claude-code --settings-folder ~/.claude-work\`.`);
    expect(harnessSettingsFolders(manifest('cursor'), mycoHome, { env })).toEqual([{ path: path.join(agentHome, '.cursor'), origin: 'default' }]);
  });

  it('sets up a named folder like the default one, keeps it through refusals, says what is configured, and removes it on retirement or removal', async () => {
    const work = claudeFolder(path.join(root, 'accounts', 'claude-work'));
    const { out } = joined(await provision(['claude-code', '--settings-folder', work]));
    expect(out).toContain(`provisioned Claude Code in ${work}`);
    expect(hooksIn(work)).toEqual(hooksIn(path.join(agentHome, '.claude')));
    expect(hooksIn(work).length).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(path.join(work, '.claude.json'), 'utf8')).mcpServers).toHaveProperty('myco');
    expect(fs.readdirSync(path.join(work, 'skills')).sort()).toEqual(fs.readdirSync(path.join(agentHome, '.claude', 'skills')).sort());
    expect(readProvisionRecord(mycoHome)?.settingsFolders).toEqual({ 'claude-code': [work] });
    expect(doctorWords()).toContain(`Myco's configuration is in place for Claude Code in ~/.claude, ${work}; capture from each folder is not checked here.`);

    fs.writeFileSync(path.join(work, '.claude.json'), JSON.stringify({ mcpServers: { myco: { type: 'http', url: 'https://other.example/mcp' } } }));
    expect(provisionGlobally('claude-code', null, mycoHome, { serverUrl: SERVER })).toMatchObject({ detail: expect.stringContaining(`Claude Code in ${work} was not set up`) });
    expect(readProvisionRecord(mycoHome)?.settingsFolders).toEqual({ 'claude-code': [work] });

    const gone = claudeFolder(path.join(root, 'accounts', 'claude-old'));
    await provision(['claude-code', '--settings-folder', gone]);
    fs.rmSync(gone, { recursive: true });
    expect(doctorWords()).toContain(`Claude Code's settings folder ${gone}, set up before, no longer exists.`);
    expect(joined(await provision(['claude-code', '--forget-settings-folder', gone])).out).toContain(`Myco no longer sets up Claude Code in ${gone}.`);
    expect(readProvisionRecord(mycoHome)?.settingsFolders).toEqual({ 'claude-code': [work] });

    fs.writeFileSync(path.join(work, '.claude.json'), '{}\n');
    await provision(['claude-code', '--settings-folder', work]);
    await provision(['claude-code', '--forget-settings-folder', work]);
    expect(hooksIn(work)).toEqual([]);
    expect(readProvisionRecord(mycoHome)?.settingsFolders).toBeUndefined();
    await provision(['claude-code', '--settings-folder', work]);
    expect(joined(await provision(['--remove', 'claude-code'])).out).toContain('Removed');
    for (const folder of [path.join(agentHome, '.claude'), work]) expect(hooksIn(folder)).toEqual([]);
    expect(readProvisionRecord(mycoHome)?.settingsFolders).toBeUndefined();
  });

  it("keeps each folder's own prior settings across provision and removal, and refuses a folder whose files lead outside it", async () => {
    const work = path.join(root, 'codex-work');
    fs.mkdirSync(path.join(agentHome, '.codex'), { recursive: true });
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(agentHome, '.codex', 'config.toml'), '[features]\nhooks = true\n');
    fs.writeFileSync(path.join(work, 'config.toml'), '[features]\nhooks = false\n');
    expect(provisionGlobally('codex', null, mycoHome, { serverUrl: SERVER, namedFolders: [work] })).toMatchObject({ kind: 'provisioned' });
    await provision(['--remove', 'codex']);
    expect([codexHooksSetting(path.join(agentHome, '.codex')), codexHooksSetting(work)]).toEqual([true, false]);

    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, '{}\n');
    const leaking = path.join(root, 'claude-leaking');
    fs.mkdirSync(leaking);
    fs.symlinkSync(outside, path.join(leaking, '.claude.json'));
    expect(joined(await provision(['claude-code', '--settings-folder', leaking])).out).toContain(`leads outside ${leaking}, so nothing was written in that folder`);
    expect(fs.readFileSync(outside, 'utf8')).toBe('{}\n');
    expect(hooksIn(leaking)).toEqual([]);
  });

  it('puts the tools entry where Claude Code reads it when its variable names the default folder', () => {
    const own = claudeFolder(path.join(agentHome, '.claude'));
    process.env.CLAUDE_CONFIG_DIR = own;
    provisionGlobally('claude-code', null, mycoHome, { serverUrl: SERVER });
    expect(JSON.parse(fs.readFileSync(path.join(own, '.claude.json'), 'utf8')).mcpServers).toHaveProperty('myco');
    expect(JSON.parse(fs.readFileSync(path.join(agentHome, '.claude.json'), 'utf8')).mcpServers).toHaveProperty('myco');
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(readProvisionRecord(mycoHome)?.settingsFolders).toEqual({ 'claude-code': [own] });
    expect(memberHarnessStatus('claude-code', mycoHome, SERVER).current).toBe(true);
  });

  it('names the folders and the action while hooks wait for review, without claiming capture', () => {
    const work = path.join(root, 'codex-work');
    fs.mkdirSync(work);
    provisionGlobally('codex', null, mycoHome, { serverUrl: SERVER, namedFolders: [work] });
    holdHookTrust(mycoHome, 'codex', "Restart Codex and trust Myco's hooks");
    const words = doctorWords();
    expect(words).toContain(`warn Codex skips Myco's hooks until you review them, in ~/.codex, ${work}. Restart Codex and trust Myco's hooks in each folder: start Codex with CODEX_HOME set to that folder for each one other than ~/.codex.`);
    expect(words).not.toContain('captured from');
  });

  it("detects the agent, finds its history and plans, leaves its repository alone and finds legacy transcripts in a folder Myco uses", () => {
    const work = claudeFolder(path.join(agentHome, '.claude-work'));
    expect(detectMachineInstalledSymbionts().map((found) => found.name)).toContain('claude-code');
    provisionGlobally('claude-code', null, mycoHome, { serverUrl: SERVER, namedFolders: [work] });
    const sessions = { [path.join(agentHome, '.claude')]: '11111111-1111-4111-8111-111111111111', [work]: '22222222-2222-4222-8222-222222222222' };
    for (const [folder, id] of Object.entries(sessions)) {
      fs.mkdirSync(path.join(folder, 'projects', '-repo'), { recursive: true });
      fs.writeFileSync(path.join(folder, 'projects', '-repo', `${id}.jsonl`), `${JSON.stringify({ cwd: root })}\n`);
    }
    const discovery = folderTranscriptDiscovery('claude-code', mycoHome);
    const found = enumerateTranscripts(discovery, 10, mycoHome).map((item) => [item.sessionId, sessionIdFromTranscriptPath(discovery, item.filePath)]).sort();
    expect(found).toEqual(Object.values(sessions).map((id) => [id, id]).sort());
    const moved = path.join(work, 'projects', '-repo', `${sessions[work]}.jsonl`);
    expect(locateTranscript('claude-code', sessions[work]!, moved, undefined, folderTranscriptDiscovery)?.file).toBe(moved);

    execFileSync('git', ['init', '-q', work]);
    expect(silentRepository(work, { mycoHome, env: { HOME: agentHome, MYCO_TEMPORARY_FOLDERS: path.join(root, 'other-temp') }, home: agentHome })).toBe(true);

    const plan = path.join(work, 'plans', 'next.md');
    process.env.CLAUDE_CONFIG_DIR = path.relative(root, work);
    const cwd = process.cwd();
    try {
      process.chdir(root);
      expect(planWritePaths('claude-code', 'Write', { file_path: plan }, root)).toEqual([plan]);
      process.env.CLAUDE_CONFIG_DIR = path.join(agentHome, '.claude');
      expect(planWritePaths('claude-code', 'Write', { file_path: plan }, root)).toEqual([]);
    } finally { process.chdir(cwd); }
  });

  it('sets up a folder the person names for an agent with its own variable and refuses one for an agent that keeps a single folder', async () => {
    const named = path.join(root, 'accounts', 'codex-team');
    fs.mkdirSync(named, { recursive: true });
    expect(joined(await provision(['codex', '--settings-folder', named])).out).toContain(`provisioned Codex in ${named}`);
    expect(fs.readFileSync(path.join(named, 'hooks.json'), 'utf8')).toContain(CREDENTIAL_FLAG);
    expect(joined(await provision(['cursor', '--settings-folder', named])).err).toContain('Cursor keeps its settings in one folder, so --settings-folder does not apply to it');
  });
});
