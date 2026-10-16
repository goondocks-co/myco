import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { retiredHookSettings } from '@myco/symbionts/retired-hook-settings.js';
import { claimSubsystem, releaseSubsystemClaim, resolveClaimsHome, SYMBIONT_CONFIG_SUBSYSTEM } from '@myco/member/subsystem-claim.js';
import { SymbiontManifestSchema } from '@myco/symbionts/manifest-schema.js';
import { MemberProvisionConflictError, SymbiontInstaller } from '@myco/symbionts/installer.js';
import { provisionGlobally, provisionBackup, provisionAgents, runProvision } from '@myco/cli/member.js';
import { keepCurrent } from '@myco/cli/member-keep-current.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { getPluginVersion } from '@myco/version.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { logoutDeployment } from '@myco/symbionts/logout-runtime.js';
import { recordingPlatform } from '../helpers/fake-service-manager.js';
import { recordProvision, readProvisionRecord } from '@myco/symbionts/member-provision-record.js';

const SERVER = 'https://myco.example';
const KEY = 'chat.tools.terminal.autoApprove';
const VALUE = { myco: true, 'myco-dev': true };
const saved = { HOME: process.env.HOME, MYCO_HOME: process.env.MYCO_HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
let home: string;
let memberHome: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-settings-targets-'));
  memberHome = path.join(home, 'myco');
  Object.assign(process.env, { HOME: home, MYCO_HOME: memberHome, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config') });
  writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome: memberHome });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(home, { recursive: true, force: true });
});
const manifest = (name: string) => loadManifests().find(m => m.name === name)!;
const hooksFile = (name: string) => path.join(home, manifest(name).registration!.globalHooksTarget!.slice(2));
const install = (name: string) => provisionGlobally(name, null, memberHome, { serverUrl: SERVER });
function seed(name: string, value: unknown): { file: string; before: string; expected: string } {
  install(name);
  const file = hooksFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { hooks: { user: [{ command: 'user-hook' }] } };
  data.user = { unicode: '🍄', text: 'a,b{c}\\"d', nested: { [KEY]: VALUE } };
  const expected = JSON.stringify(data, null, '\t') + '\n\n';
  const entry = `"${KEY}" : ${JSON.stringify(value)},`;
  const before = expected.replace('{', '{' + entry);
  fs.writeFileSync(file, before);
  return { file, before, expected };
}

it.each(['cursor', 'copilot'])('provisioning %s writes hooks without terminal approval settings', name => {
  install(name);
  const file = hooksFile(name);
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  expect(Object.hasOwn(data, KEY)).toBe(false);
  expect(new SymbiontInstaller(manifest(name), home, resolvePackageRoot(), false, memberHome).installSettings()).toBe(false);
  expect(manifest(name).registration?.settingsTarget).toBeNull();
  expect(manifest(name).registration?.globalSettingsTarget).toBeNull();
});

it.each(['cursor', 'copilot'])('refresh migrates %s exact values with byte preservation, backup and idempotence', name => {
  const { file, before, expected } = seed(name, VALUE);
  expect(runProvision(['--refresh'], { mycoHome: memberHome, cwd: home })).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toBe(expected);
  const backups = fs.readdirSync(path.join(memberHome, 'backups')).flatMap(folder => {
    const record = JSON.parse(fs.readFileSync(path.join(memberHome, 'backups', folder, 'manifest.json'), 'utf8'));
    return record.entries.filter((entry: { original: string }) => entry.original === file);
  });
  expect(backups).toHaveLength(1);
  expect(fs.readFileSync(backups[0].backup, 'utf8')).toBe(before);
  const stat = fs.statSync(file);
  const backup = provisionBackup(memberHome);
  provisionGlobally(name, null, memberHome, { serverUrl: SERVER, backup });
  expect(backup.pruneUnchanged()).toHaveLength(0);
  expect(fs.readFileSync(file, 'utf8')).toBe(expected);
  expect(fs.statSync(file).mtimeMs).toBe(stat.mtimeMs);
  expect(fs.statSync(file).ino).toBe(stat.ino);
});

