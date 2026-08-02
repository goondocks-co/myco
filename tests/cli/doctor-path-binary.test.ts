/**
 * PATH-ownership doctor check.
 *
 * Regression origin: `npm update -g` re-extracted the retired
 * `@goondocks/myco` npm package, discarding the postinstall-generated
 * dispatch file it needs. The leftover shim stayed first on PATH and
 * hard-exited on every invocation while the managed binary sat healthy at
 * `~/.myco/bin/myco`. Nothing in doctor compared the two, so the break was
 * invisible until every command failed.
 */

import { afterEach, describe, it, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyPathBinary } from '@myco/cli/doctor';
import { DOCTOR_FIXERS } from '@myco/cli/doctor-fixes';
import type { DoctorCheck, DoctorFixContext } from '@myco/cli/doctor-fixes';

const MANAGED = '/home/u/.myco/bin/myco';
const BIN_DIR = '/home/u/.myco/bin';

/** Base args for the healthy case; each test overrides only what it exercises. */
function args(overrides: Partial<Parameters<typeof classifyPathBinary>[0]> = {}) {
  return {
    managedBinary: MANAGED,
    managedExists: true,
    binDir: BIN_DIR,
    pathBinary: MANAGED,
    pin: null,
    platform: 'linux' as NodeJS.Platform,
    realpath: (target: string) => target,
    ...overrides,
  };
}

describe('classifyPathBinary', () => {
  it('emits no row when the managed binary is absent (source build / pre-convergence)', () => {
    // Nothing to compare PATH against — a row here would assert a fact the
    // check never verified.
    expect(classifyPathBinary(args({ managedExists: false, pathBinary: null }))).toBeNull();
  });

  it('passes when PATH resolves to the managed binary', () => {
    const check = classifyPathBinary(args());
    expect(check?.status).toBe('ok');
  });

  it('passes when PATH holds a symlink that resolves to the managed binary', () => {
    const check = classifyPathBinary(args({
      pathBinary: '/usr/local/bin/myco',
      realpath: (target) => (target === '/usr/local/bin/myco' ? MANAGED : target),
    }));
    expect(check?.status).toBe('ok');
  });

  it('fails when a foreign binary shadows the managed one, naming both paths', () => {
    const shadow = '/opt/homebrew/bin/myco';
    const check = classifyPathBinary(args({ pathBinary: shadow }));
    expect(check?.status).toBe('fail');
    expect(check!.detail).toContain(shadow);
    expect(check!.detail).toContain(MANAGED);
    // Deleting another package manager's file is not doctor's to automate.
    expect(check!.fixable).toBe(false);
  });

  it('fails and offers a fix when the managed bin dir is not on PATH at all', () => {
    const check = classifyPathBinary(args({ pathBinary: null }));
    expect(check?.status).toBe('fail');
    expect(check!.fixable).toBe(true);
    expect(check!.fixId).toBe('path-bindir');
    expect(check!.fixData?.binDir).toBe(BIN_DIR);
  });

  it('reports but does not offer an rc-file fix on win32', () => {
    // Windows PATH lives in the registry — rc-file editing would be a no-op
    // dressed up as a repair.
    const check = classifyPathBinary(args({ pathBinary: null, platform: 'win32' }));
    expect(check?.status).toBe('fail');
    expect(check!.fixable).toBe(false);
  });

  it('defers to an active runtime pin instead of second-guessing PATH', () => {
    // A dev pin redirects ahead of PATH, so PATH is not authoritative here.
    const check = classifyPathBinary(args({
      pathBinary: '/opt/homebrew/bin/myco',
      pin: '/repo/packages/myco-darwin-arm64/bin/myco',
    }));
    expect(check?.status).toBe('ok');
    expect(check!.detail).toContain('/repo/packages/myco-darwin-arm64/bin/myco');
  });
});

describe('path-bindir fixer', () => {
  const tmpHomes: string[] = [];

  afterEach(() => {
    for (const dir of tmpHomes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A sandbox HOME containing exactly the named rc files. */
  function sandboxHome(rcFiles: string[]): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-path-fix-'));
    tmpHomes.push(home);
    for (const rc of rcFiles) fs.writeFileSync(path.join(home, rc), '# existing\n');
    spyOn(os, 'homedir').mockReturnValue(home);
    return home;
  }

  const matched = [{
    name: 'PATH',
    status: 'fail',
    detail: '',
    fixable: true,
    fixId: 'path-bindir',
    fixData: { binDir: BIN_DIR },
  }] as DoctorCheck[];

  const ctx = {} as DoctorFixContext;

  it('appends the PATH export only to rc files that already exist', async () => {
    const home = sandboxHome(['.zshrc', '.profile']);

    await DOCTOR_FIXERS['path-bindir'](ctx, matched);

    expect(fs.readFileSync(path.join(home, '.zshrc'), 'utf8')).toContain(`export PATH="${BIN_DIR}:$PATH"`);
    expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toContain(`export PATH="${BIN_DIR}:$PATH"`);
    // Never create an rc file the user's shell may not read.
    expect(fs.existsSync(path.join(home, '.bashrc'))).toBe(false);
  });

  it('is idempotent — a second run appends nothing', async () => {
    const home = sandboxHome(['.zshrc']);

    await DOCTOR_FIXERS['path-bindir'](ctx, matched);
    const afterFirst = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    const actions = await DOCTOR_FIXERS['path-bindir'](ctx, matched);

    expect(fs.readFileSync(path.join(home, '.zshrc'), 'utf8')).toBe(afterFirst);
    expect(actions.join(' ')).toContain('already exported');
  });

  it('reports plainly when there is no rc file to update', async () => {
    sandboxHome([]);

    const actions = await DOCTOR_FIXERS['path-bindir'](ctx, matched);

    expect(actions.join(' ')).toContain('add /home/u/.myco/bin to PATH manually');
  });
});
