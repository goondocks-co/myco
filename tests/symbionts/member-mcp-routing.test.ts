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
import { recordProvision } from '@myco/member/provision-record.js';
import { settleConnection } from '@myco/cli/member-auto-join.js';
import { resolveCredential } from '@myco/member/credential.js';
import { clientRootDestination } from '@myco/mcp/client-roots.js';
import { checkMemberMcpResolution } from '@myco/cli/doctor-member.js';
import { CREDENTIAL_FLAG, PROJECT_HEADER } from '@myco/member/constants.js';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { MCP_ROOT_FLAG, MCP_CLIENT_ROOTS_FLAG, mcpHasExplicitRoot, mcpProjectFolder } from '@myco/cli/flags.js';
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

function writeInScratch(file: string, write: (target: string) => void, expectedHome = memberHome): void {
  expect(file).toBe(managedBinaryPath(expectedHome, process.platform));
  const destination = fs.existsSync(file) ? fs.realpathSync(file) : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  const relative = path.relative(scratch, destination);
  expect(relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)).toBe(true);
  write(file);
}

function initRepository(root: string): void {
  const relative = path.relative(scratch, fs.realpathSync(root));
  expect(relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)).toBe(true);
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) expect(process.env[key]).toBeUndefined();
  execFileSync('git', ['init', '--quiet', root], { cwd: scratch });
  const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { cwd: scratch, encoding: 'utf8' }).trim();
  expect(fs.realpathSync(top)).toBe(fs.realpathSync(root));
  expect(fs.existsSync(path.join(scratch, '.git'))).toBe(false);
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

function bind(root: string, url: string, token = 'A'.repeat(43), projectId = 'proj_shared'): void {
  writeRegistryEntry({ version: REGISTRY_VERSION, root, projectId, serverUrl: url, token,
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
  for (const agent of ['claude-code', 'codex', 'cursor', 'opencode', 'cline']) installer(agent).installMemberMcp();
  const output: string[] = [];
  const deps = { mycoHome: memberHome, cwd: work, stdout: (line: string) => output.push(line), stderr: (line: string) => { throw new Error(line); }, worker: { platform: 'darwin' as const, runner: recordingPlatform().runner } };
  runStatus(['--all'], deps);
  const status = output.join('\n');
  for (const value of ['https://work.example', 'https://personal.example', 'Claude Code', 'Codex', 'Cursor', 'OpenCode', 'Cline', '.claude.json', '.codex/config.toml', memberHome]) expect(status).toContain(value);
  output.length = 0;
  await runExport(['--all'], deps);
  const checks = JSON.parse(output.join('\n')).checks;
  for (const [root, url] of [[work, 'https://work.example'], [personal, 'https://personal.example']]) {
    for (const agent of ['claude-code', 'codex']) expect(checks).toContainEqual(expect.objectContaining({ root, toolsDeployment: url, symbiont: agent, memberHome, homeSource: 'env', context: agent === 'codex' ? 'session-cwd' : 'explicit-folder', configPath: target(agent) }));
    for (const agent of ['cursor', 'opencode']) expect(checks).toContainEqual(expect.objectContaining({ root, toolsDeployment: url, symbiont: agent, memberHome, homeSource: 'env', context: 'client-roots', configPath: expect.any(String), status: 'ok' }));
    expect(checks).toContainEqual(expect.objectContaining({ root, symbiont: 'cline', context: 'client-roots', status: 'warn', reason: 'mcp_cwd_ambiguous' }));
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
  initRepository(work);
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

function fakeDeployment(label: string, token: string, behavior: { health?: () => Promise<void>; failTools?: () => boolean } = {}) {
  const requests: Array<{ authorization: string | null; project: string | null; method: string }> = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (new URL(request.url).pathname === '/health') { await behavior.health?.(); return Response.json({ status: 'ok' }); }
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const message = await request.json() as any;
    requests.push({ authorization: request.headers.get('authorization'), project: request.headers.get(PROJECT_HEADER), method: message.method });
    if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response(null, { status: 401 });
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method.startsWith('tools/') && behavior.failTools?.()) return new Response('fixture unavailable', { status: 503 });
    const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: label, version: '1' } }
      : message.method === 'tools/list' ? { tools: ['myco_spores', 'myco_plans'].map(name => ({ name, inputSchema: { type: 'object' } })) }
        : { content: [{ type: 'text', text: `${label}:${message.params.name}` }] };
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  } });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

