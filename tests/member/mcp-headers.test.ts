/**
 * `myco member mcp-headers --credential registry|env --server <url>` prints the
 * member headers a remote MCP entry's headers helper asks for (Codex
 * `http_headers_helper`): one JSON object on stdout, read from the registry
 * each time it runs, from whatever directory of the project the host starts
 * it in — and nothing at all when the membership is on another Deployment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as runMemberCli } from '@myco/cli/member.js';
import { memberHeaders } from '@myco/member/constants.js';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { tempMycoHome } from './helpers/server.js';

const TOKEN = 'A'.repeat(43);
const ROTATED = 'B'.repeat(43);
let mycoHome: string;
let root: string;
beforeEach(() => {
  mycoHome = tempMycoHome();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mcp-headers-')));
  // The project root resolves through git, as it does for every hook.
  execFileSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});

const SERVER_A = 'https://a.myco.example';
const SERVER_B = 'https://b.myco.example';
const join = (token: string, serverUrl: string = SERVER_A): void => writeRegistryEntry({
  version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl, token, root, machineId: 'm1', joinedAt: 1, updatedAt: 1,
}, { mycoHome });

async function headers(args: string[], cwd: string): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  await runMemberCli(['mcp-headers', ...args], { mycoHome, cwd, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { out, err };
}

describe('myco member mcp-headers', () => {
  it('prints the member headers as one JSON object from any directory of the project, and the rotated token once the registry holds it', async () => {
    join(TOKEN);
    const first = await headers(['--credential', 'registry', '--server', SERVER_A], path.join(root, 'src', 'deep'));
    expect(first.out).toHaveLength(1);
    expect(JSON.parse(first.out[0])).toEqual(memberHeaders({ token: TOKEN, projectId: 'proj_1' }));
    expect(process.exitCode ?? 0).toBe(0);

    join(ROTATED);
    // The registry's Deployment identity: a trailing slash names the same one.
    const second = await headers(['--credential', 'registry', '--server', `${SERVER_A}/`], root);
    expect(JSON.parse(second.out[0])).toEqual(memberHeaders({ token: ROTATED, projectId: 'proj_1' }));
  });

  it('prints nothing and exits non-zero with no membership, and refuses a missing credential source', async () => {
    const unjoined = await headers(['--credential', 'registry', '--server', SERVER_A], root);
    expect(unjoined.out).toEqual([]);
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    const noFlag = await headers([], root);
    expect(noFlag.out).toEqual([]);
    expect(noFlag.err.join('\n')).toContain('--credential registry|env');
    expect(process.exitCode).toBe(2);

    join(TOKEN);
    process.exitCode = 0;
    const noServer = await headers(['--credential', 'registry'], root);
    expect(noServer.out).toEqual([]);
    expect(noServer.err.join('\n')).toContain('--server <server-url>');
    expect(process.exitCode).toBe(2);
  });

  it('prints no credential when the membership moved to another Deployment after the entry was provisioned', async () => {
    join(TOKEN, SERVER_A);
    const codex = loadManifests().find((m) => m.name === 'codex')!;
    const previous = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    let entry: { url: string; http_headers_helper: string };
    try {
      const block = new SymbiontInstaller(codex, root, resolvePackageRoot(), false, undefined, null, 'member-project').renderMemberMcp('registry');
      entry = (block as { myco: typeof entry }).myco;
    } finally {
      if (previous === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = previous;
    }
    expect(entry.url).toBe(`${SERVER_A}/mcp`);
    // The helper's own arguments, exactly as provisioned against A.
    const helperArgs = entry.http_headers_helper.split(' ').slice(3);
    expect(helperArgs).toEqual(['--credential', 'registry', '--server', SERVER_A]);

    join(ROTATED, SERVER_B);
    const moved = await headers(helperArgs, root);
    expect(moved.out).toEqual([]);
    expect(moved.err.join('\n')).not.toContain(ROTATED);
    expect(moved.err.join('\n')).toContain(`on ${SERVER_B}, not ${SERVER_A}`);
    expect(process.exitCode).toBe(1);
  });
});
