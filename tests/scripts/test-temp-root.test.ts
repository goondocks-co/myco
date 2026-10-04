import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newTestTemps, snapshotTestTemps, systemTempDirectories } from '../../scripts/test-temp-root.mjs';

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
  });
});