async function connect(command: string, args: string[], cwd: string, roots?: string[]): Promise<Client> {
  const client = new Client({ name: 'fake-harness', version: '1' }, roots === undefined ? {} : { capabilities: { roots: { listChanged: true } } });
  if (roots !== undefined) client.setRequestHandler('roots/list', async () => ({ roots: roots.map(uri => ({ uri })) }));
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
  expect(mcpHasExplicitRoot(['--root=' + work])).toBe(true);
  expect(mcpHasExplicitRoot(['--root', work])).toBe(true);
  expect(mcpHasExplicitRoot(['mcp'])).toBe(false);
  for (const args of [[MCP_ROOT_FLAG], [MCP_ROOT_FLAG, '.'], [MCP_ROOT_FLAG, work, MCP_ROOT_FLAG, personal]]) expect(() => mcpProjectFolder(args, home)).toThrow(/one absolute/);
});

it('shares the canonical Claude scope and ancestor trust across a worktree and its subfolders', async () => {
  initRepository(work);
  execFileSync('git', ['-C', work, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
  const checkout = path.join(scratch, 'linked checkout');
  execFileSync('git', ['-C', work, 'worktree', 'add', '--quiet', '--detach', checkout]);
  bind(work, 'https://work.example');
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  expect(clientRootDestination([pathToFileURL(work).href, pathToFileURL(checkout).href])()).toMatchObject({ serverUrl: 'https://work.example', projectId: 'proj_shared' });
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

function rootsEntry(agent: string): { command: string; args: string[] } {
  const rendered = installer(agent).renderMemberMcp('registry')!.myco as any;
  return Array.isArray(rendered.command) ? { command: rendered.command[0], args: rendered.command.slice(1) } : rendered;
}

it('writes roots strategies globally for Cursor, OpenCode and Cline, preserving other configuration', () => {
  bind(work, 'https://work.example');
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  for (const agent of ['cursor', 'opencode', 'cline']) {
    const member = installer(agent);
    expect(rootsEntry(agent).args).toEqual(['mcp', CREDENTIAL_FLAG, 'registry', MCP_CLIENT_ROOTS_FLAG]);
    expect(member.installMemberMcp()).toBe(true);
    expect(member.installMemberMcp()).toBe(false);
    const fact = checkMemberMcpResolution(path.join(work, '.myco'), process.env, { registryRead: 'strict' }).find(check => check.symbiont === agent);
    expect(fact).toMatchObject({ status: agent === 'cline' ? 'warn' : 'ok', context: 'client-roots' });
    if (agent === 'cline') expect(fact).toMatchObject({ reason: 'mcp_cwd_ambiguous', root: work });
    else expect(fact).toMatchObject({ toolsDeployment: 'https://work.example', projectId: 'proj_shared' });
    expect(fact!.detail).toContain('a client that sends no roots gets no tools here');
    expect(fs.existsSync(path.join(work, agent === 'opencode' ? 'opencode.json' : '.' + agent))).toBe(false);
  }
});

it.skipIf(process.platform === 'win32')('routes Cursor, OpenCode and Cline roots from an unrelated launch directory to their own Deployment', async () => {
  for (const root of [work, personal]) initRepository(root);
  const a = fakeDeployment('work', 'A'.repeat(43));
  const b = fakeDeployment('personal', 'B'.repeat(43));
  bind(work, a.url);
  bind(personal, b.url, 'B'.repeat(43));
  for (const agent of ['cursor', 'opencode', 'cline']) {
    const entry = rootsEntry(agent);
    for (const root of [work, personal]) {
      const subfolder = path.join(root, 'sub folder');
      fs.mkdirSync(subfolder, { recursive: true });
      const client = await connect(entry.command, entry.args, home, [pathToFileURL(root).href, pathToFileURL(subfolder).href]);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['myco_spores', 'myco_plans']);
      for (const name of ['myco_spores', 'myco_plans']) expect(await client.callTool({ name, arguments: { op: 'list', project: 'proj_shared' } }))
        .toEqual({ content: [{ type: 'text', text: (root === work ? 'work' : 'personal') + ':' + name }] });
    }
  }
  expect(a.requests.filter(request => request.method === 'tools/call')).toHaveLength(6);
  expect(b.requests.filter(request => request.method === 'tools/call')).toHaveLength(6);
  expect(a.requests.every(request => request.authorization === 'Bearer ' + 'A'.repeat(43) && request.project === 'proj_shared')).toBe(true);
  expect(b.requests.every(request => request.authorization === 'Bearer ' + 'B'.repeat(43) && request.project === 'proj_shared')).toBe(true);
}, 15_000);

it.skipIf(process.platform === 'win32')('refuses conflicting, invalid or unavailable client roots before contacting either Deployment', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  const b = fakeDeployment('personal', 'B'.repeat(43));
  bind(work, a.url);
  bind(personal, b.url, 'B'.repeat(43));
  const entry = rootsEntry('cursor');
  for (const roots of [[], undefined, [pathToFileURL(home).href], [pathToFileURL(work).href, pathToFileURL(personal).href], [pathToFileURL(work).href, pathToFileURL(home).href], ['https://work.example'], ['file:///tmp/%zz']]) {
    await expect((async () => {
      const client = await connect(entry.command, entry.args, work, roots);
      await client.listTools();
    })()).rejects.toThrow();
  }
  expect(a.requests).toHaveLength(0);
  expect(b.requests).toHaveLength(0);
}, 10_000);

it.skipIf(process.platform === 'win32')('uses one Deployment without guessing a Project when client roots are absent or empty', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  bind(work, a.url);
  bind(personal, a.url);
  for (const agent of ['cursor', 'opencode', 'cline']) {
    const entry = rootsEntry(agent);
    for (const roots of [undefined, []]) {
      const client = await connect(entry.command, entry.args, home, roots);
      expect((await client.listTools()).tools).toHaveLength(2);
    }
  }
  expect(a.requests.length).toBeGreaterThan(0);
  expect(a.requests.every(request => request.project === null)).toBe(true);
}, 10_000);

it.skipIf(process.platform === 'win32')('invalidates a roots connection when its roots change or its Project is rebound', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  const b = fakeDeployment('personal', 'B'.repeat(43));
  bind(work, a.url);
  bind(personal, b.url, 'B'.repeat(43));
  const entry = rootsEntry('opencode');
  const client = await connect(entry.command, entry.args, home, [pathToFileURL(work).href]);
  await client.listTools();
  await client.notification({ method: 'notifications/roots/list_changed' });
  await expect(client.listTools()).rejects.toThrow(/roots changed/);
  expect(b.requests).toHaveLength(0);
  const other = await connect(entry.command, entry.args, home, [pathToFileURL(work).href]);
  await other.listTools();
  const sent = a.requests.length;
  bind(work, b.url, 'B'.repeat(43));
  await expect(other.listTools()).rejects.toThrow(/connection changed/);
  expect(a.requests).toHaveLength(sent);
  expect(b.requests).toHaveLength(0);
}, 10_000);

