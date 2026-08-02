/**
 * TS↔CJS contract agreement: `bin/binary-resolution.cjs` (npm tarball shims)
 * and `src/runtime/binary-resolution.ts` (compiled binary) version
 * independently, so both are driven through the same scenarios and must
 * produce identical results.
 */

import { afterEach, describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as ts from '@myco/runtime/binary-resolution.js';

const cjs = createRequire(import.meta.url)(
  path.resolve('packages/myco/bin/binary-resolution.cjs'),
) as typeof import('@myco/runtime/binary-resolution.js') & {
  managedBinaryPath: (home: string, platform: string, lad?: string) => string;
  managedBinDir: (home: string, platform: string, lad?: string) => string;
  readLayeredPin: (from?: string) => { pin: string; pinPath: string; pinScope: string } | null;
};

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-agree-'));
  tmpDirs.push(dir);
  return dir;
}

describe('managed layout agreement', () => {
  const cases: Array<[string, NodeJS.Platform, string | undefined]> = [
    ['/home/u/.myco', 'linux', undefined],
    ['/Users/u/.myco-dev', 'darwin', undefined],
    ['C:\\ignored', 'win32', 'C:\\Users\\u\\AppData\\Local'],
  ];
  for (const [home, platform, lad] of cases) {
    it(`${platform}: identical binary path and bin dir`, () => {
      expect(cjs.managedBinaryPath(home, platform, lad)).toBe(
        ts.gatherFacts({ kind: 'machine' }, { mycoHome: home, platform, localAppData: lad }).managedBinary,
      );
      expect(cjs.managedBinDir(home, platform, lad)).toBe(
        ts.gatherFacts({ kind: 'machine' }, { mycoHome: home, platform, localAppData: lad }).binDir,
      );
    });
  }

  it('win32 LOCALAPPDATA-absent fallback agrees', () => {
    const fromCjs = cjs.managedBinaryPath('C:\\ignored', 'win32', undefined);
    const fromTs = ts.gatherFacts(
      { kind: 'machine' },
      { mycoHome: 'C:\\ignored', platform: 'win32', localAppData: undefined },
    ).managedBinary;
    expect(fromCjs).toBe(fromTs);
    expect(fromCjs).toContain(path.win32.join('Myco', 'bin', 'myco.exe'));
  });
});

describe('pin trust agreement', () => {
  it('same verdicts across the mode matrix', () => {
    const home = tmpdir();
    const pinPath = path.join(home, 'runtime.command');
    fs.writeFileSync(pinPath, '/x/myco\n');
    for (const mode of [0o644, 0o600, 0o664, 0o666, 0o622]) {
      fs.chmodSync(pinPath, mode);
      const fromTs = ts.checkPinTrust(pinPath, {});
      const fromCjs = cjs.checkPinTrust(pinPath);
      expect(fromCjs.ok, `mode 0${mode.toString(8)}`).toBe(fromTs.ok);
    }
    expect(cjs.checkPinTrust(path.join(home, 'absent')).ok).toBe(
      ts.checkPinTrust(path.join(home, 'absent'), {}).ok,
    );
  });

  it('same mask constant', () => {
    expect((cjs as unknown as { PIN_INSECURE_MODE_MASK: number }).PIN_INSECURE_MODE_MASK).toBe(0o022);
  });
});

describe('layered pin agreement', () => {
  it('identical project-over-machine layering and scope labels', () => {
    const home = tmpdir();
    const project = tmpdir();
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    const projectPin = path.join(project, '.myco', 'runtime.command');
    fs.writeFileSync(projectPin, '/project/myco\n', { mode: 0o644 });
    fs.chmodSync(projectPin, 0o644);
    const machinePin = path.join(home, 'runtime.command');
    fs.writeFileSync(machinePin, '/machine/myco\n', { mode: 0o644 });
    fs.chmodSync(machinePin, 0o644);

    const saved = process.env.MYCO_HOME;
    process.env.MYCO_HOME = home;
    try {
      const fromTs = ts.readLayeredPin({ kind: 'walk-up', from: project }, { mycoHome: home });
      const fromCjs = cjs.readLayeredPin(project);
      expect(fromCjs).toEqual(fromTs);
      expect(cjs.readLayeredPin(undefined)).toEqual(
        ts.readLayeredPin({ kind: 'machine' }, { mycoHome: home }),
      );
    } finally {
      if (saved === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = saved;
    }
  });
});

describe('runnable + bare name agreement', () => {
  it('identical executability verdicts', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'myco');
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o644 });
    expect(cjs.isRunnableBinary(file)).toBe(ts.isRunnableBinary(file, {}));
    fs.chmodSync(file, 0o755);
    expect(cjs.isRunnableBinary(file)).toBe(ts.isRunnableBinary(file, {}));
    expect(cjs.isRunnableBinary(dir)).toBe(ts.isRunnableBinary(dir, {}));
  });

  it('identical bare names', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as NodeJS.Platform[]) {
      expect(cjs.bareCommandName(platform)).toBe(ts.bareCommandName(platform));
    }
  });
});