it.each(['cursor', 'copilot'])('keep-current migrates %s even when its hooks are already current', name => {
  const { file, expected } = seed(name, VALUE);
  recordProvision(memberHome, { version: getPluginVersion(), serverUrl: SERVER, agents: [name] }, { replace: true });
  const current = keepCurrent(memberHome, { binaryFound: binary => binary === name });
  if (name === 'cursor') expect(current?.harnesses).toContainEqual(expect.objectContaining({ id: name, state: 'ready' }));
  else expect(current?.harnesses).toEqual([]);
  expect(fs.readFileSync(file, 'utf8')).toBe(expected);
});

it.each(['cursor', 'copilot'])('keeps %s user-changed values and reports them once across installer instances', name => {
  const { file, before } = seed(name, { ...VALUE, myco: false });
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    install(name);
    install(name);
    keepCurrent(memberHome, { binaryFound: binary => binary === name });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(KEY);
    expect(warn.mock.calls[0][0]).toContain(file);
  } finally { warn.mockRestore(); }
});

it('all manifest settings targets are distinct from hooks unless their schema combines both', () => {
  const settingsFiles: Record<string, [string | null, string | null]> = {
    'claude-code': ['.claude/settings.json', '~/.claude/settings.json'],
    codex: ['.codex/config.toml', '~/.codex/config.toml'],
    opencode: ['opencode.json', null],
  };
  for (const agent of loadManifests()) {
    const reg = agent.registration;
    expect({ agent: agent.name, targets: [reg?.settingsTarget ?? null, reg?.globalSettingsTarget ?? null] }).toEqual({ agent: agent.name, targets: settingsFiles[agent.name] ?? [null, null] });
    for (const [settings, hooks] of [[reg?.settingsTarget, reg?.hooksTarget], [reg?.globalSettingsTarget, reg?.globalHooksTarget]]) {
      if (settings != null && settings === hooks) expect({ agent: agent.name, combined: reg?.hooksContainSettings }).toEqual({ agent: agent.name, combined: true });
    }
  }
});

it('Claude Code installs settings and hooks in its declared combined file', () => {
  install('claude-code');
  const data = JSON.parse(fs.readFileSync(hooksFile('claude-code'), 'utf8'));
  const member = new SymbiontInstaller(manifest('claude-code'), home, resolvePackageRoot(), false, memberHome);
  expect(manifest('claude-code').registration?.hooksContainSettings).toBe(true);
  expect(data.permissions).toEqual(member.loadTemplate('settings')?.permissions);
  expect(Object.keys(data.hooks).length).toBeGreaterThan(0);
});

it.each([
  ['{ "user":"🍄", "chat.tools.terminal.autoApprove":{"myco":true,"myco-dev":true} }', '{ "user":"🍄"  }'],
  ['{ "chat.tools.terminal.autoApprove":{"myco":true,"myco-dev":true} }', '{  }'],
])('removes a trailing or sole settings entry without rewriting other bytes', (raw, expected) => {
  expect(retiredHookSettings(raw, { [KEY]: VALUE })).toEqual({ text: expected, conflicts: [] });
});

it('refuses ambiguous duplicate keys and malformed JSON before migration writes', () => {
  expect(() => retiredHookSettings(`{"${KEY}":false,"${KEY}":${JSON.stringify(VALUE)}}`, { [KEY]: VALUE })).toThrow();
  expect(() => retiredHookSettings(`{"${KEY}":`, { [KEY]: VALUE })).toThrow();
});

it('a healthy reconciliation preserves existing backup history', () => {
  const { file } = seed('copilot', VALUE);
  keepCurrent(memberHome, { binaryFound: () => false });
  expect(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), KEY)).toBe(false);
  const backups = path.join(memberHome, 'backups');
  for (let index = 0; index < 10; index++) fs.mkdirSync(path.join(backups, `member-provision-old-${index}`), { recursive: true });
  const before = fs.readdirSync(backups).sort();
  keepCurrent(memberHome, { binaryFound: () => false });
  expect(fs.readdirSync(backups).sort()).toEqual(before);
});

function copilotFile(raw: string): string {
  const file = hooksFile('copilot');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw);
  return file;
}

