/**
 * PATH-ownership doctor row: the `myco` the invoking shell resolves must be
 * the managed binary, and the managed bin dir must be on PATH at all. Built
 * on the resolution contract's facts.
 */

import { afterEach, describe, it, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyPathBinary } from '@myco/cli/doctor';
import { DOCTOR_FIXERS } from '@myco/cli/doctor-fixes';
import type { DoctorCheck, DoctorFixContext } from '@myco/cli/doctor-fixes';
import type { ResolutionFacts } from '@myco/runtime/binary-resolution.js';

const MANAGED = '/home/u/.myco/bin/myco';
const BIN_DIR = '/home/u/.myco/bin';

function facts(overrides: Partial<ResolutionFacts> = {}): ResolutionFacts {
  return {
    binDir: BIN_DIR,
    managedBinary: MANAGED,
    managedExists: true,
    managedRunnable: true,
    pin: null,
    pinPath: null,
    pinScope: null,
    ...overrides,
  };
}

function args(overrides: Partial<Parameters<typeof classifyPathBinary>[0]> = {}) {
  return {
    facts: facts(),
    pathBinary: MANAGED,
    platform: 'linux' as NodeJS.Platform,
    realpath: (target: string) => target,
    ...overrides,
  };
}

describe('classifyPathBinary', () => {
  it('emits no row when the managed binary is absent (source build / pre-convergence)', () => {
    // Nothing to compare PATH against.
    expect(classifyPathBinary(args({ facts: facts({ managedExists: false }), pathBinary: null }))).toBeNull();
  });

  it('passes when PATH resolves to the managed binary', () => {
    expect(classifyPathBinary(args())?.status).toBe('ok');
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
    // Deleting another package manager's file is out of scope for --fix.
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
    // Windows PATH lives in the registry, not in rc files.
    const check = classifyPathBinary(args({ pathBinary: null, platform: 'win32' }));
    expect(check?.status).toBe('fail');
    expect(check!.fixable).toBe(false);
  });

  it('defers to an active runtime pin instead of second-guessing PATH', () => {
    // A pin redirects ahead of PATH, so PATH is not authoritative here.
    const check = classifyPathBinary(args({
      pathBinary: '/opt/homebrew/bin/myco',
      facts: facts({
        pin: '/repo/packages/myco-darwin-arm64/bin/myco',
        pinPath: '/home/u/.myco/runtime.command',
        pinScope: 'machine',
      }),
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

  it('writes .zshenv AND .zshrc — only .zshenv reaches non-interactive shells; path_helper demotes it in login shells', async () => {
    const home = sandboxHome(['.zshrc', '.profile']);

    await DOCTOR_FIXERS['path-bindir'](ctx, matched);

    expect(fs.readFileSync(path.join(home, '.zshenv'), 'utf8')).toContain(`export PATH="${BIN_DIR}:$PATH"`);
    expect(fs.readFileSync(path.join(home, '.zshrc'), 'utf8')).toContain(`export PATH="${BIN_DIR}:$PATH"`);
    expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toContain(`export PATH="${BIN_DIR}:$PATH"`);
    // Never create a config for a shell the user may not use.
    expect(fs.existsSync(path.join(home, '.bashrc'))).toBe(false);
  });

  it('creates .zshenv when absent — it is the only zsh file reaching non-interactive shells', async () => {
    const home = sandboxHome([]);

    const actions = await DOCTOR_FIXERS['path-bindir'](ctx, matched);

    expect(fs.existsSync(path.join(home, '.zshenv'))).toBe(true);
    expect(actions.join(' ')).toContain('.zshenv');
  });

  it('is idempotent — a second run appends nothing', async () => {
    const home = sandboxHome(['.profile']);

    await DOCTOR_FIXERS['path-bindir'](ctx, matched);
    const afterFirst = fs.readFileSync(path.join(home, '.zshenv'), 'utf8');
    const actions = await DOCTOR_FIXERS['path-bindir'](ctx, matched);

    expect(fs.readFileSync(path.join(home, '.zshenv'), 'utf8')).toBe(afterFirst);
    expect(actions.join(' ')).toContain('already exported');
  });

  it('emits a guarded block so repeated sourcing cannot duplicate the entry', async () => {
    // .zshenv runs for every zsh, including nested ones.
    const home = sandboxHome([]);

    await DOCTOR_FIXERS['path-bindir'](ctx, matched);

    const written = fs.readFileSync(path.join(home, '.zshenv'), 'utf8');
    expect(written).toContain(`*":${BIN_DIR}:"*) ;;`);
  });
});