it('reports all provisioned stdio agents ok for several Projects on one readable Deployment', () => {
  bind(work, 'https://work.example');
  bind(personal, 'https://work.example');
  for (const agent of ['cursor', 'opencode', 'cline']) {
    const member = installer(agent);
    member.installMemberMcp();
    const file = member.inspectMemberMcp(undefined, true)[0].configPath!;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = (data.mcpServers ?? data.mcp).myco;
    const words = Array.isArray(entry.command) ? entry.command : entry.args;
    words.splice(words.indexOf(MCP_CLIENT_ROOTS_FLAG), 1);
    fs.writeFileSync(file, JSON.stringify(data));
    const fact = checkMemberMcpResolution(path.join(work, '.myco'), process.env, { registryRead: 'strict' }).find(check => check.symbiont === agent)!;
    expect(fact).toMatchObject({ status: 'ok', context: 'launch-cwd', toolsDeployment: 'https://work.example' });
    expect(fact.detail).toContain('exactly one readable Deployment membership');
    bind(personal, 'https://personal.example', 'B'.repeat(43));
    expect(checkMemberMcpResolution(path.join(work, '.myco'), process.env, { registryRead: 'strict' }).find(check => check.symbiont === agent))
      .toMatchObject({ status: 'warn', reason: 'mcp_cwd_ambiguous' });
    fs.rmSync(deploymentPath('https://personal.example', memberHome));
    bind(personal, 'https://work.example');
  }
});