it.each(['{"hooks":{"a":1,"a":2}}', '\ufeff{"hooks":{}}', `{"note":"${KEY}","hooks":{"a":1,"a":2}}`, `{"nested":{"${KEY}":false},"a":1,"a":2}`])('ignores unowned Copilot syntax without a retired key through keep-current and refresh (%s)', raw => {
  install('claude-code');
  const file = copilotFile(raw);
  expect(new SymbiontInstaller(manifest('copilot'), home, resolvePackageRoot(), false, memberHome).retiredHookSettingsCurrent()).toBe(true);
  const claude = hooksFile('claude-code');
  for (const run of [() => keepCurrent(memberHome, { binaryFound: () => true }), () => runProvision(['--refresh'], { mycoHome: memberHome, cwd: home })]) {
    fs.unlinkSync(claude);
    expect(run).not.toThrow();
    expect(JSON.parse(fs.readFileSync(claude, 'utf8')).hooks).toBeDefined();
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    expect(JSON.parse(fs.readFileSync(path.join(memberHome, 'member/harness-states.json'), 'utf8'))['claude-code'].state).toBe('ready');
  }
});

it.each(['{"x":1,"x":2,', '\ufeff{'])('isolates ambiguous retired Copilot settings and reports its file once (%s)', prefix => {
  install('claude-code');
  const file = copilotFile(prefix + `"${KEY}":${JSON.stringify(VALUE)}}`);
  const before = fs.readFileSync(file, 'utf8');
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    fs.unlinkSync(hooksFile('claude-code'));
    expect(() => keepCurrent(memberHome, { binaryFound: () => true })).not.toThrow();
    expect(() => runProvision(['--refresh'], { mycoHome: memberHome, cwd: home })).not.toThrow();
    expect(() => runProvision(['claude-code', '--server', SERVER], { mycoHome: memberHome, cwd: home })).not.toThrow();
    expect(() => provisionAgents(['claude-code'], memberHome, SERVER, null)).not.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(JSON.parse(fs.readFileSync(path.join(memberHome, 'member/harness-states.json'), 'utf8'))['claude-code'].state).toBe('ready');
    const reports = [...stderr.mock.calls, ...warn.mock.calls].filter(([text]) => String(text).includes(file));
    expect(reports).toHaveLength(1);
    expect(String(reports[0][0])).toContain('Copilot');
  } finally { stderr.mockRestore(); warn.mockRestore(); }
});

it('isolates a peer claim refusal per file through keep-current and refresh', () => {
  install('claude-code');
  const file = copilotFile(JSON.stringify({ [KEY]: VALUE }));
  const before = fs.readFileSync(file, 'utf8');
  claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, path.join(home, 'peer'), { claimsHome: resolveClaimsHome() });
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(() => keepCurrent(memberHome, { binaryFound: () => true })).not.toThrow();
    expect(() => runProvision(['--refresh'], { mycoHome: memberHome, cwd: home })).not.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(JSON.parse(fs.readFileSync(path.join(memberHome, 'member/harness-states.json'), 'utf8'))['claude-code'].state).toBe('repair_failed');
    expect([...stderr.mock.calls, ...warn.mock.calls].filter(([text]) => String(text).includes(file))).toHaveLength(1);
  } finally { stderr.mockRestore(); warn.mockRestore(); }
});

it('isolates an unreadable retired settings file with a typed named refusal', () => {
  install('claude-code');
  const file = copilotFile(JSON.stringify({ [KEY]: VALUE }));
  const read = fs.readFileSync;
  const fail = spyOn(fs, 'readFileSync').mockImplementation(((name: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(name) === file) throw Object.assign(new Error('fixture unreadable'), { code: 'EACCES' });
    return Reflect.apply(read, fs, [name, ...args]);
  }) as typeof fs.readFileSync);
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const member = new SymbiontInstaller(manifest('copilot'), home, resolvePackageRoot(), false, memberHome);
    expect(() => member.retiredHookSettingsCurrent()).toThrow(MemberProvisionConflictError);
    expect(() => member.retiredHookSettingsCurrent()).toThrow(file);
    fs.unlinkSync(hooksFile('claude-code'));
    expect(() => keepCurrent(memberHome, { binaryFound: () => true })).not.toThrow();
    expect(() => runProvision(['--refresh'], { mycoHome: memberHome, cwd: home })).not.toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(memberHome, 'member/harness-states.json'), 'utf8'))['claude-code'].state).toBe('ready');
    expect(stderr.mock.calls.filter(([text]) => String(text).includes(file))).toHaveLength(1);
  } finally { fail.mockRestore(); stderr.mockRestore(); }
});

