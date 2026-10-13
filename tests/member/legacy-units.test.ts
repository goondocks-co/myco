import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attributeLegacyUnits, stopUnit } from '@myco/member/legacy-units.js';
import { legacyWindowsUnit } from '../helpers/legacy-windows-unit.ts';
import { RealSchtasksRunner, WindowsTaskServiceManager } from '@myco/member/legacy-service/windows.js';
import { SERVICE_UNIT_DIR_ENV } from '@myco/paths/service-units.js';
import { assertRunSucceeded, type RawCommandOutput } from '@myco/member/legacy-service/run-command.js';

it.each(['utf8', 'utf16le', 'utf16le-bom', 'utf16be-bom'] as const)('keeps a non-ASCII %s task XML snapshot separate from scheduler warnings', async encoding => {
  const xml = '<?xml version="1.0"?><Task><Description>Myco Ω 日本語</Description></Task>';
  const utf16 = Buffer.from(xml, 'utf16le');
  const stdout = encoding === 'utf16be-bom' ? Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16).swap16()])
    : encoding === 'utf16le-bom' ? Buffer.concat([Buffer.from([0xff, 0xfe]), utf16])
    : Buffer.from(xml, encoding);
  class Runner extends RealSchtasksRunner {
    protected override async runSchtasks(args: string[]): Promise<RawCommandOutput> {
      expect(args).toEqual(['/query', '/tn', 'co.goondocks.myco.Ω', '/xml']);
      return { stdout, stderr: Buffer.from('scheduler warning'), exitCode: 0 };
    }
  }
  const saved = process.env[SERVICE_UNIT_DIR_ENV];
  delete process.env[SERVICE_UNIT_DIR_ENV];
  try {
    const result = await new Runner().run(['/query', '/tn', 'co.goondocks.myco.Ω', '/xml']);
    expect(result).toEqual({ stdout: xml, stderr: 'scheduler warning', exitCode: 0 });
    expect(() => assertRunSucceeded({ ...result, exitCode: 1 }, 'query')).toThrow(/scheduler warning/);
  } finally {
    if (saved === undefined) delete process.env[SERVICE_UNIT_DIR_ENV]; else process.env[SERVICE_UNIT_DIR_ENV] = saved;
  }
});

it('includes each non-XML scheduler diagnostic once', async () => {
  class Runner extends RealSchtasksRunner {
    protected override async runSchtasks(): Promise<RawCommandOutput> {
      return { stdout: Buffer.from('out'), stderr: Buffer.from('diagnostic'), exitCode: 1 };
    }
  }
  const saved = process.env[SERVICE_UNIT_DIR_ENV];
  delete process.env[SERVICE_UNIT_DIR_ENV];
  try {
    const result = await new Runner().run(['/change', '/tn', 'fixture', '/disable']);
    expect(result).toEqual({ stdout: 'outdiagnostic', exitCode: 1 });
    expect(() => assertRunSucceeded(result, 'change')).toThrow('change failed (exit 1): outdiagnostic');
  } finally {
    if (saved === undefined) delete process.env[SERVICE_UNIT_DIR_ENV]; else process.env[SERVICE_UNIT_DIR_ENV] = saved;
  }
});

it('surfaces a task inspection error reported only on stderr', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-query-'));
  const task = legacyWindowsUnit(dir, dir);
  task.runner.run = async () => ({ stdout: '', stderr: 'task provider unavailable', exitCode: 1 });
  await expect(new WindowsTaskServiceManager({ scriptDir: dir, runner: task.runner }).inspect(task.label))
    .rejects.toThrow(/task provider unavailable/);
});

it('deduplicates Windows launchers discovered with different path casing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-case-'));
  const dir = path.join(root, 'CaseUnits');
  const alias = path.join(root, 'caseunits');
  const task = legacyWindowsUnit(dir, root);
  if (!fs.existsSync(alias)) fs.symlinkSync(dir, alias, 'junction');
  const attribution = attributeLegacyUnits([{ dir, scope: 'user' }, { dir: alias, scope: 'user' }], [root.toUpperCase()], 'win32');
  expect(attribution.stop.map(unit => unit.file)).toEqual([task.file]);
});

it('accepts an encoded launcher path with different Windows casing and escaped apostrophes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myco-legacy-O'Brien-"));
  const task = legacyWindowsUnit(dir, dir);
  await new WindowsTaskServiceManager({ scriptDir: dir, runner: task.runner })
    .unregisterAfterDrain(task.label, task.file.toUpperCase(), async () => { task.exit(); return 'stopped'; }, () => {});
  expect(task.calls).toContainEqual(['/delete', '/tn', task.label, '/f']);
});