it.skipIf(process.platform === 'win32')('refuses an unreadable or orphaned membership and freezes the sole Deployment fallback', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  const b = fakeDeployment('personal', 'B'.repeat(43));
  bind(work, a.url);
  const entry = rootsEntry('cline');
  const client = await connect(entry.command, entry.args, home);
  await client.listTools();
  const sent = a.requests.length;
  bind(personal, b.url, 'B'.repeat(43));
  await expect(client.listTools()).rejects.toThrow(/exactly one readable/);
  expect(a.requests).toHaveLength(sent);
  expect(b.requests).toHaveLength(0);
  fs.rmSync(deploymentPath(b.url, memberHome));
  fs.rmSync(deploymentPath(a.url, memberHome));
  await expect((async () => { const orphan = await connect(entry.command, entry.args, home); await orphan.listTools(); })()).rejects.toThrow();
  expect(a.requests).toHaveLength(sent);
}, 10_000);

it.skipIf(process.platform === 'win32')('does not rebuild an upstream when roots change during a suspended self-heal probe', async () => {
  let fail = false;
  let held = false;
  let entered!: () => void;
  let release!: () => void;
  const probing = new Promise<void>(resolve => { entered = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  const a = fakeDeployment('work', 'A'.repeat(43), {
    health: async () => { if (held) { entered(); await resumed; } },
    failTools: () => { if (!fail) return false; fail = false; held = true; return true; },
  });
  bind(work, a.url);
  const entry = rootsEntry('cursor');
  const client = await connect(entry.command, entry.args, home, [pathToFileURL(work).href]);
  await client.listTools();
  fail = true;
  const call = client.callTool({ name: 'myco_spores', arguments: { op: 'list', project: 'proj_shared' } });
  const refused = call.then(() => null, error => error as Error);
  stops.push(() => release());
  await probing;
  await client.notification({ method: 'notifications/roots/list_changed' });
  release();
  expect((await refused)?.message).toMatch(/roots changed/);
  expect(a.requests.filter(request => request.method === 'initialize')).toHaveLength(1);
}, 10_000);

it('refuses distinct Projects on one Deployment and changed client-root home pins', () => {
  bind(work, 'https://work.example');
  bind(personal, 'https://work.example', 'A'.repeat(43), 'proj_other');
  expect(() => clientRootDestination([pathToFileURL(work).href, pathToFileURL(personal).href])()).toThrow(/different Myco destinations/);
  bind(personal, 'https://work.example/personal');
  expect(() => clientRootDestination([pathToFileURL(work).href, pathToFileURL(personal).href])()).toThrow(/different Myco destinations/);
  const env = { ...process.env };
  delete env.MYCO_HOME;
  const pin = path.join(work, '.myco/runtime.home');
  fs.mkdirSync(path.dirname(pin));
  fs.writeFileSync(pin, memberHome, { mode: 0o600 });
  const destination = clientRootDestination([pathToFileURL(work).href], env);
  expect(destination().projectId).toBe('proj_shared');
  fs.writeFileSync(pin, path.join(scratch, 'other-home'));
  expect(() => destination()).toThrow(/home changed/);
});

it('preserves foreign global roots entries and repository overrides during provisioning', () => {
  bind(work, 'https://work.example');
  for (const agent of ['cursor', 'opencode', 'cline']) {
    const member = installer(agent);
    member.installMemberMcp();
    const file = member.inspectMemberMcp(undefined, true)[0].configPath!;
    const global = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = (global.mcpServers ?? global.mcp).myco;
    entry.env = { MYCO_HOME: path.join(scratch, 'foreign-home') };
    const foreign = JSON.stringify(global);
    fs.writeFileSync(file, foreign);
    expect(() => member.installMemberMcp()).toThrow(/belongs to another installation/);
    expect(fs.readFileSync(file, 'utf8')).toBe(foreign);
    delete entry.env;
    fs.writeFileSync(file, JSON.stringify(global));
    const override = path.join(work, agent === 'opencode' ? 'opencode.json' : '.' + agent + '/mcp.json');
    fs.mkdirSync(path.dirname(override), { recursive: true });
    const bytes = JSON.stringify({ [agent === 'opencode' ? 'mcp' : 'mcpServers']: { myco: { command: 'user-tools' } } });
    fs.writeFileSync(override, bytes);
    member.installMemberMcp();
    expect(fs.readFileSync(override, 'utf8')).toBe(bytes);
    expect(checkMemberMcpResolution(path.join(work, '.myco'), process.env, { registryRead: 'strict' }).find(check => check.symbiont === agent))
      .toMatchObject({ status: 'warn', scope: 'project', reason: 'mcp_project_override' });
  }
});

const legacyEntry = () => {
  const entry = rootsEntry('cursor');
  return { ...entry, args: entry.args.filter(word => word !== MCP_CLIENT_ROOTS_FLAG) };
};

it.skipIf(process.platform === 'win32')('runs a legacy no-roots entry from an unbound folder using only the sole Deployment without a Project header', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  bind(work, a.url);
  const entry = legacyEntry();
  expect(entry.args).toEqual(['mcp', CREDENTIAL_FLAG, 'registry']);
  const client = await connect(entry.command, entry.args, personal);
  expect((await client.listTools()).tools).toHaveLength(2);
  expect(a.requests.length).toBeGreaterThan(0);
  expect(a.requests.every(request => request.project === null && request.authorization === 'Bearer ' + 'A'.repeat(43))).toBe(true);
}, 10_000);

it.skipIf(process.platform === 'win32')('keeps the bound Project header for a legacy no-roots entry on a one-Deployment machine', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  bind(work, a.url);
  const entry = legacyEntry();
  const client = await connect(entry.command, entry.args, work);
  expect((await client.listTools()).tools).toHaveLength(2);
  expect(a.requests.length).toBeGreaterThan(0);
  expect(a.requests.every(request => request.project === 'proj_shared')).toBe(true);
}, 10_000);

