import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attributeLegacyUnits, stopUnit } from '@myco/member/legacy-units.js';
import { legacyWindowsUnit } from '../helpers/legacy-windows-unit.ts';

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
