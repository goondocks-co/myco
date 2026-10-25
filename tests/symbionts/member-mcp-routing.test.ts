import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import * as registry from '@myco/member/registry.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { parse as parseToml } from 'smol-toml';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { MemberMcpConflictError, SymbiontInstaller, resolveManagedBinaryPath } from '@myco/symbionts/installer.js';
import { privateMcpProjects } from '@myco/symbionts/member-mcp-projects.js';
import { managedBinaryPath } from '@myco/install/managed-binary.js';
import { REGISTRY_VERSION, writeRegistryEntry, removeRegistryEntry, readRegistryEntry, deploymentPath, registryEntryPath } from '@myco/member/registry.js';
import { resolveCredential } from '@myco/member/credential.js';
import { checkMemberMcpResolution } from '@myco/cli/doctor-member.js';
import { CREDENTIAL_FLAG, PROJECT_HEADER } from '@myco/member/constants.js';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { MCP_ROOT_FLAG, mcpProjectFolder } from '@myco/cli/flags.js';
import { runStatus, runExport, runMcpHeaders } from '@myco/cli/member.js';
import { logoutDeployment } from '@myco/symbionts/logout-runtime.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { recordingPlatform } from '../helpers/fake-service-manager.js';

const CLI = path.resolve('packages/myco/src/cli.ts');
const saved = { ...process.env };
let scratch: string;
let home: string;
let memberHome: string;
let work: string;
let personal: string;
const stops: Array<() => Promise<unknown> | void> = [];