it.skipIf(process.platform === 'win32')('refuses an explicit unbound root for a legacy entry even with one readable Deployment', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  bind(work, a.url);
  const entry = legacyEntry();
  for (const flag of [[MCP_ROOT_FLAG, personal], [MCP_ROOT_FLAG + '=' + personal]]) {
    await expect((async () => { const client = await connect(entry.command, [...entry.args, ...flag], work); await client.listTools(); })()).rejects.toThrow();
  }
  expect(a.requests).toHaveLength(0);
}, 10_000);

it.skipIf(process.platform === 'win32')('routes wholly unconnected client roots to one Deployment without a Project header and freezes that destination', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  bind(work, a.url);
  for (const agent of ['cursor', 'opencode']) {
    const entry = rootsEntry(agent);
    const client = await connect(entry.command, entry.args, work, [pathToFileURL(personal).href, pathToFileURL(home).href]);
    expect((await client.listTools()).tools).toHaveLength(2);
    for (const name of ['myco_spores', 'myco_plans']) expect(await client.callTool({ name, arguments: { op: 'list', project: 'proj_shared' } }))
      .toEqual({ content: [{ type: 'text', text: 'work:' + name }] });
  }
  expect(a.requests.length).toBeGreaterThan(0);
  expect(a.requests.every(request => request.project === null)).toBe(true);
  const entry = rootsEntry('opencode');
  const client = await connect(entry.command, entry.args, work, [pathToFileURL(personal).href]);
  await client.listTools();
  const sent = a.requests.length;
  bind(personal, a.url, 'A'.repeat(43), 'proj_personal');
  await expect(client.listTools()).rejects.toThrow(/connection changed/);
  expect(a.requests).toHaveLength(sent);
}, 10_000);

