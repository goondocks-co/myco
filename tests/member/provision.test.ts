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
import { resolvePackageRoot } from '@myco/symbionts/detect.js';
import { tempMycoHome } from './helpers/server.js';

const TOKEN = 'A'.repeat(43);
const SERVER = 'https://myco.example';
let mycoHome: string;
let root: string;
beforeEach(() => {
  mycoHome = tempMycoHome();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-provision-')));
  execFileSync('git', ['init', '-q', root]);
});
afterEach(() => {
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
    expect(first.out).toEqual([`provisioned Codex for ${root} (hooks and MCP)`]);
    const config = parseToml(fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8')) as { mcp_servers: { myco: { url: string; http_headers_helper: string } } };
    expect(config.mcp_servers.myco.url).toBe(`${SERVER}/mcp`);
    expect(config.mcp_servers.myco.http_headers_helper).toContain(`member mcp-headers ${CREDENTIAL_FLAG} registry --server ${SERVER}`);
    expect(fs.existsSync(path.join(root, '.codex', 'hooks.json'))).toBe(true);
    expect(fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8')).not.toContain(TOKEN);
    expect(readRegistryEntry(root, mycoHome)).toEqual(before);

    const second = await provision(['codex', '--root', root]);
    expect(second.out).toEqual([`no registration changes for Codex at ${root}`]);
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

  it('refuses before any write when the global Codex config declares a stdio myco server, and names the file', async () => {
    join();
    const globalConfig = path.join(os.homedir(), '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
    try {
      fs.writeFileSync(globalConfig, '[mcp_servers.myco]\ncommand = "/opt/myco"\nargs = ["mcp"]\n');
      const refused = await provision(['codex']);
      expect(refused.out).toEqual([]);
      expect(refused.err.join('\n')).toContain(globalConfig);
      expect(refused.err.join('\n')).toContain('command, args');
      expect(process.exitCode).toBe(2);
      expect(fs.existsSync(path.join(root, '.codex'))).toBe(false);
    } finally {
      fs.rmSync(path.dirname(globalConfig), { recursive: true, force: true });
    }
  });
});