function writeInScratch(file: string, write: (target: string) => void): void {
  expect(file).toBe(managedBinaryPath(memberHome, process.platform));
  const destination = fs.existsSync(file) ? fs.realpathSync(file) : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  const relative = path.relative(scratch, destination);
  expect(relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)).toBe(true);
  write(file);
}

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mcp-routing-')));
  home = path.join(scratch, 'home');
  memberHome = path.join(home, '.myco');
  work = path.join(scratch, 'work project');
  personal = path.join(scratch, "personal's project");
  for (const folder of [home, work, personal]) fs.mkdirSync(folder, { recursive: true });
  Object.assign(process.env, sandboxChildEnv(scratch, { HOME: home, MYCO_HOME: memberHome, LOCALAPPDATA: path.join(home, 'localappdata') }));
  const binary = managedBinaryPath(memberHome, process.platform);
  expect(path.relative(scratch, binary)).not.toMatch(/^\.\./);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const artifact = process.env.MYCO_TEST_ROUTING_BINARY;
  if (artifact === undefined) writeInScratch(binary, file => fs.writeFileSync(file, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(CLI).href)};\n`, { mode: 0o700 }));
  else {
    if (!path.isAbsolute(artifact)) throw new Error('The smoke binary must be absolute');
    writeInScratch(binary, file => {
      fs.copyFileSync(artifact, file);
      fs.chmodSync(file, 0o700);
    });
  }
});
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(scratch, { recursive: true, force: true });
});

function bind(root: string, url: string, token = 'A'.repeat(43)): void {
  writeRegistryEntry({ version: REGISTRY_VERSION, root, projectId: 'proj_shared', serverUrl: url, token,
    machineId: 'machine', joinedAt: 1, updatedAt: Date.now() }, { mycoHome: memberHome });
}
function installer(agent: string, root: string | null = work): SymbiontInstaller {
  const instance = new SymbiontInstaller(loadManifests().find(manifest => manifest.name === agent)!, root ?? memberHome, resolvePackageRoot(), false, memberHome);
  return root === null ? instance.withoutProjectRoot().forDeployment('https://work.example') : instance;
}
const target = (agent: string): string => path.join(home, agent === 'codex' ? '.codex/config.toml' : '.claude.json');
const claude = (): Record<string, any> => JSON.parse(fs.readFileSync(target('claude-code'), 'utf8'));
const codex = (): Record<string, any> => parseToml(fs.readFileSync(target('codex'), 'utf8'));

it('keeps one-Deployment HTTP entries and existing trust/configuration bytes unchanged on repeat provisioning', () => {
  bind(work, 'https://work.example');
  for (const agent of ['claude-code', 'codex']) {
    const member = installer(agent);
    member.installMemberMcp();
    const file = target(agent);
    const first = fs.readFileSync(file, 'utf8');
    expect(first).toContain('https://work.example/mcp');
    const formatted = agent === 'codex' ? '# owner configuration\n' + first + '\n' : JSON.stringify({ ...JSON.parse(first), projects: { [work]: { hasTrustDialogAccepted: false, user: true } } }, null, '\t') + '\n\n';
    fs.writeFileSync(file, formatted);
    expect(member.installMemberMcp()).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(formatted);
  }
  expect(claude().projects[work].mcpServers).toBeUndefined();
});

it('migrates both owned entries together with private scopes, no static Codex cwd, and no capture changes', () => {
  bind(work, 'https://work.example');
  for (const agent of ['claude-code', 'codex']) installer(agent).installMemberMcp();
  const data = claude();
  data.projects = { [work]: { hasTrustDialogAccepted: true, user: { keep: 1 } }, [personal]: { hasTrustDialogAccepted: false } };
  data.mcpServers.other = { command: 'other' };
  fs.writeFileSync(target('claude-code'), JSON.stringify(data));
  fs.appendFileSync(target('codex'), '\n[features]\nhooks = false\n[mcp_servers.other]\ncommand = "other"\n');
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  const before = [work, personal].map(root => resolveCredential('registry', { cwd: root, mycoHome: memberHome }));
  for (const agent of ['claude-code', 'codex']) expect(installer(agent, null).installMemberMcp()).toBe(true);
  const written = claude();
  expect(written.mcpServers).toEqual({ other: { command: 'other' } });
  expect(written.projects[work].user).toEqual({ keep: 1 });
  expect(written.projects[work].hasTrustDialogAccepted).toBe(true);
  expect(written.projects[personal].hasTrustDialogAccepted).toBe(false);
  for (const scope of privateMcpProjects(written)) expect((scope.entry as any).args).toEqual(['mcp', CREDENTIAL_FLAG, 'registry', MCP_ROOT_FLAG, scope.root]);
  expect(codex().mcp_servers.myco).toEqual({ command: resolveManagedBinaryPath(memberHome), args: ['mcp', CREDENTIAL_FLAG, 'registry'], env_vars: ['MYCO_HOME'] });
  expect(codex().features).toEqual({ hooks: false });
  expect(codex().mcp_servers.other).toEqual({ command: 'other' });
  expect([work, personal].map(root => resolveCredential('registry', { cwd: root, mycoHome: memberHome }))).toEqual(before);
  for (const agent of ['claude-code', 'codex']) {
    const text = fs.readFileSync(target(agent), 'utf8');
    expect(text).not.toContain('A'.repeat(43));
    expect(text).not.toContain('B'.repeat(43));
    expect(installer(agent, null).installMemberMcp()).toBe(false);
    expect(fs.readFileSync(target(agent), 'utf8')).toBe(text);
  }
});

it('preflights a foreign private entry before writing hooks or retiring a working global entry', () => {
  bind(work, 'https://work.example');
  installer('claude-code').installMemberMcp();
  const data = claude();
  data.projects = { [personal]: { mcpServers: { myco: { command: '/foreign/myco', args: ['mcp', CREDENTIAL_FLAG, 'registry'] } } } };
  const original = JSON.stringify(data);
  fs.writeFileSync(target('claude-code'), original);
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  expect(() => installer('claude-code').install()).toThrow(MemberMcpConflictError);
  expect(fs.readFileSync(target('claude-code'), 'utf8')).toBe(original);
  expect(fs.existsSync(path.join(home, '.claude/settings.json'))).toBe(false);
});

it('refuses foreign global entries and unreadable memberships before writing either agent', () => {
  bind(work, 'https://work.example');
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  for (const agent of ['claude-code', 'codex']) {
    fs.mkdirSync(path.dirname(target(agent)), { recursive: true });
    const text = agent === 'codex' ? '[mcp_servers.myco]\ncommand = "/foreign/myco"\nargs = ["mcp", "--credential", "registry"]\n' : JSON.stringify({ mcpServers: { myco: { command: '/foreign/myco', args: ['mcp', CREDENTIAL_FLAG, 'registry'] } } });
    fs.writeFileSync(target(agent), text);
    expect(() => installer(agent).install()).toThrow(MemberMcpConflictError);
    expect(fs.readFileSync(target(agent), 'utf8')).toBe(text);
  }
  fs.writeFileSync(deploymentPath('https://personal.example', memberHome), '{');
  expect(() => installer('claude-code').installMemberMcp()).toThrow(/could not all be read/);
});

it('reconciles rebind/leave through the installer and retains foreign scopes and trust', () => {
  bind(work, 'https://work.example');
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  installer('claude-code').installMemberMcp();
  const data = claude();
  data.projects.other = { hasTrustDialogAccepted: true, mcpServers: { myco: { command: 'user-owned' } } };
  fs.writeFileSync(target('claude-code'), JSON.stringify(data));
  removeRegistryEntry(personal, memberHome);
  expect(installer('claude-code', null).reconcileMemberProjectMcp()).toBe(true);
  expect(claude().projects[personal]).toBeUndefined();
  expect(claude().mcpServers.myco.url).toBe('https://work.example/mcp');
  expect(claude().projects.other).toEqual(data.projects.other);
  bind(work, 'https://personal.example', 'B'.repeat(43));
  installer('claude-code', null).installMemberMcp();
  expect(readRegistryEntry(work, memberHome)?.serverUrl).toBe('https://personal.example');
  expect(installer('claude-code', null).uninstallMemberMcp()).toBe(true);
  expect(claude().projects[work]).toBeUndefined();
  expect(claude().projects.other).toEqual(data.projects.other);
});

it('reports the expected destination per project, untrusted scopes, and read-only project overrides', async () => {
  bind(work, 'https://work.example');
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  for (const agent of ['claude-code', 'codex']) installer(agent).installMemberMcp();
  const data = claude();
  data.projects[work].hasTrustDialogAccepted = true;
  fs.writeFileSync(target('claude-code'), JSON.stringify(data));
  for (const [root, url, reason] of [[work, 'https://work.example', 'mcp_entry_stdio'], [personal, 'https://personal.example', 'mcp_project_untrusted']]) {
    const checks = await checkMemberMcpResolution(path.join(root, '.myco'), process.env, { registryRead: 'strict' });
    expect(checks).toContainEqual(expect.objectContaining({ symbiont: 'claude-code', root, toolsDeployment: url, reason }));
    expect(checks).toContainEqual(expect.objectContaining({ symbiont: 'codex', root, toolsDeployment: url, reason: 'mcp_entry_stdio' }));
  }
  const override = path.join(work, '.codex/config.toml');
  fs.mkdirSync(path.dirname(override));
  const text = '[mcp_servers.myco]\nurl = "https://user.example/mcp"\n';
  fs.writeFileSync(override, text);
  expect(await checkMemberMcpResolution(path.join(work, '.myco'), process.env)).toContainEqual(expect.objectContaining({ symbiont: 'codex', reason: 'mcp_project_override', status: 'warn' }));
  expect(fs.readFileSync(override, 'utf8')).toBe(text);
});

it('shares per-project tools facts between Doctor, status and export', async () => {
  bind(work, 'https://work.example');
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  for (const agent of ['claude-code', 'codex']) installer(agent).installMemberMcp();
  const output: string[] = [];
  const deps = { mycoHome: memberHome, cwd: work, stdout: (line: string) => output.push(line), stderr: (line: string) => { throw new Error(line); }, worker: { platform: 'darwin' as const, runner: recordingPlatform().runner } };
  runStatus(['--all'], deps);
  const status = output.join('\n');
  for (const value of ['https://work.example', 'https://personal.example', 'Claude Code', 'Codex', '.claude.json', '.codex/config.toml', memberHome]) expect(status).toContain(value);
  output.length = 0;
  await runExport(['--all'], deps);
  const checks = JSON.parse(output.join('\n')).checks;
  for (const [root, url] of [[work, 'https://work.example'], [personal, 'https://personal.example']]) {
    for (const agent of ['claude-code', 'codex']) expect(checks).toContainEqual(expect.objectContaining({ root, toolsDeployment: url, symbiont: agent, memberHome, homeSource: 'env', context: agent === 'codex' ? 'session-cwd' : 'explicit-folder', configPath: target(agent) }));
  }
});

it('restores one-Deployment HTTP tools and projectless headers without granting the surviving folder trust', async () => {
  bind(work, 'https://work.example');
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  recordDefaultDeployment('https://personal.example', { mycoHome: memberHome });
  for (const agent of ['claude-code', 'codex']) installer(agent).installMemberMcp();
  expect(claude().projects[personal].hasTrustDialogAccepted).toBeUndefined();
  await logoutDeployment('https://work.example', { mode: 'local-only' }, { mycoHome: memberHome, home, worker: { platform: 'darwin', runner: recordingPlatform().runner } });
  expect(claude().projects?.[personal]).toBeUndefined();
  expect(claude().mcpServers.myco.url).toBe('https://personal.example/mcp');
  expect(codex().mcp_servers.myco.url).toBe('https://personal.example/mcp');
  const output: string[] = [];
  runMcpHeaders(['--credential', 'registry', '--server', 'https://personal.example'], { cwd: home, mycoHome: memberHome, stdout: line => output.push(line) });
  expect(JSON.parse(output[0])[PROJECT_HEADER]).toBeUndefined();
  expect(JSON.parse(output[0]).authorization).toBe('Bearer ' + 'B'.repeat(43));
});

it('reports the actual project pin source when diagnostics use an explicitly selected registry home', async () => {
  execFileSync('git', ['init', '--quiet', work]);
  bind(work, 'https://work.example');
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  for (const agent of ['claude-code', 'codex']) installer(agent).installMemberMcp();
  const pin = path.join(work, '.myco/runtime.home');
  fs.mkdirSync(path.dirname(pin));
  fs.writeFileSync(pin, memberHome, { mode: 0o600 });
  delete process.env.MYCO_HOME;
  const output: string[] = [];
  const deps = { mycoHome: memberHome, cwd: work, stdout: (line: string) => output.push(line), worker: { platform: 'darwin' as const, runner: recordingPlatform().runner } };
  runStatus([], deps);
  expect(output.join('\n')).toContain('(project-pin)');
  output.length = 0;
  await runExport([], deps);
  const checks = JSON.parse(output.join('\n')).checks;
  for (const agent of ['claude-code', 'codex']) expect(checks).toContainEqual(expect.objectContaining({ symbiont: agent, memberHome, homeSource: 'project-pin', toolsDeployment: 'https://work.example' }));
  fs.writeFileSync(pin, path.join(scratch, 'different-home'));
  expect(checkMemberMcpResolution(path.join(work, '.myco'), process.env, { mycoHome: memberHome, folder: work })).toContainEqual(expect.objectContaining({ reason: 'mcp_home_mismatch', status: 'warn', toolsDeployment: undefined }));
});

it('reports unreadable private scopes while status and export continue checking the other agent', async () => {
  bind(work, 'https://work.example');
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  for (const agent of ['claude-code', 'codex']) installer(agent).installMemberMcp();
  const output: string[] = [];
  const deps = { mycoHome: memberHome, cwd: work, stdout: (line: string) => output.push(line), worker: { platform: 'darwin' as const, runner: recordingPlatform().runner } };
  for (const malformed of ['{', '{"projects":false}']) {
    fs.writeFileSync(target('claude-code'), malformed);
    runStatus(['--all'], deps);
    expect(output.join('\n')).toContain('could not be read');
    output.length = 0;
    await runExport(['--all'], deps);
    const checks = JSON.parse(output.join('\n')).checks;
    expect(checks).toContainEqual(expect.objectContaining({ symbiont: 'claude-code', status: 'warn', reason: 'mcp_target_unreadable' }));
    expect(checks).toContainEqual(expect.objectContaining({ symbiont: 'codex', toolsDeployment: 'https://work.example' }));
    expect(fs.readFileSync(target('claude-code'), 'utf8')).toBe(malformed);
    output.length = 0;
  }
});

function fakeDeployment(label: string, token: string) {
  const requests: Array<{ authorization: string | null; project: string | null; method: string }> = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ status: 'ok' });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const message = await request.json() as any;
    requests.push({ authorization: request.headers.get('authorization'), project: request.headers.get(PROJECT_HEADER), method: message.method });
    if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response(null, { status: 401 });
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: label, version: '1' } }
      : message.method === 'tools/list' ? { tools: ['myco_spores', 'myco_plans'].map(name => ({ name, inputSchema: { type: 'object' } })) }
        : { content: [{ type: 'text', text: `${label}:${message.params.name}` }] };
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  } });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

async function connect(command: string, args: string[], cwd: string): Promise<Client> {
  const client = new Client({ name: 'fake-harness', version: '1' });
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const transport = new StdioClientTransport({ command, args, cwd, env, stderr: 'pipe' });
  try { await client.connect(transport, { timeout: 5_000 }); }
  catch (error) { await transport.close(); throw error; }
  stops.push(() => client.close());
  return client;
}

it.skipIf(process.platform === 'win32')('runs the emitted Claude and Codex commands concurrently against only their own fake Deployment', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  const b = fakeDeployment('personal', 'B'.repeat(43));
  bind(work, a.url);
  bind(personal, b.url, 'B'.repeat(43));
  const binary = resolveManagedBinaryPath(memberHome);
  expect(path.relative(scratch, binary)).not.toMatch(/^\.\./);
  for (const agent of ['claude-code', 'codex']) installer(agent).installMemberMcp();
  const jobs = ['claude-code', 'codex'].flatMap(agent => [work, personal].map(async root => {
    const entry = agent === 'codex' ? codex().mcp_servers.myco : claude().projects[root].mcpServers.myco;
    const client = await connect(entry.command, entry.args, agent === 'codex' ? root : home);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['myco_spores', 'myco_plans']);
    for (const tool of ['myco_spores', 'myco_plans']) expect(await client.callTool({ name: tool, arguments: { op: 'list', project: 'proj_shared' } })).toEqual({ content: [{ type: 'text', text: `${root === work ? 'work' : 'personal'}:${tool}` }] });
  }));
  await Promise.all(jobs);
  for (const [server, token] of [[a, 'A'.repeat(43)], [b, 'B'.repeat(43)]] as const) {
    expect(server.requests.filter(request => request.method === 'tools/call')).toHaveLength(4);
    expect(server.requests.every(request => request.authorization === `Bearer ${token}` && request.project === 'proj_shared')).toBe(true);
  }
}, 15_000);

it.skipIf(process.platform === 'win32')('refuses absent context and a rebound destination before sending any tools to another Deployment', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  const b = fakeDeployment('personal', 'B'.repeat(43));
  bind(work, a.url);
  bind(personal, b.url, 'B'.repeat(43));
  installer('codex').installMemberMcp();
  const entry = codex().mcp_servers.myco;
  const unbound = spawnSync(entry.command, entry.args, { cwd: home, env: process.env, encoding: 'utf8', timeout: 5_000 });
  expect(unbound.status).toBe(1);
  expect(unbound.stderr).toContain('Myco tools need a connected project folder');
  expect(unbound.stderr).not.toContain('no capture');
  await expect(connect(entry.command, entry.args, home)).rejects.toThrow();
  expect(a.requests).toHaveLength(0);
  expect(b.requests).toHaveLength(0);
  const client = await connect(entry.command, entry.args, work);
  const sent = a.requests.length;
  bind(work, b.url, 'B'.repeat(43));
  await expect(client.callTool({ name: 'myco_spores', arguments: { op: 'list', project: 'proj_shared' } })).rejects.toThrow(/connection changed/);
  expect(a.requests).toHaveLength(sent);
  expect(b.requests).toHaveLength(0);
}, 10_000);

it.skipIf(process.platform === 'win32')('refuses a changed home pin before sending tools with the previous home credential', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  const b = fakeDeployment('personal', 'B'.repeat(43));
  bind(work, a.url);
  bind(personal, b.url, 'B'.repeat(43));
  installer('codex').installMemberMcp();
  const entry = codex().mcp_servers.myco;
  const pin = path.join(work, '.myco/runtime.home');
  fs.mkdirSync(path.dirname(pin));
  fs.writeFileSync(pin, memberHome, { mode: 0o600 });
  writeInScratch(entry.command, file => fs.writeFileSync(file, `#!${process.execPath}\ndelete process.env.MYCO_HOME;\nawait import(${JSON.stringify(pathToFileURL(CLI).href)});\n`));
  const client = await connect(entry.command, entry.args, work);
  const sent = a.requests.length;
  const otherHome = path.join(scratch, 'other-home');
  fs.mkdirSync(otherHome);
  fs.writeFileSync(pin, otherHome);
  await expect(client.callTool({ name: 'myco_plans', arguments: { op: 'list', project: 'proj_shared' } })).rejects.toThrow(/home changed/);
  expect(a.requests).toHaveLength(sent);
  expect(b.requests).toHaveLength(0);
}, 10_000);

