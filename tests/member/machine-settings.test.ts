/**
 * The settings a Deployment holds for this machine, as the machine caches them (#1393): one file per Deployment,
 * beside its membership, never read as a membership, and never cleared by an answer that carries none.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cacheMachineSettings, machinePlanDirs, beginMachineSettingsRequest, machineSettingsHeaders, forgetConnectRoot } from '@myco/member/machine-settings.js';
import { MACHINE_SETTINGS_FEATURE, MACHINE_SETTINGS_REVISION_HEADER, MACHINE_SETTINGS_INVALIDATED_HEADER, MACHINE_SETTINGS_ORDER_HEADER } from '@goondocks/myco-shared/member-protocol';
import { listDeploymentMemberships, machineSettingsPath } from '@myco/member/registry.js';
import { tempMycoHome } from './helpers/server.js';

const revision = (counter: number) => `m${counter}-${'a'.repeat(64)}`;

function runMachineChild(home: string, script: string): string {
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), MYCO_HOME: home },
  });
  expect(child.status).toBe(0);
  return child.stdout.trim();
}

function requestInAnotherProcess(server: string, home: string, now: number): number {
  const source = pathToFileURL(path.join(process.cwd(), 'packages/myco/src/member/machine-settings.ts')).href;
  const script = `import { beginMachineSettingsRequest } from ${JSON.stringify(source)}; Date.now = () => ${now}; console.log(beginMachineSettingsRequest(${JSON.stringify(server)}, ${JSON.stringify(home)}));`;
  const stamp = Number(runMachineChild(home, script));
  expect(Number.isSafeInteger(stamp)).toBe(true);
  return stamp;
}

function answerInAnotherProcess(server: string, home: string, stamp: number, folder: string): boolean {
  const source = pathToFileURL(path.join(process.cwd(), 'packages/myco/src/member/machine-settings.ts')).href;
  const script = `import { cacheMachineSettings } from ${JSON.stringify(source)}; console.log(cacheMachineSettings(${JSON.stringify(server)}, { leaves: { 'capture.plan_dirs': [${JSON.stringify(folder)}] } }, ${JSON.stringify(home)}, ${stamp}));`;
  return runMachineChild(home, script) === 'true';
}

describe('the machine settings cache', () => {
  it('keeps one file per Deployment, each untouched by the other, and none read as a membership', () => {
    const home = tempMycoHome();
    expect(cacheMachineSettings('https://one.example', { leaves: { 'capture.plan_dirs': ['a/plans'] } }, home)).toBe(true);
    expect(cacheMachineSettings('https://two.example/', { leaves: { 'capture.plan_dirs': ['~/b'] } }, home)).toBe(true);
    expect({ one: machinePlanDirs('https://one.example', home), two: machinePlanDirs('https://two.example', home) }).toEqual({ one: ['a/plans'], two: ['~/b'] });
    expect(listDeploymentMemberships(home)).toEqual([]);
    expect((fs.statSync(machineSettingsPath('https://one.example', home)).mode & 0o777).toString(8)).toBe('600');
  });

  it('leaves the cache as it was on an answer that carries no settings, and reads defaults where it has none', () => {
    const home = tempMycoHome();
    expect(machinePlanDirs('https://one.example', home)).toEqual([]);
    cacheMachineSettings('https://one.example', { leaves: { 'capture.plan_dirs': ['a/plans'] } }, home);
    for (const answer of [undefined, null, 'x', { leaves: null }, { leaves: [] }]) expect(cacheMachineSettings('https://one.example', answer, home)).toBe(false);
    expect(machinePlanDirs('https://one.example', home)).toEqual(['a/plans']);
  });

  it('is written whole or not at all: a sibling file renamed onto it, never the file itself opened for writing', () => {
    const home = tempMycoHome();
    const target = machineSettingsPath('https://one.example', home);
    cacheMachineSettings('https://one.example', { leaves: { 'capture.plan_dirs': ['old/plans'] } }, home);
    const writes = spyOn(fs, 'writeFileSync');
    const renames = spyOn(fs, 'renameSync');
    try {
      cacheMachineSettings('https://one.example', { leaves: { 'capture.plan_dirs': ['new/plans'] } }, home);
      const written = writes.mock.calls.map((c) => String(c[0]));
      const renamed = renames.mock.calls.map((c) => [String(c[0]), String(c[1])]).filter((pair) => pair[1] === target);
      expect(written).not.toContain(target);
      expect(renamed).toHaveLength(1);
      expect(renamed[0]![1]).toBe(target);
      expect({ dir: path.dirname(renamed[0]![0]), staged: written.includes(renamed[0]![0]) }).toEqual({ dir: path.dirname(target), staged: true });
    } finally {
      writes.mockRestore();
      renames.mockRestore();
    }
    expect(machinePlanDirs('https://one.example', home)).toEqual(['new/plans']);
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the newest requested settings when responses race, while accepting a later restored revision', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    const earlier = beginMachineSettingsRequest(server, home);
    const later = beginMachineSettingsRequest(server, home);
    const block = (revision: string, folder: string) => ({ feature: MACHINE_SETTINGS_FEATURE, revision, leaves: { 'capture.plan_dirs': [folder] } });
    expect(cacheMachineSettings(server, block(revision(2), 'new/plans'), home, later)).toBe(true);
    expect(cacheMachineSettings(server, block(revision(1), 'old/plans'), home, earlier)).toBe(false);
    expect(machinePlanDirs(server, home)).toEqual(['new/plans']);
    expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_REVISION_HEADER]).toBe(revision(2));
    expect(cacheMachineSettings(server, block(revision(0), 'restored/plans'), home, beginMachineSettingsRequest(server, home))).toBe(true);
    expect(machinePlanDirs(server, home)).toEqual(['restored/plans']);
  });

  it('publishes the cached generation and keeps requests ordered when its advisory sidecar cannot be written', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    const earlier = beginMachineSettingsRequest(server, home);
    const later = beginMachineSettingsRequest(server, home);
    const rename = fs.renameSync;
    const writes = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('.order')) throw new Error('order write failed');
      return rename(from, to);
    });
    try {
      expect(cacheMachineSettings(server, { feature: MACHINE_SETTINGS_FEATURE, revision: revision(2), leaves: { 'capture.plan_dirs': ['new/plans'] } }, home, later)).toBe(true);
      const newest = beginMachineSettingsRequest(server, home);
      expect(beginMachineSettingsRequest(server, home)).toBeGreaterThan(newest);
    } finally { writes.mockRestore(); }
    expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_ORDER_HEADER]).toBe(String(later));
    expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_REVISION_HEADER]).toBe(revision(2));
    expect(cacheMachineSettings(server, { feature: MACHINE_SETTINGS_FEATURE, revision: revision(1), leaves: { 'capture.plan_dirs': ['old/plans'] } }, home, earlier)).toBe(false);
    expect(machinePlanDirs(server, home)).toEqual(['new/plans']);
    expect(beginMachineSettingsRequest(server, home)).toBeGreaterThan(later);
  });

  it('still reports a failure to publish the actual settings cache', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    const file = machineSettingsPath(server, home);
    const realRename = fs.renameSync;
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === file) throw new Error('settings cache write failed');
      return realRename(from, to);
    });
    try {
      expect(() => cacheMachineSettings(server, { leaves: { 'capture.plan_dirs': ['new/plans'] } }, home)).toThrow('settings cache write failed');
    } finally { rename.mockRestore(); }
  });

  it('still stamps requests when the advisory order path cannot be replaced', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    const orderFile = `${machineSettingsPath(server, home)}.order`;
    fs.mkdirSync(path.dirname(orderFile), { recursive: true, mode: 0o700 });
    fs.mkdirSync(orderFile, { mode: 0o700 });
    const first = beginMachineSettingsRequest(server, home);
    expect(beginMachineSettingsRequest(server, home)).toBeGreaterThan(first);
    expect(fs.statSync(orderFile).isDirectory()).toBe(true);
  });

  it('uses the cached generation when the advisory order file is corrupt', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    const earlier = beginMachineSettingsRequest(server, home);
    const later = beginMachineSettingsRequest(server, home);
    cacheMachineSettings(server, { feature: MACHINE_SETTINGS_FEATURE, revision: revision(2), leaves: { 'capture.plan_dirs': ['new/plans'] } }, home, later);
    const orderFile = `${machineSettingsPath(server, home)}.order`;
    fs.writeFileSync(orderFile, '{"issued":');
    expect(cacheMachineSettings(server, { feature: MACHINE_SETTINGS_FEATURE, revision: revision(1), leaves: { 'capture.plan_dirs': ['old/plans'] } }, home, earlier)).toBe(false);
    expect(machinePlanDirs(server, home)).toEqual(['new/plans']);
    expect(beginMachineSettingsRequest(server, home)).toBeGreaterThan(later);
  });

  it('keeps responses ordered across processes when the primary file is corrupt', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    const file = machineSettingsPath(server, home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ leaves: { 'capture.plan_dirs': ['cached/plans'] }, cachedOrder: 95 }), { mode: 0o600 });
    fs.writeFileSync(`${file}.order`, '{"issued":', { mode: 0o600 });
    const newRequest = requestInAnotherProcess(server, home, Date.now());
    const newAnswer = { leaves: { 'capture.plan_dirs': ['new/plans'] } };
    expect(newRequest).toBeGreaterThan(100);
    expect(answerInAnotherProcess(server, home, 100, 'old/plans')).toBe(true);
    expect(machinePlanDirs(server, home)).toEqual(['old/plans']);
    expect(cacheMachineSettings(server, newAnswer, home, newRequest)).toBe(true);
    expect(answerInAnotherProcess(server, home, 100, 'old/plans')).toBe(false);
    expect(machinePlanDirs(server, home)).toEqual(['new/plans']);
  });

  it('keeps an older successful answer when a newer request never answers', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    const file = machineSettingsPath(server, home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ leaves: { 'capture.plan_dirs': ['cached/plans'] }, cachedOrder: 95 }), { mode: 0o600 });
    fs.writeFileSync(`${file}.order`, '{"issued":', { mode: 0o600 });
    const newerRequest = requestInAnotherProcess(server, home, Date.now());
    expect(newerRequest).toBeGreaterThan(100);
    expect(answerInAnotherProcess(server, home, 100, 'old/plans')).toBe(true);
    expect(machinePlanDirs(server, home)).toEqual(['old/plans']);
  });

  it('keeps increasing request stamps across processes when the primary order file is corrupt', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    const now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    let first: number;
    try { first = beginMachineSettingsRequest(server, home); }
    finally { clock.mockRestore(); }
    fs.writeFileSync(`${machineSettingsPath(server, home)}.order`, '{"issued":', { mode: 0o600 });
    const second = requestInAnotherProcess(server, home, now);
    expect(second).toBeGreaterThan(first);
  });

  it('refuses to issue a request when neither advisory sidecar can save its stamp', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    const file = machineSettingsPath(server, home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.mkdirSync(`${file}.order`, { mode: 0o700 });
    fs.mkdirSync(`${file}.order-checkpoint`, { mode: 0o700 });
    expect(() => beginMachineSettingsRequest(server, home)).toThrow('Cannot persist machine settings request order.');
  });

  it('logs a damaged advisory order once until its state changes', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    beginMachineSettingsRequest(server, home);
    const orderFile = `${machineSettingsPath(server, home)}.order`;
    fs.writeFileSync(orderFile, '{"issued":');
    const realRename = fs.renameSync;
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === orderFile) throw new Error('order write failed');
      return realRename(from, to);
    });
    const writes = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const first = beginMachineSettingsRequest(server, home);
      expect(beginMachineSettingsRequest(server, home)).toBeGreaterThan(first);
      expect(writes.mock.calls.filter(([message]) => String(message).includes('machine settings answer order reset'))).toHaveLength(1);
    } finally { rename.mockRestore(); }
    try {
      beginMachineSettingsRequest(server, home);
      beginMachineSettingsRequest(server, home);
      fs.writeFileSync(orderFile, '{"issued":');
      beginMachineSettingsRequest(server, home);
      expect(writes.mock.calls.filter(([message]) => String(message).includes('machine settings answer order reset'))).toHaveLength(3);
    } finally { writes.mockRestore(); }
  });

  it('never reports a cached revision without the Deployment feature and withdraws it after a local disconnect', () => {
    const home = tempMycoHome();
    const server = 'https://one.example';
    for (const feature of [undefined, 'unknown-feature']) {
      cacheMachineSettings(server, { feature, revision: revision(1), leaves: { 'capture.plan_dirs': ['plans'] } }, home);
      expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_REVISION_HEADER]).toBeUndefined();
    }
    const root = 'a'.repeat(64);
    const block = { feature: MACHINE_SETTINGS_FEATURE, revision: revision(1), leaves: { 'capture.connect_roots': { [root]: 'proj_1' } } };
    cacheMachineSettings(server, block, home);
    const request = beginMachineSettingsRequest(server, home);
    expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_REVISION_HEADER]).toBe(revision(1));
    forgetConnectRoot(server, root, home);
    expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_INVALIDATED_HEADER]).toBe('1');
    expect(machineSettingsHeaders(server, home)[MACHINE_SETTINGS_REVISION_HEADER]).toBeUndefined();
    expect(cacheMachineSettings(server, block, home, request)).toBe(false);
  });

  it('reads no folder the Deployment would refuse, whatever the file holds', () => {
    const home = tempMycoHome();
    cacheMachineSettings('https://one.example', { leaves: { 'capture.plan_dirs': ['/', '~', '~/', '.', '../up', 'docs/plans', '~/notes'] } }, home);
    expect(machinePlanDirs('https://one.example', home)).toEqual(['docs/plans', '~/notes']);
  });
});
