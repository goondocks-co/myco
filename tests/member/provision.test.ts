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
import { tempMycoHome } from './helpers/server.js';

const TOKEN = 'A'.repeat(43);
const SERVER = 'https://myco.example';
let mycoHome: string;
let root: string;
let agentHome: string;
let previousHome: string | undefined;
beforeEach(() => {
  mycoHome = tempMycoHome();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-provision-')));
  execFileSync('git', ['init', '-q', root]);
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-provision-agent-home-'));
  previousHome = process.env.HOME;
  process.env.HOME = agentHome;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  fs.rmSync(agentHome, { recursive: true, force: true });
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

  it('refuses without writing for a project with no membership, an unknown agent, or no agent at all', async () => {
    const unjoined = await provision(['codex']);
    expect(unjoined.err.join('\n')).toContain(`no membership recorded for ${root}`);
    expect(process.exitCode).toBe(2);
    expect(fs.existsSync(path.join(root, '.codex'))).toBe(false);

    join();
    process.exitCode = 0;
    expect((await provision(['no-such-agent'])).err.join('\n')).toContain('unknown agent "no-such-agent"');
    expect(process.exitCode).toBe(2);

    process.exitCode = 0;
    expect((await provision([])).err.join('\n')).toContain('name the agent to provision');
    expect(process.exitCode).toBe(2);
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
      expect(refused.err.join('\n')).toContain('capture cutover');
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
        new SymbiontInstaller(manifest, root, resolvePackageRoot(), false, undefined, null, 'member-project').install();
      }
      for (const command of emitted(false)) expect({ command, binary: command.split(' ')[0] }).toEqual({ command, binary: memberBinary });

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