it('admits only one absolute explicit folder and otherwise preserves the client session directory', () => {
  expect(mcpProjectFolder(['mcp', MCP_ROOT_FLAG, personal], home)).toBe(personal);
  expect(mcpProjectFolder(['mcp'], work)).toBe(work);
  for (const args of [[MCP_ROOT_FLAG], [MCP_ROOT_FLAG, '.'], [MCP_ROOT_FLAG, work, MCP_ROOT_FLAG, personal]]) expect(() => mcpProjectFolder(args, home)).toThrow(/one absolute/);
});

it('shares the canonical Claude scope and ancestor trust across a worktree and its subfolders', async () => {
  execFileSync('git', ['init', '--quiet', work]);
  execFileSync('git', ['-C', work, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
  const checkout = path.join(scratch, 'linked checkout');
  execFileSync('git', ['-C', work, 'worktree', 'add', '--quiet', '--detach', checkout]);
  bind(work, 'https://work.example');
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  installer('claude-code').forProjectFolder(checkout).installMemberMcp();
  const data = claude();
  expect(data.projects[checkout]).toBeUndefined();
  expect(data.projects[work].mcpServers.myco.args).toEqual(['mcp', CREDENTIAL_FLAG, 'registry', MCP_ROOT_FLAG, work]);
  data.projects[scratch] = { hasTrustDialogAccepted: true };
  fs.writeFileSync(target('claude-code'), JSON.stringify(data));
  const subfolder = path.join(checkout, 'packages/x');
  fs.mkdirSync(subfolder, { recursive: true });
  for (const folder of [work, checkout, subfolder]) {
    expect(checkMemberMcpResolution(path.join(work, '.myco'), process.env, { registryRead: 'strict', folder })).toContainEqual(expect.objectContaining({ symbiont: 'claude-code', reason: 'mcp_entry_stdio', status: 'ok', toolsDeployment: 'https://work.example' }));
    expect(installer('claude-code').forProjectFolder(folder).installMemberMcp()).toBe(false);
  }
  expect(installer('claude-code', null).installMemberMcp()).toBe(false);
  const output: string[] = [];
  const deps = { mycoHome: memberHome, cwd: subfolder, stdout: (line: string) => output.push(line), worker: { platform: 'darwin' as const, runner: recordingPlatform().runner } };
  runStatus([], deps);
  expect(output.join('\n')).toContain(subfolder);
  output.length = 0;
  await runExport([], deps);
  expect(JSON.parse(output.join('\n')).checks).toContainEqual(expect.objectContaining({ root: work, folder: subfolder, symbiont: 'claude-code', toolsDeployment: 'https://work.example', context: 'explicit-folder' }));
  expect(claude().projects[subfolder]).toBeUndefined();
});

it('refuses an unavailable binding during the one-Deployment private-scope retirement', () => {
  bind(work, 'https://work.example');
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  installer('claude-code').installMemberMcp();
  removeRegistryEntry(personal, memberHome);
  const before = fs.readFileSync(target('claude-code'), 'utf8');
  const list = registry.listRegistryEntriesResult;
  const race = spyOn(registry, 'listRegistryEntriesResult').mockImplementation(home => {
    const result = list(home);
    fs.writeFileSync(registryEntryPath(personal, memberHome), '{');
    return result;
  });
  try { expect(() => installer('claude-code', null).installMemberMcp()).toThrow(/project connection.*unavailable/); }
  finally { race.mockRestore(); }
  expect(fs.readFileSync(target('claude-code'), 'utf8')).toBe(before);
});

it('refuses an orphaned global HTTP entry with tools recovery before migrating private scopes', () => {
  bind(work, 'https://work.example');
  installer('claude-code').installMemberMcp();
  const data = claude();
  data.mcpServers.myco.url = 'https://left.example/mcp';
  data.mcpServers.myco.headersHelper = `${resolveManagedBinaryPath(memberHome)} member mcp-headers --credential registry --server https://left.example`;
  const before = JSON.stringify(data);
  fs.writeFileSync(target('claude-code'), before);
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  let refusal: unknown;
  try { installer('claude-code').install(); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(MemberMcpConflictError);
  expect((refusal as MemberMcpConflictError).localRemedy).toContain('https://left.example');
  expect((refusal as MemberMcpConflictError).localRemedy).toContain('~/.claude.json');
  expect((refusal as MemberMcpConflictError).localRemedy).toContain('mcpServers.myco');
  expect(fs.readFileSync(target('claude-code'), 'utf8')).toBe(before);
  expect(fs.existsSync(path.join(home, '.claude/settings.json'))).toBe(false);
});
