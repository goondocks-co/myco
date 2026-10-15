/**
 * OpenCode's member tools: `myco member provision opencode` writes the stdio
 * bridge into the project's own `opencode.json`, carrying the member
 * credential, and refuses first when the user-global `myco` server OpenCode
 * merges into it would leave that entry unusable. `member leave` takes the
 * entry away again, and never the one a 1.4 project install owns. The last
 * case covers every member MCP entry: a config Myco cannot parse is reported
 * rather than leaving the entry behind on a leave that claimed to remove it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as runMemberCli } from '@myco/cli/member.js';
import { CREDENTIAL_FLAG } from '@myco/member/constants.js';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { tempMycoHome } from './helpers/server.js';

const TOKEN = 'A'.repeat(43);
const GLOBAL_PLUGIN = '.config/opencode/plugins/myco.ts';
const GLOBAL_CONFIG = '.config/opencode/opencode.json';

let mycoHome: string;
let root: string;
let agentHome: string;
let previousHome: string | undefined;
beforeEach(() => {
  mycoHome = tempMycoHome();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-opencode-mcp-')));
  execFileSync('git', ['init', '-q', root]);
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-opencode-agent-home-'));
  previousHome = process.env.HOME;
  process.env.HOME = agentHome;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  fs.rmSync(agentHome, { recursive: true, force: true });
  process.exitCode = 0;
});

const join = (): void => writeRegistryEntry({
  version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl: 'https://myco.example', token: TOKEN, root, machineId: 'm1', joinedAt: 1, updatedAt: 1,
}, { mycoHome });

const globalConfigPath = (): string => path.join(agentHome, GLOBAL_CONFIG);

const writeGlobalConfig = (server: Record<string, unknown> | string): string => {
  const file = globalConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof server === 'string' ? server : JSON.stringify({ mcp: { myco: server } }));
  return file;
};

const projectConfig = (): { mcp?: Record<string, { type?: string; command?: string[] }> } =>
  JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8'));

async function member(args: string[]): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  await runMemberCli(args, {
    mycoHome, cwd: root, env: {}, packageRoot: resolvePackageRoot(),
    stdin: () => { throw new Error('no token is read'); },
    stdout: (l) => out.push(l), stderr: (l) => err.push(l),
  });
  return { out, err };
}

describe('OpenCode member MCP', () => {
  // POSIX only: a managed binary lives at `<home>/bin/myco` there, while Windows
  // keeps one `%LOCALAPPDATA%\\Myco\\bin\\myco.exe` whatever the home is.
  it.skipIf(process.platform === 'win32')('writes the project stdio bridge over the member home\'s binary, keeps the file\'s other servers, and writes no token', async () => {
    join();
    const memberBinary = path.join(mycoHome, 'bin', 'myco');
    fs.mkdirSync(path.dirname(memberBinary), { recursive: true });
    fs.writeFileSync(memberBinary, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({ mcp: { other: { type: 'local', command: ['/bin/true'] } } }));
    const provisioned = await member(['provision', 'opencode']);
    expect(provisioned.err).toEqual([]);
    expect(provisioned.out[0]).toBe('provisioned OpenCode globally (plugin, tools, skills)');

    const raw = fs.readFileSync(globalConfigPath(), 'utf8');
    const server = JSON.parse(raw).mcp.myco;
    expect(server.type).toBe('local');
    expect(server.command!.slice(-3)).toEqual(['mcp', CREDENTIAL_FLAG, 'registry']);
    expect(server.command![0]).toBe(memberBinary);
    expect(projectConfig().mcp!.other.command).toEqual(['/bin/true']);
    expect(raw).not.toContain(TOKEN);
  });

  for (const [label, server] of [
    ['a remote transport and its credential', { type: 'remote', url: 'https://elsewhere.example/mcp', headers: { Authorization: 'Bearer other' } }],
    ['an environment the bridge would inherit', { type: 'local', command: ['/opt/myco', 'mcp'], environment: { MYCO_HOME: '/somewhere/else' } }],
    ['a server switched off', { type: 'local', command: ['/opt/myco', 'mcp'], enabled: false }],
  ] as const) {
    it(`refuses before any write when the global config declares ${label}`, async () => {
      join();
      const foreignHome = path.join(root, 'other-install');
      fs.mkdirSync(foreignHome);
      const entry = 'environment' in server ? { ...server, environment: { MYCO_HOME: foreignHome } } : server;
      const global = writeGlobalConfig(entry);
      const before = fs.readFileSync(global, 'utf8');
      const refused = await member(['provision', 'opencode']);
      expect(refused.out).toEqual([]);
      expect(refused.err.join('\n')).toContain(global);
      expect(process.exitCode).toBe(2);
      // Neither surface was written: no MCP entry, and no member plugin either.
      expect(fs.existsSync(path.join(root, 'opencode.json'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.opencode', 'plugins', 'myco.ts'))).toBe(false);
      expect(fs.readFileSync(global, 'utf8')).toBe(before);
    });
  }

  it('refuses an unreadable or legacy global config and provisions an absent one', async () => {
    join();
    const global = writeGlobalConfig('{"mcp": {"myco": ');
    expect((await member(['provision', 'opencode'])).err.join('\n')).toContain(`could not read ${global}`);
    expect(process.exitCode).toBe(2);
    expect(fs.existsSync(path.join(root, 'opencode.json'))).toBe(false);

    process.exitCode = 0;
    fs.rmSync(global);
    expect((await member(['provision', 'opencode'])).out[0]).toContain('(plugin, tools, skills)');

    // The shape a 1.4 global install leaves: a launcher the project's own command replaces.
    const legacyHome = path.join(agentHome, 'other-install');
    fs.mkdirSync(legacyHome);
    writeGlobalConfig({ type: 'local', command: [path.join(legacyHome, 'bin', 'myco'), 'mcp'], enabled: true, timeout: 30 });
    expect((await member(['provision', 'opencode'])).err.join('\n')).toContain('capture cutover');
    expect(process.exitCode).toBe(2);
  });
});
