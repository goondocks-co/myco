import { deriveSymbiontManifest } from '../helpers/symbiont-manifest.js';
import { hookCommands } from '@myco/symbionts/member-hooks.js';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { tempMycoHome } from '../member/helpers/server.js';
import { claimSubsystem, releaseSubsystemClaim, resolveClaimsHome, SYMBIONT_CONFIG_SUBSYSTEM } from '@myco/member/subsystem-claim.js';

let root: string;
let home: string;
let savedHome: string | undefined;
let mycoHome: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-global-project-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-global-agent-'));
  mycoHome = tempMycoHome();
  savedHome = process.env.HOME;
  process.env.HOME = home;
  writeRegistryEntry({ version: REGISTRY_VERSION, root, projectId: 'proj_1', serverUrl: 'https://myco.example', token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
const installer = (name: string) => new SymbiontInstaller(loadManifests().find((m) => m.name === name)!, root, resolvePackageRoot(), false, mycoHome);

describe('settings ownership recovery and restoration', () => {
  it.each(['codex', 'claude-code'])('rolls back %s ownership when writing user settings fails', (name) => {
    const member = installer(name);
    const target = path.join(home, name === 'codex' ? '.codex/config.toml' : '.claude/settings.json');
    const audit = path.join(mycoHome, 'installer-audit', `${name}-global-settings.json`);
    const open = fs.openSync;
    const failing = spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file).startsWith(target + '.tmp-')) throw Object.assign(new Error('settings write denied'), { code: 'EACCES' });
      return open(file, flags, mode);
    });
    try { expect(() => member.installSettings()).toThrow(/settings write denied/); }
    finally { failing.mockRestore(); }
    expect(fs.existsSync(audit)).toBe(false);
    const user = name === 'codex' ? '[features]\nhooks = true\n' : JSON.stringify(member.loadTemplate('settings'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, user);
    expect(member.uninstallSettings()).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe(user);
  });
  it('captures new user settings when an installer is reused after uninstall', () => {
    const member = installer('claude-code');
    member.install();
    member.uninstallMemberRegistration();
    const target = path.join(home, '.claude/settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{}');
    member.install();
    member.uninstallMemberRegistration();
    expect(fs.readFileSync(target, 'utf8')).toBe('{}');
  });
  it('preserves the first scalar value through a changed-value reinstall', () => {
    const target = path.join(home, '.claude/settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{"features":{"hooks":false}}');
    const member = installer('claude-code');
    const load = spyOn(member, 'loadTemplate').mockReturnValue({ features: { hooks: true } });
    try {
      member.installSettings();
      fs.writeFileSync(target, '{"features":{"hooks":"user edit"}}');
      member.installSettings();
      member.uninstallSettings();
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ features: { hooks: false } });
    } finally { load.mockRestore(); }
  });
  it('does not restore array entries the user removed after install', () => {
    const target = path.join(home, '.claude/settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{"permissions":{"allow":["user"]}}');
    const member = installer('claude-code');
    const load = spyOn(member, 'loadTemplate').mockReturnValue({ permissions: { allow: ['myco'] } });
    try {
      member.installSettings();
      fs.writeFileSync(target, '{"permissions":{"allow":["myco"]}}');
      member.uninstallSettings();
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ permissions: { allow: [] } });
    } finally { load.mockRestore(); }
  });
  it('does not recreate a settings file the user removed after install', () => {
    const target = path.join(home, '.claude/settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{}');
    const member = installer('claude-code');
    member.installSettings();
    fs.unlinkSync(target);
    member.uninstallSettings();
    expect(fs.existsSync(target)).toBe(false);
  });
  it.each(['codex', 'claude-code'])('refuses %s installation before user writes if ownership cannot be persisted', (name) => {
    const member = installer(name);
    const audit = path.join(mycoHome, 'installer-audit', `${name}-global-settings.json`);
    const open = fs.openSync;
    const failing = spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file).startsWith(audit + '.tmp-')) throw Object.assign(new Error('audit write denied'), { code: 'EACCES' });
      return open(file, flags, mode);
    });
    try {
      expect(() => member.install()).toThrow(/audit write denied/);
      expect(member.memberGlobalTargets().all.filter(file => fs.existsSync(file))).toEqual([]);
    } finally { failing.mockRestore(); }
  });
  it('retires ownership durably when the audit cannot be unlinked', () => {
    const member = installer('codex');
    member.install();
    const audit = path.join(mycoHome, 'installer-audit/codex-global-settings.json');
    const unlink = fs.unlinkSync;
    const failing = spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (String(file) === audit) throw Object.assign(new Error('audit unlink denied'), { code: 'EACCES' });
      return unlink(file);
    });
    try {
      member.uninstallSettings();
      expect(JSON.parse(fs.readFileSync(audit, 'utf8'))).toMatchObject({ schema: 1, wroteKeys: [] });
    } finally { failing.mockRestore(); }
  });
  it('treats an unreadable internal audit as owning nothing and names the recovery', () => {
    const member = installer('codex');
    member.install();
    const audit = path.join(mycoHome, 'installer-audit/codex-global-settings.json');
    const read = fs.readFileSync;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const failing = spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file) === audit) throw Object.assign(new Error('unreadable fixture'), { code: 'EACCES' });
      return Reflect.apply(read, fs, [file, ...args]);
    }) as typeof fs.readFileSync);
    try {
      expect(() => member.uninstallMemberRegistration()).not.toThrow();
      expect(fs.existsSync(audit)).toBe(false);
      expect(warn.mock.calls.flat().join(' ')).toContain(audit);
      expect(warn.mock.calls.flat().join(' ')).toContain('owns no settings');
      expect(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8')).toContain('hooks = true');
    } finally { failing.mockRestore(); warn.mockRestore(); }
  });
  it.each([
    { schema: 2, format: 'json', scalars: [null], arrayEntries: [] },
    { schema: 2, format: 'json', scalars: [{ path: ['permissions'], value: {}, previous: null }], arrayEntries: [] },
    { schema: 2, format: 'json', scalars: [], arrayEntries: [], file: { existed: true, emptyText: '{"user": "value"}' } },
  ])('recovers a structurally corrupt JSON audit without deleting settings: %j', (audit) => {
    const member = installer('claude-code');
    member.install();
    const target = path.join(home, '.claude/settings.json');
    const permissions = JSON.parse(fs.readFileSync(target, 'utf8')).permissions;
    fs.writeFileSync(path.join(mycoHome, 'installer-audit/claude-code-global-settings.json'), JSON.stringify(audit));
    expect(() => member.uninstallMemberRegistration()).not.toThrow();
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).permissions).toEqual(permissions);
  });
  it.each([{ features: { hooks: false } }, { permissions: { allow: [] } }])('restores JSON prior values byte-identically: %j', (user) => {
    const target = path.join(home, '.claude/settings.json');
    const original = JSON.stringify(user, null, 2) + '\n';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, original);
    const member = installer('claude-code');
    const template = 'features' in user ? { features: { hooks: true } } : { permissions: { allow: ['Bash(myco *)'] } };
    const load = spyOn(member, 'loadTemplate').mockReturnValue(template);
    try { member.installSettings(); member.installSettings(); member.uninstallSettings(); }
    finally { load.mockRestore(); }
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
  });
  it.each(['codex', 'claude-code'])('recovers a truncated %s audit without removing unowned settings', (name) => {
    const member = installer(name);
    member.install();
    const audit = path.join(mycoHome, 'installer-audit', `${name}-global-settings.json`);
    fs.writeFileSync(audit, '{');
    expect(() => member.uninstallMemberRegistration()).not.toThrow();
    expect(fs.existsSync(audit)).toBe(false);
    expect(() => member.install()).not.toThrow();
    fs.writeFileSync(audit, '{');
    expect(() => member.install()).not.toThrow();
    expect(() => JSON.parse(fs.readFileSync(audit, 'utf8'))).not.toThrow();
  });
  it.each(['codex', 'claude-code'])('restores the prior %s settings bytes after reinstall and uninstall', (name) => {
    const target = path.join(home, name === 'codex' ? '.codex/config.toml' : '.claude/settings.json');
    const original = name === 'codex' ? '# user preference\n[features]\n hooks=false # user choice\n\n[projects.personal]\ntrust_level = "trusted"\n' : '{}';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, original);
    const member = installer(name);
    member.install();
    member.install();
    member.uninstallMemberRegistration();
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
  });
  it('restores the prior settings when the last Deployment logs out', () => {
    const target = path.join(home, '.codex/config.toml');
    const original = '[features]\nhooks = false\n';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, original);
    const member = installer('codex');
    member.install();
    member.reconcileDeploymentLogout('https://myco.example', null, false);
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(mycoHome, 'installer-audit', 'codex-global-settings.json'))).toBe(false);
  });
});