it('refuses a different encoded launcher or appended PowerShell code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-action-'));
  const task = legacyWindowsUnit(dir, dir);
  const manager = new WindowsTaskServiceManager({ scriptDir: dir, runner: task.runner });
  await expect(manager.unregisterAfterDrain(task.label, task.file + '.other', async () => 'stopped', () => {})).rejects.toThrow(/does not belong/);
  const encoded = Buffer.from(`& '${task.file}'; Write-Output 'extra'`, 'utf16le').toString('base64');
  task.runner.run = async () => ({ stdout: task.xml.replace(/-EncodedCommand [A-Za-z0-9+/=]+/, `-EncodedCommand ${encoded}`), exitCode: 0 });
  await expect(manager.unregisterAfterDrain(task.label, task.file, async () => 'stopped', () => {})).rejects.toThrow(/does not belong/);
  const relative = path.win32.basename(task.file);
  const relativeEncoded = Buffer.from(`& '${relative}'`, 'utf16le').toString('base64');
  task.runner.run = async () => ({ stdout: task.xml.replace(/-EncodedCommand [A-Za-z0-9+/=]+/, `-EncodedCommand ${relativeEncoded}`), exitCode: 0 });
  await expect(manager.unregisterAfterDrain(task.label, path.win32.resolve(relative), async () => 'stopped', () => {})).rejects.toThrow(/does not belong/);
});

it('refuses a drive-root-relative task action for a drive-qualified launcher', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-drive-'));
  const task = legacyWindowsUnit(dir, dir);
  const currentDrive = path.win32.parse(process.cwd()).root.slice(0, 2);
  const drive = /^[A-Za-z]:$/.test(currentDrive) ? currentDrive : 'C:';
  const launcher = drive + '\\Myco\\co.goondocks.myco.ps1';
  const encoded = Buffer.from("& '\\Myco\\co.goondocks.myco.ps1'", 'utf16le').toString('base64');
  task.runner.run = async () => ({ stdout: task.xml.replace(/-EncodedCommand [A-Za-z0-9+/=]+/, `-EncodedCommand ${encoded}`), exitCode: 0 });
  await expect(new WindowsTaskServiceManager({ scriptDir: dir, runner: task.runner })
    .unregisterAfterDrain(task.label, launcher, async () => 'stopped', () => {})).rejects.toThrow(/does not belong/);
});

it('attributes Windows daemon launchers and unregisters only after a cooperative stop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-unit-'));
  const home = path.join(dir, 'legacy');
  const task = legacyWindowsUnit(dir, home);
  const foreign = legacyWindowsUnit(dir, path.join(dir, 'foreign'), 'co.goondocks.myco.foreign');
  const attribution = attributeLegacyUnits([{ dir, scope: 'user' }, { dir, scope: 'user' }], [home]);
  expect(attribution.stop.map(unit => unit.file)).toEqual([task.file]);
  await stopUnit(attribution.stop[0], 'win32', undefined, {
    runner: task.runner,
    backupTask: (label, xml) => { expect(label).toBe(task.label); expect(xml).toBe(task.xml); expect(task.calls.some(args => args[0] === '/change')).toBe(false); },
    stopDaemon: async target => {
      expect(target).toBe(home);
      expect(task.calls.at(-1)).toEqual(['/change', '/tn', task.label, '/disable']);
      task.exit();
      return 'stopped';
    },
  });
  expect(task.calls).toContainEqual(['/delete', '/tn', task.label, '/f']);
  expect(fs.existsSync(task.file)).toBe(false);
  expect(fs.readFileSync(foreign.file, 'utf8')).toBe(foreign.script);
});

it('retains the Windows launcher and refuses unregistering a daemon that did not drain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-refusal-'));
  const task = legacyWindowsUnit(dir, dir);
  const [unit] = attributeLegacyUnits([{ dir, scope: 'user' }], [dir]).stop;
  await expect(stopUnit(unit, 'win32', undefined, { runner: task.runner, backupTask: () => {}, stopDaemon: async () => 'none' }))
    .rejects.toThrow(/did not confirm shutdown/);
  expect(task.calls.some(args => args[0] === '/delete')).toBe(false);
  expect(fs.readFileSync(task.file, 'utf8')).toBe(task.script);
});

it('leaves a task owned by another user untouched even beside an attributed launcher', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-foreign-task-'));
  const task = legacyWindowsUnit(dir, dir);
  const [unit] = attributeLegacyUnits([{ dir, scope: 'user' }], [dir]).stop;
  task.runner.currentUserSid = async () => 'S-1-5-21-other';
  await expect(stopUnit(unit, 'win32', undefined, { runner: task.runner, backupTask: () => {}, stopDaemon: async () => 'stopped' }))
    .rejects.toThrow(/does not belong/);
  expect(task.calls.every(args => args[0] === '/query')).toBe(true);
  expect(fs.readFileSync(task.file, 'utf8')).toBe(task.script);
});

it('refuses Windows removal before touching the task when its backup owner is absent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-backup-'));
  const task = legacyWindowsUnit(dir, dir);
  const [unit] = attributeLegacyUnits([{ dir, scope: 'user' }], [dir]).stop;
  await expect(stopUnit(unit, 'win32', undefined, { runner: task.runner, stopDaemon: async () => 'stopped' }))
    .rejects.toThrow(/requires a Task Scheduler backup/);
  expect(task.calls).toEqual([]);
  expect(fs.readFileSync(task.file, 'utf8')).toBe(task.script);
});
