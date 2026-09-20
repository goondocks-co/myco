/**
 * Member plugins for the plugin-file agents (OpenCode, Pi): `myco member
 * provision` writes the member plugin into the project's own plugin directory,
 * only when the agent's global Myco plugin steps aside for it, and `member
 * leave` takes it away again so the agent falls back to its global plugin.
 */
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
beforeEach(() => {
  mycoHome = tempMycoHome();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-plugins-')));
  execFileSync('git', ['init', '-q', root]);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const global of Object.values(GLOBALS)) fs.rmSync(path.join(os.homedir(), global), { recursive: true, force: true });
  process.exitCode = 0;
});

const join = (): void => writeRegistryEntry({
  version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl: 'https://myco.example', token: TOKEN, root, machineId: 'm1', joinedAt: 1, updatedAt: 1,
}, { mycoHome });

const writeGlobal = (agent: Agent, content: string): string => {
  const file = path.join(os.homedir(), GLOBALS[agent]);
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
    it(`${agent}: provision writes the member plugin with no global plugin installed, keeps it out of git, and a repeat changes nothing`, async () => {
      join();
      const before = readRegistryEntry(root, mycoHome);
      const first = await member(['provision', agent]);
      expect(first.err).toEqual([]);
      // OpenCode's tools come from an MCP server, Pi's from the extension itself.
      expect(first.out[0]).toMatch(new RegExp(`^provisioned .+ for ${root}${agent === 'opencode' ? ' \\(plugin and MCP\\)' : ''}$`));
      const written = fs.readFileSync(path.join(root, TARGETS[agent]), 'utf8');
      expect(written).toContain('myco:plugin-marker');
      expect(written).toContain('// myco:member-plugin');
      expect(written).toContain('const MYCO_CREDENTIAL_SOURCE = "registry";');
      expect(written).not.toMatch(/\{\{[A-Za-z0-9_.-]+\}\}/);
      expect(written).not.toContain(TOKEN);
      expect(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8')).toContain(TARGETS[agent]);
      expect(fs.existsSync(path.join(root, 'opencode.json'))).toBe(agent === 'opencode');
      expect(readRegistryEntry(root, mycoHome)).toEqual(before);
      if (agent === 'pi') {
        expect(written).toContain('Symbol.for("myco.member-extension")');
        expect(first.out[1]).toContain('trust the project in Pi');
      }
      expect((await member(['provision', agent])).out[0]).toMatch(/^no registration changes for /);
    });

    it(`${agent}: provision refuses before any write while the global Myco plugin does not step aside, and accepts one that does or a file Myco does not own`, async () => {
      join();
      const legacy = '// myco:plugin-marker — Myco owns this file\nexport default {};\n';
      const global = writeGlobal(agent, legacy);
      const refused = await member(['provision', agent]);
      expect(refused.out).toEqual([]);
      expect(refused.err.join('\n')).toContain(`${global} is a Myco plugin that does not step aside`);
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
      expect((await member(['provision', agent])).out[0]).toMatch(/^provisioned /);
      fs.rmSync(path.join(root, TARGETS[agent]));

      writeGlobal(agent, 'export default {};\n');
      expect((await member(['provision', agent])).out[0]).toMatch(/^provisioned /);
      expect(process.exitCode ?? 0).toBe(0);
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
    await member(['provision', 'opencode']);
    await member(['provision', 'pi']);
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