describe('global member installation', () => {
  it('checks the selected member home claim when the ambient home differs', () => {
    const previousHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = home;
    try {
      claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'peer', { claimsHome: resolveClaimsHome() });
      expect(() => installer('codex').install()).toThrow(/claimed by another installation/);
      expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
    } finally {
      releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, 'peer', { claimsHome: resolveClaimsHome() });
      if (previousHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = previousHome;
    }
  });

  it('refuses a peer claim before writing and accepts the selected member home owner', () => {
    try {
      claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'peer');
      expect(() => installer('codex').install()).toThrow(/claimed by another installation/);
      expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
      releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, 'peer');
      claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome);
      expect(installer('codex').install().hooks).toBe(true);
    } finally {
      releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome);
    }
  });

  it('preserves every project hook while provisioning global commands', () => {
    const target = path.join(root, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const legacy = { command: '/opt/myco hook stop --myco-managed' };
    const foreign = { command: 'other-hook --credential registry' };
    const member = { command: '/opt/myco hook stop --credential registry --myco-managed' };
    fs.writeFileSync(target, JSON.stringify({ hooks: { Stop: [{ hooks: [legacy, foreign, member] }], SessionStart: [legacy, member] } }));
    installer('codex').install();
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).hooks).toEqual({ Stop: [{ hooks: [legacy, foreign, member] }], SessionStart: [legacy, member] });
  });

  it('installs Codex hooks, enables hooks, and writes remote MCP globally without project configuration', () => {
    const target = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'model = "mine"\n[features]\nhooks = false\n[mcp_servers.other]\ncommand = "other"\n');
    expect(installer('codex').install().hooks).toBe(true);
    const config = parseToml(fs.readFileSync(target, 'utf8'));
    expect(config.model).toBe('mine');
    expect(config.features).toEqual({ hooks: true });
    expect(config.mcp_servers).toMatchObject({ other: { command: 'other' }, myco: { url: 'https://myco.example/mcp' } });
    expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
    const installed = fs.readFileSync(target, 'utf8');
    expect(installer('codex').install()).toMatchObject({ hooks: false, mcp: false });
    expect(fs.readFileSync(target, 'utf8')).toBe(installed);
  });

  it('preserves unrelated Claude hooks and settings while writing its user-wide MCP file', () => {
    const target = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const foreign = { hooks: [{ type: 'command', command: 'other-hook' }] };
    fs.writeFileSync(target, JSON.stringify({ model: 'mine', hooks: { Stop: [foreign] } }));
    installer('claude-code').install();
    const config = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(config.model).toBe('mine');
    expect(config.hooks.Stop).toContainEqual(foreign);
    expect(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers.myco.url).toBe('https://myco.example/mcp');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('provisions globally while leaving unreadable repository configuration untouched', () => {
    const localConfig = path.join(root, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(localConfig), { recursive: true });
    fs.writeFileSync(localConfig, '[mcp_servers.myco');
    expect(installer('codex').install().hooks).toBe(true);
    expect(fs.readFileSync(localConfig, 'utf8')).toBe('[mcp_servers.myco');
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(true);
  });

  it('refuses an unclassified global capture installation before writing either registration', () => {
    const target = path.join(home, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: '/opt/myco hook stop --myco-managed' }] }] } });
    fs.writeFileSync(target, original);
    expect(() => installer('codex').install()).toThrow(/Run myco doctor to check which installation owns capture/);
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(home, '.codex', 'config.toml'))).toBe(false);
  });

  it('installs member plugins globally and leaves the project untouched', () => {
    for (const name of ['opencode', 'pi']) {
      expect(installer(name).install().hooks).toBe(true);
      expect(installer(name).install().hooks).toBe(false);
    }
    expect(fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'myco.ts'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.pi', 'agent', 'extensions', 'myco', 'index.ts'))).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});


describe('member-global lifecycle contracts', () => {
  for (const manifest of loadManifests().filter(manifest => manifest.registration?.memberHooksTarget)) {
    it(`${manifest.name}: installs, stays current, is idempotent and removes its registration`, () => {
      const member = installer(manifest.name).forDeployment('https://srv.example');
      const snapshot = () => Object.fromEntries(member.memberGlobalTargets().all
        .filter(file => fs.existsSync(file)).map(file => [file, fs.readFileSync(file, 'utf8')]));
      member.install();
      expect(member.isConfigured()).toBe(true);
      expect(member.memberRegistrationCurrent()).toBe(true);
      const first = snapshot();
      expect(Object.keys(first).length).toBeGreaterThan(0);
      member.install();
      expect(snapshot()).toEqual(first);
      member.uninstallMemberRegistration();
      expect(member.memberRegistrationPresent()).toBe(false);
      expect(Object.values(snapshot()).join('\n')).not.toContain('--credential');
    });
  }

  it('forward-slashes a backslash binary path in installed member hooks', () => {
    fs.writeFileSync(path.join(mycoHome, 'runtime.command'), 'C:\\Program\\myco\\bin\\myco.exe\n');
    installer('claude-code').install();
    const commands = hookCommands(JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain('C:/Program/myco/bin/myco.exe');
      expect(command).not.toContain('\\');
    }
  });

  it('refuses a whitespace binary path before writing member registration', () => {
    fs.writeFileSync(path.join(mycoHome, 'runtime.command'), '/Users/My Name/.myco/bin/myco\n');
    const member = installer('claude-code');
    expect(() => member.install()).toThrow(/whitespace/);
    expect(member.memberGlobalTargets().all.filter(file => fs.existsSync(file))).toEqual([]);
  });
});


it('refuses unreadable settings before removing any member registration', () => {
  const base = loadManifests().find(manifest => manifest.name === 'codex')!;
  const manifest = deriveSymbiontManifest(base, { registration: { ...base.registration!,
    settingsTarget: '.codex/member-settings.json', globalSettingsTarget: '~/.codex/member-settings.json', settingsFormat: 'json',
  } });
  const member = new SymbiontInstaller(manifest, root, resolvePackageRoot(), false, mycoHome);
  member.install();
  const settings = path.join(home, '.codex/member-settings.json');
  fs.writeFileSync(settings, '{broken');
  const snapshot = () => Object.fromEntries(member.memberGlobalTargets().all.filter(file => fs.existsSync(file))
    .map(file => [file, fs.readFileSync(file, 'utf8')]));
  const before = snapshot();
  expect(() => member.uninstallMemberRegistration()).toThrow(/could not read/);
  expect(snapshot()).toEqual(before);
});

it('keeps a user-modified setting and clears its installation audit on removal', () => {
  const member = installer('codex');
  member.install();
  const file = path.join(home, '.codex/config.toml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('hooks = true', 'hooks = false'));
  member.uninstallMemberRegistration();
  expect(parseToml(fs.readFileSync(file, 'utf8')).features).toEqual({ hooks: false });
  expect(fs.existsSync(path.join(mycoHome, 'installer-audit/codex-global-settings.json'))).toBe(false);
});

it('clears a JSON audit when every owned setting has already been replaced', () => {
  const member = installer('claude-code');
  member.install();
  const file = path.join(home, '.claude/settings.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.permissions = { allow: ['Bash(custom)'] };
  fs.writeFileSync(file, JSON.stringify(config));
  member.uninstallMemberRegistration();
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).permissions).toEqual({ allow: ['Bash(custom)'] });
  expect(fs.existsSync(path.join(mycoHome, 'installer-audit/claude-code-global-settings.json'))).toBe(false);
});
