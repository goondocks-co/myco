import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, deploymentLosses, unsafePurgePath } from '@myco/cli/remove.js';
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
import { Database } from 'bun:sqlite';
import { writeInstallMarker } from '@myco/install/managed-binary.js';
import { runnerRecordPath } from '@myco/runner/runner-registry.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { retiredVerbMessage } from '@myco/cli/retired-verbs.js';
import { legacyMigrationState } from '@myco/member/legacy-migration.js';
import { defaultSpec, servicePaths, renderUnit } from '@myco/server/service.js';

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

function installMarker(at = home): void {
  writeInstallMarker(at, { channel: 'stable', source: 'npm', bin: path.join(at, 'bin', 'myco') });
}

function member(): void {
  installMarker();
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
    expect((fs.existsSync(path.join(user, '.claude', 'settings.json')) ? fs.readFileSync(path.join(user, '.claude', 'settings.json'), 'utf8') : '')).not.toContain('--credential');
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
    expect(fs.readdirSync(home)).toEqual(['backups']);
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

  it('plain remove leaves a legacy-only home and its legacy skill links byte-identical', async () => {
    const legacy = legacyFixtureHome(path.join(root, 'legacy'));
    Object.assign(process.env, sandboxChildEnv(root, { HOME: legacy.home, MYCO_HOME: legacy.mycoHome }));
    const source = path.join(legacy.mycoHome, 'skills', 'old-skill');
    const target = path.join(legacy.home, '.claude', 'skills', 'old-skill');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target, 'dir');
    const before = snapshot(legacy.root);
    await run(['--yes'], { ...deps(), mycoHome: legacy.mycoHome, worker: { ...deps().worker, home: legacy.home } });
    expect(process.exitCode).toBe(0);
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

  for (const entry of ['groves/empty', 'config.yaml', 'myco.yaml', 'service/daemon.json', 'myco.db']) {
    it(`preserves and names legacy ${entry} in a member home`, async () => {
      member();
      write(entry, '');
      const output = spyOn(console, 'log').mockImplementation(() => {});
      try {
        await run(['--purge', '--allow-deployment-loss', '--yes'], deps());
        expect(process.exitCode).toBe(0);
        expect(fs.readFileSync(path.join(home, entry), 'utf8')).toBe('');
        expect(output.mock.calls.flat().join('\n')).toContain(`Your 1.4 files remain at ${path.join(home, entry.split('/')[0])}`);
      } finally { output.mockRestore(); }
    });
  }

  it('preserves unrecognized entries on a repeated or unregistered home', async () => {
    write('unrecognized.txt');
    const before = snapshot(root);
    await run(['--purge', '--yes'], deps());
    expect(process.exitCode).toBe(0);
    expect(snapshot(root)).toEqual(before);
  });

  it('plain remove and purge work after cutover, preserving legacy vault and backups byte for byte', async () => {
    member();
    const legacy = legacyFixtureHome(path.join(root, 'legacy'));
    const vault = path.join(home, 'groves', 'grove_fixture', 'myco.db');
    fs.mkdirSync(path.dirname(vault), { recursive: true });
    fs.copyFileSync(legacy.vault, vault);
    write('config.yaml', 'legacy settings');
    write('backups/cutover-fixture/myco.db', fs.readFileSync(vault).toString('base64'));
    const stamp = fs.statSync(vault);
    write('member/cutover.json', JSON.stringify({ version: 2, backups: {}, handover: { at: 1, legacyHomes: [home], agents: [] }, migrations: {
      [vault]: { digest: 'fixture', size: stamp.size, mtimeMs: stamp.mtimeMs, projects: Object.fromEntries(legacy.projects.map(p => [p.id, { destination: { skip: true, at: 1 } }])) },
    } }));
    fs.chmodSync(path.join(home, 'member/cutover.json'), 0o600);
    expect(legacyMigrationState(home).state).toBe('moved');
    expect(await retiredVerbMessage('restart')).not.toContain('myco cutover');
    const before = snapshot(path.join(home, 'groves'));
    const backups = snapshot(path.join(home, 'backups'));
    await run(['--yes'], deps());
    expect(process.exitCode).toBe(0);
    expect((fs.existsSync(path.join(user, '.claude', 'settings.json')) ? fs.readFileSync(path.join(user, '.claude', 'settings.json'), 'utf8') : '')).not.toContain('--credential');
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run(['--purge', '--yes'], deps());
      expect(process.exitCode).toBe(0);
      expect(snapshot(path.join(home, 'groves'))).toEqual(before);
      expect(snapshot(path.join(home, 'backups'))).toEqual(backups);
      expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toBe('legacy settings');
      expect(fs.readdirSync(path.join(home, 'member'))).toEqual(['cutover.json']);
      expect(legacyMigrationState(home).state).toBe('moved');
      await run(['--purge', '--yes'], deps());
      expect(process.exitCode).toBe(0);
      expect(legacyMigrationState(home).state).toBe('moved');
      const message = output.mock.calls.flat().join('\n');
      expect(message).toContain('Check backups/cutover-* before deleting them by hand');
      expect(message).not.toContain('myco login');
    } finally { output.mockRestore(); }
  });

  for (const state of ['changed', 'needs-destination'] as const) {
    it(`never suggests hand deletion while migration is ${state}`, async () => {
      member();
      const fixture = legacyFixtureHome(path.join(root, 'legacy'));
      const vault = path.join(home, 'groves', 'fixture', 'myco.db');
      fs.mkdirSync(path.dirname(vault), { recursive: true });
      fs.copyFileSync(fixture.vault, vault);
      const stamp = fs.statSync(vault);
      const receipt = {
        version: 2, backups: { [vault]: { copy: path.join(home, 'backups', 'cutover-fixture'), counts: {}, digest: readVaultContent(vault).digest, at: 1 } },
        handover: { at: 1, legacyHomes: [home], agents: [] },
        ...(state === 'changed' ? { migrations: { [vault]: { digest: readVaultContent(vault).digest, size: stamp.size, mtimeMs: stamp.mtimeMs, projects: Object.fromEntries(fixture.projects.map(p => [p.id, { destination: { skip: true, at: 1 } }])) } } } : {}),
      };
      write('member/cutover.json', JSON.stringify(receipt));
      fs.chmodSync(path.join(home, 'member', 'cutover.json'), 0o600);
      if (state === 'changed') {
        const db = new Database(vault);
        try { db.run("UPDATE sessions SET title = 'retained capture after cutover'"); } finally { db.close(); }
        fs.utimesSync(vault, new Date(), new Date(stamp.mtimeMs + 1000));
      }
      expect(legacyMigrationState(home).state).toBe(state);
      const before = fs.readFileSync(vault);
      const output = spyOn(console, 'log').mockImplementation(() => {});
      try {
        for (const args of [['--yes'], ['--purge', '--yes']]) {
          await run(args, deps());
          expect(process.exitCode).toBe(0);
          const message = output.mock.calls.flat().join('\n');
          expect(message).toContain('myco cutover --dry-run');
          expect(message).not.toContain('deleting them by hand');
          if (state === 'changed') expect(message).toContain('Myco 1.4 wrote more data after migration');
          expect(fs.readFileSync(vault)).toEqual(before);
          output.mockClear();
        }
      } finally { output.mockRestore(); }
    });
  }

  for (const artifact of ['server/local/myco.sqlite', 'runner']) {
    it(`refuses a legacy home containing ${artifact} without a membership`, async () => {
      const fixture = legacyFixtureHome(path.join(root, 'legacy'));
      const file = artifact === 'runner' ? runnerRecordPath(SERVER, fixture.mycoHome) : path.join(fixture.mycoHome, artifact);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, artifact === 'runner' ? JSON.stringify({ version: 1, serverUrl: SERVER, name: 'fixture' }) : 'legacy retained data', { mode: 0o600 });
      fs.writeFileSync(path.join(fixture.mycoHome, 'install.json'), JSON.stringify({ channel: 'stable', source: 'npm', bin: fixture.binary }));
      const before = snapshot(fixture.root);
      await run(['--purge', '--allow-deployment-loss', '--yes'], { ...deps(), mycoHome: fixture.mycoHome });
      expect(process.exitCode).toBe(1);
      expect(snapshot(fixture.root)).toEqual(before);
      expect(platform.commands).toEqual([]);
    });
  }

  it('refuses a membership placed in Documents without a dedicated install marker', async () => {
    const documents = path.join(user, 'Documents');
    writeDeploymentMembership({ serverUrl: SERVER, token: 'm'.repeat(43), machineId: 'documents', joinedAt: 1, updatedAt: 1 } as never, { mycoHome: documents });
    for (const name of ['bin', 'logs', 'skills']) {
      fs.mkdirSync(path.join(documents, name), { recursive: true });
      fs.writeFileSync(path.join(documents, name, 'user-file'), 'user-owned bytes');
    }
    const before = snapshot(root);
    const error = await run(['--purge', '--yes'], { ...deps(), mycoHome: documents }).then(() => null, error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('dedicated Myco home');
    expect(error.message).toContain('Delete these by hand, or run purge from an installed home');
    for (const name of ['bin', 'logs', 'skills', 'member']) expect(error.message).toContain(path.join(documents, name));
    expect(snapshot(root)).toEqual(before);
    expect(platform.commands).toEqual([]);
  });

  it('keeps the install marker through a failed purge so the same home can retry', async () => {
    installMarker();
    write('logs/blocked/keep', 'retry me');
    const blocked = path.join(home, 'logs', 'blocked');
    fs.chmodSync(blocked, 0o500);
    try {
      await expect(run(['--purge', '--yes'], deps())).rejects.toThrow();
      expect(fs.existsSync(path.join(home, 'install.json'))).toBe(true);
      expect(fs.readFileSync(path.join(blocked, 'keep'), 'utf8')).toBe('retry me');
    } finally {
      fs.chmodSync(blocked, 0o700);
    }
    await run(['--purge', '--yes'], deps());
    expect(fs.existsSync(home)).toBe(false);
  });

  it('preserves a strict marker read failure instead of calling it a foreign marker', async () => {
    installMarker();
    const marker = path.join(home, 'install.json');
    const failure = Object.assign(new Error('marker read failed'), { code: 'EIO' });
    const read = fs.readFileSync;
    const fault = spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (String(file) === marker) throw failure;
      return Reflect.apply(read, fs, [file, ...args]);
    });
    try {
      await expect(run(['--purge', '--yes'], deps())).rejects.toBe(failure);
    } finally {
      fault.mockRestore();
    }
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('names manual removal for a foreign install marker without changing any files', async () => {
    write('install.json', JSON.stringify({ application: 'another product' }));
    write('logs/user-file', 'keep');
    const before = snapshot(home);
    await expect(run(['--purge', '--yes'], deps())).rejects.toThrow('not a Myco install marker');
    await expect(run(['--purge', '--yes'], deps())).rejects.toThrow('Delete these by hand, or run purge from an installed home');
    expect(snapshot(home)).toEqual(before);
  });

  it('admits the default home without an install marker', async () => {
    const defaultHome = path.join(user, '.myco');
    writeDeploymentMembership({ serverUrl: SERVER, token: 'm'.repeat(43), machineId: 'default-home', joinedAt: 1, updatedAt: 1 } as never, { mycoHome: defaultHome });
    await run(['--purge', '--yes'], { ...deps(), mycoHome: defaultHome });
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(defaultHome)).toBe(false);
  });

  it('unlinks an allowlisted symlink swapped during confirmation without following its target', async () => {
    member();
    write('logs/member.log', 'owned log');
    const external = path.join(root, 'external-logs');
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'user-file'), 'external bytes');
    await run(['--purge'], { ...deps(), confirm: async () => {
      fs.renameSync(path.join(home, 'logs'), path.join(root, 'saved-logs'));
      fs.symlinkSync(external, path.join(home, 'logs'), 'dir');
      return true;
    } });
    expect(process.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(external, 'user-file'), 'utf8')).toBe('external bytes');
    expect(fs.lstatSync(path.join(home, 'logs'), { throwIfNoEntry: false })).toBeUndefined();
  });

  for (const kind of ['home-swap', 'parent-swap', 'member-swap']) {
    it(`refuses a ${kind} while confirmation is pending before any teardown`, async () => {
      member();
      const victim = path.join(root, 'victim');
      fs.mkdirSync(path.join(victim, 'member'), { recursive: true });
      fs.writeFileSync(path.join(victim, 'member', 'notes.txt'), 'victim bytes');
      const bytes = snapshot(victim);
      let configured = home;
      if (kind === 'parent-swap') {
        fs.mkdirSync(path.join(victim, 'member-home', 'member'), { recursive: true });
        fs.writeFileSync(path.join(victim, 'member-home', 'member', 'notes.txt'), 'victim member bytes');
        configured = path.join(root, 'parent-alias', 'member-home');
        fs.symlinkSync(root, path.join(root, 'parent-alias'), 'dir');
      }
      await expect(run(['--purge'], { ...deps(), mycoHome: configured, confirm: async () => {
        if (kind === 'member-swap') {
          fs.renameSync(path.join(home, 'member'), path.join(root, 'saved-member'));
          fs.symlinkSync(path.join(victim, 'member'), path.join(home, 'member'), 'dir');
        } else if (kind === 'parent-swap') {
          fs.unlinkSync(path.join(root, 'parent-alias'));
          fs.symlinkSync(victim, path.join(root, 'parent-alias'), 'dir');
        } else {
          fs.renameSync(home, path.join(root, 'saved-home'));
          fs.symlinkSync(victim, home, 'dir');
        }
        return true;
      } })).rejects.toThrow('Refusing --purge');
      expect(fs.readFileSync(path.join(victim, 'member', 'notes.txt'), 'utf8')).toBe('victim bytes');
      if (kind !== 'parent-swap') expect(snapshot(victim)).toEqual(bytes);
      else expect(fs.readFileSync(path.join(victim, 'member-home', 'member', 'notes.txt'), 'utf8')).toBe('victim member bytes');
      expect(platform.commands).toEqual([]);
    });
  }

  for (const unsafe of ['user', 'ancestor', 'cwd', 'root', 'symlink-user', 'symlink-ancestor', 'symlink-parent', 'symlink-home']) {
    it(`refuses purge of ${unsafe} before any teardown`, async () => {
      member();
      const previous = process.cwd();
      let target = unsafe === 'user' ? user : unsafe === 'ancestor' ? root : unsafe === 'root' ? path.parse(root).root : home;
      if (unsafe === 'cwd') process.chdir(home);
      if (unsafe === 'symlink-parent') {
        const parent = path.join(root, 'parent-link');
        fs.symlinkSync(root, parent, 'dir');
        target = path.join(parent, 'user');
      } else if (unsafe === 'symlink-home') {
        const alias = path.join(root, 'user-alias');
        fs.symlinkSync(user, alias, 'dir');
        process.env.HOME = alias;
        target = user;
      } else if (unsafe.startsWith('symlink')) {
        target = path.join(root, 'unsafe-link');
        fs.symlinkSync(unsafe === 'symlink-user' ? user : root, target, 'dir');
      }
      if (unsafe !== 'root' && unsafe !== 'cwd') writeDeploymentMembership({ serverUrl: SERVER, token: 'm'.repeat(43), machineId: 'guard-fixture', joinedAt: 1, updatedAt: 1 } as never, { mycoHome: fs.realpathSync(target) });
      const before = snapshot(root);
      try {
        await expect(run(['--purge', '--allow-deployment-loss', '--yes'], { ...deps(), mycoHome: target })).rejects.toThrow('user home, an ancestor of it');
        expect(snapshot(root)).toEqual(before);
        expect(platform.commands).toEqual([]);
      } finally { process.chdir(previous); }
    });
  }

  it('deletes only the named 2.0 entries and lists the exact plan and retained unknown files', async () => {
    member();
    for (const entry of ['bin/myco', 'runtime.command', 'runtime.home', 'logs/member.log', 'worker/refusals/fixture', 'setup.json', 'last-update-check.json']) write(entry);
    write('unrecognized.txt', 'user document');
    write('Documents/thesis.docx', 'user research');
    let prompt = '';
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run(['--purge'], { ...deps(), confirm: async summary => { prompt = summary; return true; } });
      expect(process.exitCode).toBe(0);
      expect(fs.readFileSync(path.join(home, 'unrecognized.txt'), 'utf8')).toBe('user document');
      expect(fs.readFileSync(path.join(home, 'Documents/thesis.docx'), 'utf8')).toBe('user research');
      expect(fs.readdirSync(home).sort()).toEqual(['Documents', 'backups', 'unrecognized.txt']);
      for (const entry of ['member', 'skills', 'bin', 'install.json', 'runtime.command', 'runtime.home', 'logs', 'worker', 'setup.json', 'last-update-check.json']) expect(prompt).toContain(`DELETE ${path.join(home, entry)}`);
      expect(prompt).not.toContain('DELETE ' + path.join(home, 'Documents'));
      expect(output.mock.calls.flat().join('\n')).toContain('unrecognized.txt');
    } finally { output.mockRestore(); }
  });

  for (const osPlatform of ['darwin', 'linux', 'win32'] as const) {
    it(`refuses purge with an installed native Deployment service on ${osPlatform}`, async () => {
      member();
      const spec = defaultSpec(path.join(home, 'bin', 'myco'), user, osPlatform, home);
      const paths = servicePaths(spec, osPlatform);
      fs.mkdirSync(path.dirname(paths.unitFile), { recursive: true });
      fs.writeFileSync(paths.unitFile, renderUnit(spec, paths, osPlatform));
      const before = snapshot(root);
      await expect(run(['--purge', '--allow-deployment-loss', '--yes'], { ...deps(), worker: { ...deps().worker, platform: osPlatform } })).rejects.toThrow('myco server uninstall --target local');
      expect(snapshot(root)).toEqual(before);
      expect(platform.commands).toEqual([]);
    });
  }

  for (const osPlatform of ['darwin', 'linux', 'win32'] as const) {
    it(`preserves a foreign native Deployment service while purging this member home on ${osPlatform}`, async () => {
      member();
      const other = path.join(root, 'other-deployment');
      const spec = defaultSpec(path.join(other, 'bin', 'myco'), user, osPlatform, other);
      const paths = servicePaths(spec, osPlatform);
      fs.mkdirSync(path.dirname(paths.unitFile), { recursive: true });
      const unit = renderUnit(spec, paths, osPlatform);
      fs.writeFileSync(paths.unitFile, unit);
      await run(['--purge', '--yes'], { ...deps(), worker: { ...deps().worker, platform: osPlatform } });
      expect(process.exitCode).toBe(0);
      expect(fs.readFileSync(paths.unitFile, 'utf8')).toBe(unit);
      expect(fs.existsSync(path.join(home, 'member'))).toBe(false);
      expect(platform.commands.some(command => command.includes('myco-server'))).toBe(false);
    });
  }

  it('refuses a symlinked member parent before preserving a cutover receipt or deleting external children', async () => {
    member();
    write('config.yaml', 'legacy settings');
    const external = path.join(root, 'external-member');
    fs.renameSync(path.join(home, 'member'), external);
    fs.writeFileSync(path.join(external, 'cutover.json'), JSON.stringify({ backups: {} }), { mode: 0o600 });
    fs.writeFileSync(path.join(external, 'personal-document'), 'preserve external bytes');
    fs.symlinkSync(external, path.join(home, 'member'), 'dir');
    const before = snapshot(root);
    await expect(run(['--purge', '--yes'], deps())).rejects.toThrow('symlinked');
    expect(snapshot(root)).toEqual(before);
    expect(platform.commands).toEqual([]);
  });

  for (const osPlatform of ['darwin', 'linux', 'win32'] as const) {
    it(`refuses the native service for a physical alias of this home on ${osPlatform}`, async () => {
      member();
      write('server/local/myco.sqlite', 'deployment bytes');
      const alias = path.join(root, 'home-alias');
      fs.symlinkSync(home, alias, 'dir');
      const spec = defaultSpec(path.join(home, 'bin', 'myco'), user, osPlatform, alias);
      const paths = servicePaths(spec, osPlatform);
      fs.mkdirSync(path.dirname(paths.unitFile), { recursive: true });
      fs.writeFileSync(paths.unitFile, renderUnit(spec, paths, osPlatform));
      const before = snapshot(root);
      await expect(run(['--purge', '--allow-deployment-loss', '--yes'], { ...deps(), worker: { ...deps().worker, platform: osPlatform } })).rejects.toThrow('myco server uninstall --target local');
      expect(snapshot(root)).toEqual(before);
      expect(platform.commands).toEqual([]);
    });
  }

  it('refuses ambiguous native service ownership before any teardown', async () => {
    member();
    const spec = defaultSpec(path.join(home, 'bin', 'myco'), user, 'darwin', home);
    const unit = servicePaths(spec, 'darwin').unitFile;
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '<key>MYCO_HOME</key><string>relative-home</string>');
    const before = snapshot(root);
    await expect(run(['--purge', '--yes'], deps())).rejects.toThrow('Cannot establish which home');
    expect(snapshot(root)).toEqual(before);
    expect(platform.commands).toEqual([]);
  });

  it('refuses a registered Windows server task even when its XML file is missing', async () => {
    member();
    platform.loaded.add('myco-server');
    const before = snapshot(root);
    await expect(run(['--purge', '--allow-deployment-loss', '--yes'], { ...deps(), worker: { ...deps().worker, platform: 'win32' } })).rejects.toThrow('myco server uninstall --target local');
    expect(snapshot(root)).toEqual(before);
    expect(platform.commands.every(command => command.startsWith('schtasks /Query') || command.startsWith('powershell.exe'))).toBe(true);
  });

  it('a repeated purge preserves retained backups', async () => {
    member();
    await run(['--purge', '--yes'], deps());
    await run(['--purge', '--yes'], deps());
    expect(process.exitCode).toBe(0);
    expect(fs.readdirSync(home)).toEqual(['backups']);
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
    installMarker();
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
    if (artifact.includes('cloudflare')) {
      const message = deploymentLosses(home).join('\n');
      expect(message).toContain('resource identities and recovery metadata');
      expect(message).not.toContain('backup --target local');
      expect(message).toContain('myco server create --target cloudflare --account-id <id>');
      expect(message).toContain("another home's server/cloudflare/record.json");
    }
    const before = snapshot(root);
    await run(['--purge', '--yes'], deps());
    expect(process.exitCode).toBe(1);
    expect(snapshot(root)).toEqual(before);
    expect(platform.commands).toEqual([]);
  });
  it(`explicit second flag permits loss of ${artifact}`, async () => {
    installMarker();
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

it('compares win32 user homes, ancestors, cwd and roots case-insensitively', () => {
  const user = String.raw`C:\Users\Chris`;
  const cwd = String.raw`D:\Myco\Work`;
  for (const target of [String.raw`c:\USERS\CHRIS`, String.raw`C:\uSeRs`, String.raw`d:\myco\work`, 'c:/']) {
    expect(unsafePurgePath(target, [user], cwd, 'win32')).toBe(true);
  }
  expect(unsafePurgePath(String.raw`C:\Users\Chris\.myco`, [user], cwd, 'win32')).toBe(false);
});
