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
import { run as runMemberCli } from '@myco/cli/member.js';
import { CREDENTIAL_FLAG } from '@myco/member/constants.js';
import { readRegistryEntry, REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { hookCommands } from '@myco/symbionts/member-hooks.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';

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
  it('writes the agent\'s hooks and remote MCP entry from the recorded membership, leaves the membership as it was, and reports an unchanged pass', async () => {
    join();
    const before = readRegistryEntry(root, mycoHome);
    const first = await provision(['codex']);
    expect(first.err).toEqual([]);
    expect(first.out).toEqual(['provisioned Codex globally (hooks and MCP)']);
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
      expect((await provision(['codex'])).out).toEqual(['provisioned Codex globally (hooks and MCP)']);
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
        new SymbiontInstaller(manifest, root, resolvePackageRoot(), false, undefined, null, 'member-global').install();
      }
      for (const command of emitted()) expect({ command, binary: command.split(' ')[0] }).toEqual({ command, binary: memberBinary });

      // Every other scope keeps the machine's binary.
      const codex = loadManifests().find((m) => m.name === 'codex')!;
      const globalMcp = new SymbiontInstaller(codex, '/', resolvePackageRoot(), false, undefined, null, 'global').loadMcpTemplate() as { myco: { command: string } };
      expect(globalMcp.myco.command).toBe(defaultBinary);
    } finally {
      if (savedMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedMycoHome;
      fs.rmSync(path.join(defaultHome, 'bin'), { recursive: true, force: true });
    }
  });
});

it('names the other 2.0 Myco without prescribing legacy cutover or changing its config', async () => {
  join();
  const first = await provision(['codex']);
  expect(first.err).toEqual([]);
  const config = path.join(agentHome, '.codex', 'config.toml');
  const before = fs.readFileSync(config, 'utf8');
  writeRegistryEntry({
    version: REGISTRY_VERSION, projectId: 'proj_other', serverUrl: 'https://other.example',
    token: TOKEN, root, machineId: 'm1', joinedAt: 1, updatedAt: 2,
  }, { mycoHome });
  const refused = await provision(['codex']);
  const text = refused.err.join('\n');
  expect(text).toContain("Codex's Myco tools stay on https://myco.example");
  expect(text).toContain('Capture goes to the right one.');
  expect(text).toContain('myco doctor');
  expect(text).not.toContain('myco logout');
  expect(text).not.toContain('cutover');
  expect(fs.readFileSync(config, 'utf8')).toBe(before);
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
  fs.writeFileSync(file, original.replaceAll(encodedBinary, '/other/myco/bin/myco').replaceAll(currentBinary, '/other/myco/bin/myco'));
  const before = fs.readFileSync(file, 'utf8');
  const refused = await provision(['codex']);
  expect(refused.out).toEqual([]);
  expect(refused.err.join('\n')).toContain(holder === 'hook' ? 'Capture stays with the other 2.0 installation.' : "Codex's Myco tools stay on https://myco.example");
  expect(refused.err.join('\n')).toContain('myco doctor');
  expect(refused.err.join('\n')).not.toContain('myco cutover');
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
});
