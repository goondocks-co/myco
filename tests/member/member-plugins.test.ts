/** Global member plugin provisioning and cleanup of retained project overrides. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as runMemberCli } from '@myco/cli/member.js';
import { readRegistryEntry, REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { tempMycoHome } from './helpers/server.js';

const TOKEN = 'A'.repeat(43);
const TARGETS = { opencode: '.opencode/plugins/myco.ts', pi: '.pi/extensions/myco/index.ts' } as const;
const GLOBALS = { opencode: '.config/opencode/plugins/myco.ts', pi: '.pi/agent/extensions/myco/index.ts' } as const;
type Agent = keyof typeof TARGETS;

let mycoHome: string;
let root: string;
let agentHome: string;
let previousHome: string | undefined;
beforeEach(() => {
  mycoHome = tempMycoHome();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-plugins-')));
  execFileSync('git', ['init', '-q', root]);
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plugin-agent-home-'));
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

const writeGlobal = (agent: Agent, content: string): string => {
  const file = path.join(agentHome, GLOBALS[agent]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

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

describe('member plugins for plugin-file agents', () => {
  for (const agent of ['opencode', 'pi'] as const) {
    it(`${agent}: provision writes the global member plugin without project files, and a repeat changes nothing`, async () => {
      join();
      const before = readRegistryEntry(root, mycoHome);
      const first = await member(['provision', agent]);
      expect(first.err).toEqual([]);
      // OpenCode's tools come from an MCP server, Pi's from the extension itself.
      expect(first.out[0]).toMatch(/^provisioned .+ globally/);
      const written = fs.readFileSync(path.join(agentHome, GLOBALS[agent]), 'utf8');
      expect(written).toContain('myco:plugin-marker');
      expect(written).toContain('// myco:member-plugin');
      expect(written).toContain('const MYCO_CREDENTIAL_SOURCE = "registry";');
      expect(written).not.toMatch(/\{\{[A-Za-z0-9_.-]+\}\}/);
      expect(written).not.toContain(TOKEN);
      expect(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8')).not.toContain(TARGETS[agent]);
      expect(fs.existsSync(path.join(root, 'opencode.json'))).toBe(false);
      expect(readRegistryEntry(root, mycoHome)).toEqual(before);
      if (agent === 'pi') {
        expect(written).toContain('Symbol.for("myco.member-extension")');
        expect(first.out).toHaveLength(1);
      }
      expect((await member(['provision', agent])).out[0]).toMatch(/^no global registration changes for /);
    });

    it(`${agent}: global provisioning preserves legacy and foreign plugins until cutover`, async () => {
      join();
      const legacy = '// myco:plugin-marker — Myco owns this file\nexport default {};\n';
      const global = writeGlobal(agent, legacy);
      const refused = await member(['provision', agent]);
      expect(refused.out).toEqual([]);
      expect(refused.err.join('\n')).toContain('capture cutover');
      expect(process.exitCode).toBe(2);
      expect(fs.existsSync(path.join(root, TARGETS[agent]))).toBe(false);
      expect(fs.readFileSync(global, 'utf8')).toBe(legacy);

      process.exitCode = 0;
      fs.rmSync(global);
      fs.mkdirSync(global);
      expect((await member(['provision', agent])).err.join('\n')).toContain(`could not read ${global}`);
      expect(process.exitCode).toBe(2);
      expect(fs.existsSync(path.join(root, TARGETS[agent]))).toBe(false);
      fs.rmSync(global, { recursive: true });

      process.exitCode = 0;
      writeGlobal(agent, `${legacy}// myco:defers-to-member-plugin\n`);
      expect((await member(['provision', agent])).err.join('\n')).toContain('capture cutover');

      writeGlobal(agent, 'export default {};\n');
      expect((await member(['provision', agent])).err.join('\n')).toContain('capture cutover');
      expect(fs.readFileSync(global, 'utf8')).toBe('export default {};\n');
    });
  }

  it('refuses before any write to replace a project plugin file Myco does not own, and leaves it as it is', async () => {
    join();
    for (const agent of ['opencode', 'pi'] as const) {
      const target = path.join(root, TARGETS[agent]);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const own = '// the user\'s own plugin\nexport default {};\n';
      fs.writeFileSync(target, own);
      process.exitCode = 0;
      const refused = await member(['provision', agent]);
      expect(refused.out).toEqual([]);
      expect(refused.err.join('\n')).toContain(`${target} is not a Myco plugin`);
      expect(process.exitCode).toBe(2);
      expect(fs.readFileSync(target, 'utf8')).toBe(own);
      expect(fs.existsSync(path.join(root, '.git', 'info', 'exclude')) && fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').includes(TARGETS[agent])).toBe(false);
    }
  });

  it('leave, with or without --purge, removes the member plugins and never a 1.4 project plugin', async () => {
    join();
    for (const name of ['opencode', 'pi']) {
      new SymbiontInstaller(loadManifests().find((m) => m.name === name)!, root, resolvePackageRoot(), false, undefined, null, 'member-project', mycoHome).install();
    }
    const left = await member(['leave']);
    expect(left.out.filter((l) => l.includes('member plugin'))).toHaveLength(2);
    for (const agent of ['opencode', 'pi'] as const) expect(fs.existsSync(path.join(root, TARGETS[agent]))).toBe(false);

    // A 1.4 project-scope plugin at the same path carries only the generic marker.
    join();
    const projectPlugin = path.join(root, TARGETS.opencode);
    fs.mkdirSync(path.dirname(projectPlugin), { recursive: true });
    fs.writeFileSync(projectPlugin, '// myco:plugin-marker — Myco owns this file\n');
    await member(['leave', '--purge']);
    expect(fs.readFileSync(projectPlugin, 'utf8')).toContain('myco:plugin-marker');
  });

  it('JSON-hook agents still render no member plugin and plugin-file agents render no JSON hook block', () => {
    for (const name of ['opencode', 'pi']) {
      const installer = new SymbiontInstaller(loadManifests().find((m) => m.name === name)!, root, resolvePackageRoot(), false, undefined, null, 'member-project');
      expect(installer.renderMemberHooks('registry')).toBeNull();
      expect(installer.isMemberPluginFile()).toBe(true);
    }
    const codex = new SymbiontInstaller(loadManifests().find((m) => m.name === 'codex')!, root, resolvePackageRoot(), false, undefined, null, 'member-project');
    expect(codex.isMemberPluginFile()).toBe(false);
  });
});