it('keeps Cursor duplicate-key tolerance when the retired key is absent', () => {
  install('cursor');
  const file = hooksFile('cursor');
  const raw = fs.readFileSync(file, 'utf8').replace('{', '{"user":1,"user":2,');
  fs.writeFileSync(file, raw);
  expect(() => keepCurrent(memberHome, { binaryFound: () => true })).not.toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  expect(JSON.parse(fs.readFileSync(path.join(memberHome, 'member/harness-states.json'), 'utf8')).cursor.state).toBe('ready');
});

it('gives a typed named refusal for ambiguous Cursor settings with a retired key', () => {
  install('cursor');
  const file = hooksFile('cursor');
  const raw = fs.readFileSync(file, 'utf8').replace('{', `{"user":1,"user":2,"${KEY}":${JSON.stringify(VALUE)},`);
  fs.writeFileSync(file, raw);
  const member = new SymbiontInstaller(manifest('cursor'), home, resolvePackageRoot(), false, memberHome);
  expect(() => member.retiredHookSettingsCurrent()).toThrow(MemberProvisionConflictError);
  expect(() => member.retiredHookSettingsCurrent()).toThrow(file);
  expect(fs.readFileSync(file, 'utf8')).toBe(raw);
});

it('rejects normalized shared settings paths through the manifest schema', () => {
  for (const [settings, hooks] of [['~/.cursor/./hooks.json', '~/.cursor/hooks.json'], ['.cursor/./hooks.json', '.cursor/hooks.json']]) {
    const agent = manifest('cursor');
    expect(() => SymbiontManifestSchema.parse({ ...agent, registration: { ...agent.registration, settingsTarget: settings, hooksTarget: hooks, globalSettingsTarget: settings, globalHooksTarget: hooks } })).toThrow(/hooksContainSettings/);
  }
});

it.each(['cursor', 'copilot'])('reports each distinct %s user value only once without pruning backup history', name => {
  const { file, before } = seed(name, { myco: false });
  const backups = path.join(memberHome, 'backups');
  for (let index = 0; index < 10; index++) fs.mkdirSync(path.join(backups, `member-provision-old-${index}`), { recursive: true });
  const prior = fs.readdirSync(backups).sort();
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    keepCurrent(memberHome, { binaryFound: () => true });
    keepCurrent(memberHome, { binaryFound: () => true });
    expect(fs.readdirSync(backups).sort()).toEqual(prior);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    const data = JSON.parse(before); data[KEY] = { '*': true };
    fs.writeFileSync(file, JSON.stringify(data));
    keepCurrent(memberHome, { binaryFound: () => true });
    keepCurrent(memberHome, { binaryFound: () => true });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[KEY]).toEqual({ '*': true });
  } finally { warn.mockRestore(); }
});

it.each(['uninstall', 'logout'])('removes exact retired Cursor settings on %s before a helper pass', action => {
  const { file } = seed('cursor', VALUE);
  const member = new SymbiontInstaller(manifest('cursor'), home, resolvePackageRoot(), false, memberHome).withoutProjectRoot().forDeployment(SERVER);
  if (action === 'uninstall') member.uninstallMemberRegistration();
  else member.reconcileDeploymentLogout(SERVER, null, false);
  expect(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), KEY)).toBe(false);
});

it('removes adjacent retired keys at the end without losing remaining bytes', () => {
  expect(retiredHookSettings('{"a":1,"k1":true,"k2":true}', { k1: true, k2: true }).text).toBe('{"a":1}');
  expect(retiredHookSettings('{"k1":true,"k2":true}', { k1: true, k2: true }).text).toBe('{}');
});

