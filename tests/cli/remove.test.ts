import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, deploymentLosses } from '@myco/cli/remove.js';
import { runProvision } from '@myco/cli/member.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { installWorkerService, workerServiceUnit } from '@myco/runner/service.js';
import { recordingPlatform } from '../helpers/fake-service-manager.js';
import { legacyFixtureHome } from '../setup/fixtures/legacy-home.ts';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { LocalVolume } from '@myco/server/local-volume.js';
import { resolveLocalPaths } from '@myco/server/local.js';
import { spyOn } from 'bun:test';

const SERVER = 'https://member.example';
let root: string;
let home: string;
let user: string;
let saved: NodeJS.ProcessEnv;
let platform: ReturnType<typeof recordingPlatform>;

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) visit(file);
      else files[path.relative(dir, file)] = entry.isSymbolicLink() ? `link:${fs.readlinkSync(file)}` : fs.readFileSync(file).toString('base64');
    }
  };
  visit(dir);
  return files;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-remove-'));
  user = path.join(root, 'user');
  home = path.join(root, 'member-home');
  saved = { ...process.env };
  Object.assign(process.env, sandboxChildEnv(root, { HOME: user, MYCO_HOME: home }));
  fs.mkdirSync(home, { recursive: true });
  platform = recordingPlatform();
  process.exitCode = 0;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  process.exitCode = 0;
  fs.rmSync(root, { recursive: true, force: true });
});
const deps = () => ({ mycoHome: home, worker: { home: user, platform: 'darwin' as const, runner: platform.runner, binaryPath: path.join(home, 'bin', 'myco') } });
const write = (relative: string, text = 'preserve') => {
  const file = path.join(home, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

function member(): void {
  writeDeploymentMembership({ serverUrl: SERVER, token: 'm'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 } as never, { mycoHome: home });
  recordDefaultDeployment(SERVER, { mycoHome: home });
  fs.mkdirSync(path.join(user, '.claude'), { recursive: true });
  expect(runProvision([], { mycoHome: home, cwd: root, agents: () => ['claude-code'], stdout: () => {}, stderr: () => {} })).toBe(true);
  write('member/spool/captured.jsonl', 'real capture fixture');
}

describe('member-only remove', () => {
  it('removes member hooks, MCP, skill links and both executor services, preserving capture, legacy files and repository files', async () => {
    member();
    const legacy = legacyFixtureHome(path.join(root, 'legacy'));
    const before = snapshot(legacy.root);
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, '.myco'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.myco', 'myco.yaml'), 'legacy config');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'user rules');
    const repoBefore = snapshot(repo);
    write('bin/myco', 'fixture binary presence marker');
    for (const executor of ['legacy-member', 'runner'] as const) {
      installWorkerService({ ...deps().worker, mycoHome: home, serverUrl: SERVER, executor }, [], { runner: platform.runner });
    }
    await run(['--yes'], deps());
    expect(process.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(home, 'member/spool/captured.jsonl'), 'utf8')).toBe('real capture fixture');
    expect(snapshot(legacy.root)).toEqual(before);
    expect(snapshot(repo)).toEqual(repoBefore);
    expect(fs.readFileSync(path.join(user, '.claude', 'settings.json'), 'utf8')).not.toContain('--credential');
    const mcp = path.join(user, '.claude.json');
    expect(fs.existsSync(mcp) ? fs.readFileSync(mcp, 'utf8') : '').not.toContain('mcpServers');
    expect(fs.readdirSync(path.join(user, '.claude', 'skills'))).toEqual([]);
    expect(platform.running.size).toBe(0);
    expect(fs.readdirSync(path.join(user, 'Library', 'LaunchAgents'))).toEqual([]);
  });

  it('purges a 2.0 home while leaving the 1.4 home byte-identical', async () => {
    member();
    const legacy = legacyFixtureHome(path.join(root, 'legacy'));
    const before = snapshot(legacy.root);
    await run(['--purge', '--yes'], deps());
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(home)).toBe(false);
    expect(snapshot(legacy.root)).toEqual(before);
  });

  it('refuses to remove a 1.4 home even with every purge consent flag', async () => {
    const legacy = legacyFixtureHome(path.join(root, 'legacy'));
    const before = snapshot(legacy.root);
    await run(['--purge', '--allow-deployment-loss', '--yes'], { ...deps(), mycoHome: legacy.mycoHome });
    expect(process.exitCode).toBe(1);
    expect(snapshot(legacy.root)).toEqual(before);
    expect(platform.commands).toEqual([]);
  });

  it('a declined confirmation changes nothing', async () => {
    member();
    const before = snapshot(root);
    await run(['--purge'], { ...deps(), confirm: async () => false });
    expect(process.exitCode).toBe(1);
    expect(snapshot(root)).toEqual(before);
    expect(platform.commands).toEqual([]);
  });

  for (const entry of ['config.yaml', 'myco.yaml', 'service/daemon.json', 'myco.db']) {
    it(`preserves a legacy-only home containing ${entry} without a nonempty vault`, async () => {
      write(entry, '');
      const before = snapshot(root);
      await run(['--purge', '--allow-deployment-loss', '--yes'], deps());
      expect(process.exitCode).toBe(1);
      expect(snapshot(root)).toEqual(before);
      expect(platform.commands).toEqual([]);
    });
  }

  it('preserves an unrecognized home', async () => {
    write('unrecognized.txt');
    const before = snapshot(root);
    await run(['--purge', '--yes'], deps());
    expect(process.exitCode).toBe(1);
    expect(snapshot(root)).toEqual(before);
  });

  it('preserves legacy state even when the home also holds a member registration', async () => {
    member();
    write('config.yaml', 'legacy settings');
    const before = snapshot(root);
    await run(['--purge', '--allow-deployment-loss', '--yes'], deps());
    expect(process.exitCode).toBe(1);
    expect(snapshot(root)).toEqual(before);
    expect(platform.commands).toEqual([]);
  });

  it('a repeated purge succeeds after the member home is gone', async () => {
    member();
    await run(['--purge', '--yes'], deps());
    await run(['--purge', '--yes'], deps());
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(home)).toBe(false);
  });

  for (const directory of ['home', 'server']) {
    it(`refuses a symlinked ${directory} before changing its external target or registrations`, async () => {
      member();
      const external = path.join(root, 'external');
      if (directory === 'home') {
        fs.renameSync(home, external);
        fs.symlinkSync(external, home, 'dir');
      } else {
        fs.mkdirSync(external);
        fs.writeFileSync(path.join(external, 'deployment-data'), 'preserve');
        fs.symlinkSync(external, path.join(home, 'server'), 'dir');
      }
      const before = snapshot(root);
      await expect(run(['--purge', '--allow-deployment-loss', '--yes'], deps())).rejects.toThrow('symlinked');
      expect(snapshot(root)).toEqual(before);
      expect(platform.commands).toEqual([]);
    });
  }

  it('preserves an external managed binary and versions shared with another home', async () => {
    member();
    const binary = path.join(root, 'shared-windows-install', 'bin', 'myco.exe');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, 'shared binary');
    const other = path.join(root, 'other-home');
    fs.mkdirSync(other);
    const marker = JSON.stringify({ channel: 'stable', source: 'npm', bin: binary });
    write('install.json', marker);
    fs.writeFileSync(path.join(other, 'install.json'), marker);
    const before = snapshot(other);
    await run(['--purge', '--yes'], deps());
    expect(fs.readFileSync(binary, 'utf8')).toBe('shared binary');
    expect(snapshot(other)).toEqual(before);
  });

  it('validates every agent config before stopping services or unregistering another agent', async () => {
    member();
    write('bin/myco', 'binary marker');
    installWorkerService({ ...deps().worker, mycoHome: home, serverUrl: SERVER, executor: 'runner' }, [], { runner: platform.runner });
    fs.mkdirSync(path.join(user, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(user, '.cursor', 'mcp.json'), '{broken');
    const before = snapshot(root);
    platform.commands.length = 0;
    await expect(run(['--purge', '--yes'], deps())).rejects.toThrow('Cannot read');
    expect(snapshot(root)).toEqual(before);
    expect(platform.commands).toEqual([]);
  });

  it('preserves another home’s orphan executor service', async () => {
    member();
    write('bin/myco', 'binary marker');
    const other = path.join(root, 'other-member-home');
    for (const executor of ['runner', 'legacy-member'] as const) {
      installWorkerService({ ...deps().worker, mycoHome: other, serverUrl: SERVER, executor }, [], { runner: platform.runner });
    }
    const before = snapshot(path.join(user, 'Library', 'LaunchAgents'));
    platform.commands.length = 0;
    await run(['--purge', '--yes'], deps());
    expect(snapshot(path.join(user, 'Library', 'LaunchAgents'))).toEqual(before);
    for (const executor of ['runner', 'legacy-member'] as const) {
      const foreignLabel = workerServiceUnit(SERVER, other, executor).label;
      expect(platform.commands.some(command => command.includes(foreignLabel))).toBe(false);
    }
  });

  it('keeps lease files until the Deployment lease has closed', async () => {
    write('server/local/myco.sqlite');
    const original = LocalVolume.prototype.exclusive;
    const lease = spyOn(LocalVolume.prototype, 'exclusive').mockImplementation(function(this: LocalVolume, callback: () => unknown) {
      return original.call(this, () => {
        const result = callback();
        expect(fs.existsSync(path.join(home, 'server/local.lock'))).toBe(true);
        expect(fs.existsSync(path.join(home, 'server/cloudflare.lock'))).toBe(true);
        expect(fs.existsSync(path.join(home, 'server/local'))).toBe(false);
        return result;
      });
    });
    try { await run(['--purge', '--allow-deployment-loss', '--yes'], deps()); }
    finally { lease.mockRestore(); }
    expect(fs.existsSync(home)).toBe(false);
  });
});

for (const artifact of ['server/local/myco.sqlite', 'server/cloudflare/record.json', 'server/cloudflare.json']) {
  it(`refuses purge with ${artifact} before unregistering anything`, async () => {
    member();
    write(artifact);
    expect(deploymentLosses(home).join('\n')).toContain('myco server backup --target');
    if (artifact.includes('cloudflare')) expect(deploymentLosses(home).join('\n')).toContain('resource identities and recovery metadata');
    const before = snapshot(root);
    await run(['--purge', '--yes'], deps());
    expect(process.exitCode).toBe(1);
    expect(snapshot(root)).toEqual(before);
    expect(platform.commands).toEqual([]);
  });
  it(`explicit second flag permits loss of ${artifact}`, async () => {
    write(artifact);
    await run(['--purge', '--allow-deployment-loss', '--yes'], deps());
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(home)).toBe(false);
  });
}

it('the deployment-loss flag alone is refused', async () => {
  await expect(run(['--allow-deployment-loss', '--yes'], deps())).rejects.toThrow('requires --purge');
  expect(fs.existsSync(home)).toBe(true);
});