it.skipIf(process.platform === 'win32')('refuses two bound Projects on one Deployment through the client roots protocol', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  bind(work, a.url);
  bind(personal, a.url, 'A'.repeat(43), 'proj_personal');
  const entry = rootsEntry('cursor');
  const client = await connect(entry.command, entry.args, home, [pathToFileURL(work).href, pathToFileURL(personal).href]);
  await expect(client.listTools()).rejects.toThrow(/different Myco destinations/);
  expect(a.requests).toHaveLength(0);
}, 10_000);

it.skipIf(process.platform === 'win32')('refuses an unavailable connected root instead of treating it as unconnected on one Deployment', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  bind(work, a.url);
  fs.chmodSync(registryEntryPath(work, memberHome), 0o644);
  const entry = rootsEntry('cursor');
  const client = await connect(entry.command, entry.args, home, [pathToFileURL(work).href]);
  await expect(client.listTools()).rejects.toThrow(/membership is unavailable/);
  expect(a.requests).toHaveLength(0);
}, 10_000);

it('reports Cline by the declared one-membership rule and refuses terminal memberships', () => {
  bind(work, 'https://work.example');
  installer('cline').installMemberMcp();
  const fact = () => checkMemberMcpResolution(path.join(work, '.myco'), process.env, { registryRead: 'strict' }).find(check => check.symbiont === 'cline')!;
  expect(fact()).toMatchObject({ status: 'ok', context: 'client-roots' });
  expect(fact().detail).toContain('without client roots');
  bind(personal, 'https://personal.example', 'B'.repeat(43));
  expect(fact()).toMatchObject({ status: 'warn', reason: 'mcp_cwd_ambiguous' });
  fs.rmSync(deploymentPath('https://personal.example', memberHome));
  bind(personal, 'https://work.example');
  const held = registry.readDeploymentMembership('https://work.example', memberHome)!;
  registry.writeDeploymentMembership({ ...held, refreshTerminal: true }, { mycoHome: memberHome });
  expect(fact()).toMatchObject({ status: 'warn', reason: 'mcp_cwd_ambiguous' });
  expect(() => clientRootDestination([pathToFileURL(home).href])()).toThrow(/exactly one readable/);
});

it('settlement publishes client-roots strategies to all provisioned adapters', async () => {
  bind(work, 'https://work.example');
  const agents = ['cursor', 'opencode', 'cline'];
  recordProvision(memberHome, { version: 'test', serverUrl: 'https://work.example', agents });
  const files = agents.map(agent => {
    const member = installer(agent);
    member.installMemberMcp();
    const file = member.inspectMemberMcp(undefined, true)[0].configPath!;
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = (config.mcpServers ?? config.mcp).myco;
    const argv = Array.isArray(entry.command) ? entry.command : entry.args;
    argv.splice(argv.indexOf(MCP_CLIENT_ROOTS_FLAG), 1);
    fs.writeFileSync(file, JSON.stringify(config));
    return file;
  });
  const errors: string[] = [];
  await settleConnection(readRegistryEntry(work, memberHome)!, { mycoHome: memberHome, now: Date.now, tell: false,
    fetch: async () => new Response(null, { status: 503 }), stderr: line => errors.push(line) });
  expect(errors).toEqual([]);
  for (const file of files) {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = (config.mcpServers ?? config.mcp).myco;
    expect(Array.isArray(entry.command) ? entry.command : entry.args).toContain(MCP_CLIENT_ROOTS_FLAG);
  }
});