it('removes complete retired entry lines while preserving every other byte', () => {
  const raw = '{\r\n\t"a": 1,\r\n\t"k1": {\r\n\t\t"myco": true\r\n\t},\r\n\t"b": 2\r\n}\r\n';
  expect(retiredHookSettings(raw, { k1: { myco: true } }).text).toBe('{\r\n\t"a": 1,\r\n\t"b": 2\r\n}\r\n');
});

it('reports ambiguous captured Cursor settings once while recording its failure and repairing Claude', () => {
  install('cursor');
  install('claude-code');
  const file = hooksFile('cursor');
  const raw = fs.readFileSync(file, 'utf8').replace('{', `{"user":1,"user":2,"${KEY}":${JSON.stringify(VALUE)},`);
  fs.writeFileSync(file, raw);
  fs.unlinkSync(hooksFile('claude-code'));
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(() => keepCurrent(memberHome, { binaryFound: () => true })).not.toThrow();
    expect(() => runProvision(['--refresh'], { mycoHome: memberHome, cwd: home })).not.toThrow();
    const states = JSON.parse(fs.readFileSync(path.join(memberHome, 'member/harness-states.json'), 'utf8'));
    expect(states.cursor.state).toBe('repair_failed');
    expect(states.cursor.localAction).toContain(file);
    expect(states['claude-code'].state).toBe('ready');
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    expect([...stderr.mock.calls, ...warn.mock.calls].filter(([text]) => String(text).includes(file))).toHaveLength(1);
  } finally { stderr.mockRestore(); warn.mockRestore(); }
});


it.each([['\ufeff{', true], ['{"x":1,"x":2,', true], ['\ufeff{', false], ['{"x":1,"x":2,', false]] as const)('logout reconciles every agent and provision record past Copilot cleanup (%s, retired key: %s)', async (prefix, retired) => {
  const next = 'https://next.example';
  writeDeploymentMembership({ serverUrl: next, token: 'B'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome: memberHome });
  recordDefaultDeployment(SERVER, { mycoHome: memberHome });
  install('claude-code');
  install('cursor');
  const file = copilotFile(prefix + (retired ? `"${KEY}":${JSON.stringify(VALUE)}}` : '"user":true}'));
  const before = fs.readFileSync(file, 'utf8');
  const reconcile = spyOn(SymbiontInstaller.prototype, 'reconcileDeploymentLogout');
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await logoutDeployment(SERVER, { mode: 'revoke' }, { home, mycoHome: memberHome, packageRoot: resolvePackageRoot(), worker: { platform: 'darwin', runner: recordingPlatform().runner }, fetch: async () => Response.json({ persisted: true, revoked: 1 }) });
    expect(reconcile).toHaveBeenCalledTimes(loadManifests().length);
    expect(reconcile.mock.calls.every(([, , keepHooks]) => keepHooks)).toBe(true);
    expect(readProvisionRecord(memberHome)?.serverUrl).toBe(next);
    expect(readProvisionRecord(memberHome)?.agents).toEqual(expect.arrayContaining(['claude-code', 'cursor']));
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(warn.mock.calls.filter(([text]) => String(text).includes(file))).toHaveLength(Number(retired));
    const cursor = new SymbiontInstaller(manifest('cursor'), home, resolvePackageRoot(), false, memberHome).withoutProjectRoot();
    expect(cursor.inspectMemberMcp().some(entry => entry.present)).toBe(true);
  } finally { reconcile.mockRestore(); warn.mockRestore(); }
});

