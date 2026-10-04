import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestTempRun, newTestTemps, snapshotTestTemps, sweepStaleRunRoots, systemTempDirectories } from '../../scripts/test-temp-root.mjs';

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-temp-snapshot-'));
afterAll(() => fs.rmSync(parent, { recursive: true, force: true }));

describe('system temp leak snapshot', () => {
  it('reports only new test prefixes born during the run and ignores live sibling roots', () => {
    fs.mkdirSync(path.join(parent, 'myco-before'));
    fs.mkdirSync(path.join(parent, 'myco-old-birth'));
    const startedAt = Date.now() + 20;
    const before = snapshotTestTemps([parent]);
    // A pre-existing entry moved into the observed directory has an older birth time.
    before.get(parent)!.delete('myco-old-birth');
    const ownRoot = path.join(parent, 'mt-own000');
    fs.mkdirSync(ownRoot);
    fs.mkdirSync(path.join(parent, 'mt-live00'));
    fs.writeFileSync(path.join(parent, 'mt-live00', '.owner'), `${process.ppid}\n`);
    expect(newTestTemps(before, startedAt, ownRoot)).toEqual([]);
    fs.mkdirSync(path.join(parent, 'myco-new'));
    fs.mkdirSync(path.join(parent, 'mt-new'));
    fs.mkdirSync(path.join(parent, 'unrelated'));
    expect(newTestTemps(before, 0, ownRoot).sort()).toEqual([
      'mt-new', 'myco-new', 'myco-old-birth',
    ].map((name) => path.join(parent, name)).sort());
  });

  it('includes OS defaults even when TMPDIR points at the sandbox', () => {
    const dirs = systemTempDirectories();
    expect(dirs).toContain(fs.realpathSync(os.tmpdir()));
    if (process.platform !== 'win32') expect(dirs).toContain(fs.realpathSync(path.join(path.parse(parent).root, 'tmp')));
    if (process.platform !== 'win32') expect(dirs).toContain(fs.realpathSync('/var/tmp'));
    if (process.platform === 'darwin') {
      const darwinTemp = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim();
      expect(dirs).toContain(fs.realpathSync(darwinTemp));
    }
  });

  it('sweeps directories only and retains missing, malformed, inaccessible and unjudgeable owners', () => {
    const fixture = fs.mkdtempSync(path.join(parent, 'sweep-'));
    const dead = spawnSync(process.execPath, ['-e', '0']);
    expect(dead.status).toBe(0);
    fs.writeFileSync(path.join(fixture, 'mt-file00'), 'retain');
    for (const name of ['mt-dead00', 'mt-noown0', 'mt-badown', 'mt-denied', 'mt-noperm', 'mt-unknow']) fs.mkdirSync(path.join(fixture, name));
    fs.writeFileSync(path.join(fixture, 'mt-dead00', '.owner'), `${dead.pid}\n`);
    fs.writeFileSync(path.join(fixture, 'mt-badown', '.owner'), 'invalid');
    fs.writeFileSync(path.join(fixture, 'mt-denied', '.owner'), `${dead.pid}\n`);
    fs.writeFileSync(path.join(fixture, 'mt-noperm', '.owner'), `${dead.pid}\n`);
    fs.writeFileSync(path.join(fixture, 'mt-unknow', '.owner'), `${process.pid}\n`);
    const aliasTarget = path.join(fixture, 'alias-target');
    fs.mkdirSync(aliasTarget);
    fs.writeFileSync(path.join(aliasTarget, '.owner'), `${dead.pid}\n`);
    fs.symlinkSync(aliasTarget, path.join(fixture, 'mt-link00'), 'junction');
    const old = new Date(0);
    for (const name of fs.readdirSync(fixture)) fs.utimesSync(path.join(fixture, name), old, old);
    const read = fs.readFileSync.bind(fs);
    const kill = process.kill.bind(process);
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file) === path.join(fixture, 'mt-denied', '.owner')) throw Object.assign(new Error('cannot read owner'), { code: 'EACCES' });
      if (String(file) === path.join(fixture, 'mt-noperm', '.owner')) throw Object.assign(new Error('cannot read owner'), { code: 'EPERM' });
      return (read as (...args: unknown[]) => unknown)(file, ...args);
    }) as typeof fs.readFileSync);
    const killSpy = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === process.pid && signal === 0) throw Object.assign(new Error('cannot judge owner'), { code: 'EIO' });
      return kill(pid, signal);
    });
    try {
      expect(sweepStaleRunRoots(fixture)).toBe(1);
      expect(fs.readdirSync(fixture).sort()).toEqual(['alias-target', 'mt-badown', 'mt-denied', 'mt-file00', 'mt-link00', 'mt-noown0', 'mt-noperm', 'mt-unknow']);
    } finally {
      readSpy.mockRestore();
      killSpy.mockRestore();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('removes its owned root even when the leak scan fails', () => {
    const keys = ['MYCO_TEST_RUN_ROOT', 'MYCO_TEST_SYSTEM_TEMP_DIRS', 'TMPDIR', 'TEMP', 'TMP'];
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    const monitor = fs.mkdtempSync(path.join(parent, 'monitor-'));
    const run = createTestTempRun({ parent, directories: [monitor] });
    try {
      fs.rmSync(monitor, { recursive: true });
      expect(() => run.finish()).toThrow();
      expect(fs.existsSync(run.root)).toBe(false);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(run.root, { recursive: true, force: true });
    }
  });
});