it('uses the named home for wholly unconnected roots and refuses roots naming different homes', () => {
  bind(work, 'https://work.example');
  const otherHome = path.join(scratch, 'other-home');
  registry.writeDeploymentMembership({ serverUrl: 'https://personal.example', token: 'B'.repeat(43), machineId: 'machine', joinedAt: 1, updatedAt: 1 }, { mycoHome: otherHome });
  const env = { ...process.env };
  delete env.MYCO_HOME;
  const pin = path.join(personal, '.myco/runtime.home');
  fs.mkdirSync(path.dirname(pin));
  fs.writeFileSync(pin, otherHome, { mode: 0o600 });
  const destination = clientRootDestination([pathToFileURL(personal).href], env)();
  expect(destination.serverUrl).toBe('https://personal.example');
  expect(destination.headers[PROJECT_HEADER]).toBeUndefined();
  expect(destination.headers.authorization).toBe('Bearer ' + 'B'.repeat(43));
  expect(() => clientRootDestination([pathToFileURL(personal).href, pathToFileURL(home).href], env)()).toThrow(/different Myco homes/);
});

it.skipIf(process.platform === 'win32')('reports a no-roots client using its machine home when the Project is pinned elsewhere', async () => {
  const a = fakeDeployment('work', 'A'.repeat(43));
  const b = fakeDeployment('personal', 'B'.repeat(43));
  bind(work, a.url);
  const otherHome = path.join(scratch, 'other-home');
  writeRegistryEntry({ version: REGISTRY_VERSION, root: personal, projectId: 'proj_shared', serverUrl: b.url,
    token: 'B'.repeat(43), machineId: 'machine', joinedAt: 1, updatedAt: 1 }, { mycoHome: otherHome });
  fs.mkdirSync(path.join(personal, '.myco'));
  fs.writeFileSync(path.join(personal, '.myco/runtime.home'), otherHome, { mode: 0o600 });
  fs.writeFileSync(path.join(memberHome, 'runtime.home'), memberHome, { mode: 0o600 });
  const otherBinary = managedBinaryPath(otherHome, process.platform);
  fs.mkdirSync(path.dirname(otherBinary), { recursive: true });
  writeInScratch(otherBinary, file => fs.writeFileSync(file, '#!' + process.execPath + '\ndelete process.env.MYCO_HOME;\nawait import(' + JSON.stringify(pathToFileURL(CLI).href) + ');\n', { mode: 0o700 }), otherHome);
  const manifest = loadManifests().find(manifest => manifest.name === 'cline')!;
  const member = new SymbiontInstaller(manifest, personal, resolvePackageRoot(), false, otherHome);
  member.installMemberMcp();
  const config = JSON.parse(fs.readFileSync(member.inspectMemberMcp(undefined, true)[0].configPath!, 'utf8'));
  const entry = config.mcpServers.myco;
  expect(entry.env).toBeUndefined();
  const env = { ...process.env };
  delete env.MYCO_HOME;
  const fact = checkMemberMcpResolution(path.join(personal, '.myco'), env, { registryRead: 'strict' }).find(check => check.symbiont === 'cline')!;
  expect(fact).toMatchObject({ status: 'warn', reason: 'mcp_home_mismatch', memberHome, homeSource: 'machine-pin' });
  const client = await connect(entry.command, entry.args, home);
  expect((await client.listTools()).tools).toHaveLength(2);
  expect(a.requests.length).toBeGreaterThan(0);
  expect(a.requests.every(request => request.project === null)).toBe(true);
  expect(b.requests).toHaveLength(0);
});
