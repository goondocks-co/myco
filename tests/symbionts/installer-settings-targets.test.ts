import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { retiredHookSettings } from '@myco/symbionts/retired-hook-settings.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { provisionGlobally, provisionBackup, runProvision } from '@myco/cli/member.js';
import { keepCurrent } from '@myco/cli/member-keep-current.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { getPluginVersion } from '@myco/version.js';
import { recordProvision } from '@myco/symbionts/member-provision-record.js';

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
  expect(() => retiredHookSettings('{"hooks":', { [KEY]: VALUE })).toThrow();
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