it.each(['remove', 'logout-keep', 'logout-remove'])('continues %s despite ambiguous retired Cursor cleanup', action => {
  install('cursor');
  const file = hooksFile('cursor');
  const raw = fs.readFileSync(file, 'utf8').replace('{', `{"user":1,"user":2,"${KEY}":${JSON.stringify(VALUE)},`);
  fs.writeFileSync(file, raw);
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const out: string[] = [];
  try {
    if (action === 'remove') {
      expect(runProvision(['--remove', 'cursor'], { mycoHome: memberHome, cwd: home, stdout: text => out.push(text), stderr: text => out.push(text) })).toBe(true);
      expect(readProvisionRecord(memberHome)?.agents).not.toContain('cursor');
    } else {
      const member = new SymbiontInstaller(manifest('cursor'), home, resolvePackageRoot(), false, memberHome).withoutProjectRoot();
      expect(() => member.reconcileDeploymentLogout(SERVER, action === 'logout-keep' ? 'https://next.example' : null, action === 'logout-keep')).not.toThrow();
    }
    expect(warn.mock.calls.filter(([text]) => String(text).includes(file))).toHaveLength(1);
    expect(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), KEY)).toBe(true);
    const member = new SymbiontInstaller(manifest('cursor'), home, resolvePackageRoot(), false, memberHome).withoutProjectRoot();
    expect(member.inspectMemberHooks().member).toBe(action === 'logout-keep');
    expect(member.inspectMemberMcp().some(entry => entry.present)).toBe(action === 'logout-keep');
  } finally { warn.mockRestore(); }
});

it.each(['absent-key', 'absent-file', 'reported-value'])('clears a retired settings problem after a healthy %s pass so it can recur', healthy => {
  const { file, expected } = seed('copilot', VALUE);
  const owner = path.join(home, 'peer');
  const claimsHome = resolveClaimsHome();
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, owner, { claimsHome });
    keepCurrent(memberHome, { binaryFound: () => false });
    const reportFile = path.join(memberHome, 'installer-audit/copilot-retired-hook-settings.json');
    expect(JSON.parse(fs.readFileSync(reportFile, 'utf8')).problem).toContain(file);
    releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, owner, { claimsHome });
    if (healthy === 'absent-file') fs.unlinkSync(file);
    else if (healthy === 'absent-key') fs.writeFileSync(file, expected);
    else fs.writeFileSync(file, JSON.stringify({ [KEY]: { myco: false } }));
    keepCurrent(memberHome, { binaryFound: () => false });
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    expect(report.problem).toBeUndefined();
    if (healthy === 'reported-value') expect(report.values[KEY]).toHaveLength(1);
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, owner, { claimsHome });
    fs.writeFileSync(file, JSON.stringify({ [KEY]: VALUE }));
    keepCurrent(memberHome, { binaryFound: () => false });
    expect([...warn.mock.calls, ...stderr.mock.calls].filter(([text]) => String(text).includes(file) && String(text).includes('Could not reconcile'))).toHaveLength(2);
  } finally { warn.mockRestore(); stderr.mockRestore(); }
});

it('parses manifests without resolving or validating HOME', () => {
  const agent = manifest('cursor');
  const savedRoot = process.env.MYCO_SANDBOX_ROOT;
  process.env.MYCO_SANDBOX_ROOT = path.join(home, 'sandbox-without-home');
  try {
    expect(() => SymbiontManifestSchema.parse({ ...agent, registration: { ...agent.registration, globalSettingsTarget: '~/.cursor/settings.json' } })).not.toThrow();
    expect(() => SymbiontManifestSchema.parse({ ...agent, registration: { ...agent.registration, globalSettingsTarget: '~/.cursor/./hooks.json' } })).toThrow(/hooksContainSettings/);
  } finally { if (savedRoot === undefined) delete process.env.MYCO_SANDBOX_ROOT; else process.env.MYCO_SANDBOX_ROOT = savedRoot; }
});

it('cleans exact output and reports changed values for Cursor without a 2.0 registration', () => {
  const file = hooksFile('cursor');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ [KEY]: VALUE, user: true }));
  keepCurrent(memberHome, { binaryFound: () => false });
  expect(fs.readFileSync(file, 'utf8')).toBe('{"user":true}');
  fs.writeFileSync(file, JSON.stringify({ [KEY]: { myco: false }, user: true }));
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    keepCurrent(memberHome, { binaryFound: () => false });
    keepCurrent(memberHome, { binaryFound: () => false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[KEY]).toEqual({ myco: false });
    expect(readProvisionRecord(memberHome)).toBeNull();
  } finally { warn.mockRestore(); }
});
