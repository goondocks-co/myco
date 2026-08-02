/**
 * Machine runtime pin doctor row. The pin is an operator override that wins
 * over every other resolution source: absence is the normal state, a pin
 * naming the managed binary is removable postinstall residue, and a dangling
 * pin breaks every consumer with no fallback behind it.
 */

import { afterEach, describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyRuntimePin } from '@myco/cli/doctor';
import { DOCTOR_FIXERS } from '@myco/cli/doctor-fixes';
import type { DoctorCheck, DoctorFixContext } from '@myco/cli/doctor-fixes';
import type { ResolutionFacts } from '@myco/runtime/binary-resolution.js';

const MANAGED = '/home/u/.myco/bin/myco';

function facts(overrides: Partial<ResolutionFacts> = {}): ResolutionFacts {
  return {
    binDir: '/home/u/.myco/bin',
    managedBinary: MANAGED,
    managedExists: true,
    managedRunnable: true,
    pin: null,
    pinPath: null,
    pinScope: null,
    pinRefusal: null,
    ...overrides,
  };
}

describe('classifyRuntimePin', () => {
  it('emits no row when no pin is set — absence is the normal state', () => {
    expect(classifyRuntimePin({ facts: facts(), pinTargetExists: false })).toBeNull();
  });

  it('reports a live override pin as ok, unfixable', () => {
    const check = classifyRuntimePin({
      facts: facts({ pin: '/repo/dev/myco', pinPath: '/home/u/.myco/runtime.command', pinScope: 'machine' }),
      pinTargetExists: true,
    });
    expect(check?.status).toBe('ok');
    expect(check!.detail).toContain('override');
    expect(check!.fixable).toBe(false);
  });

  it('flags a pin naming the managed binary as removable residue', () => {
    const check = classifyRuntimePin({
      facts: facts({ pin: MANAGED, pinPath: '/home/u/.myco/runtime.command', pinScope: 'machine' }),
      pinTargetExists: true,
    });
    expect(check?.status).toBe('warn');
    expect(check!.fixable).toBe(true);
    expect(check!.fixId).toBe('runtime-pin-redundant');
    expect(check!.fixData).toEqual({ pinPath: '/home/u/.myco/runtime.command', managedBinary: MANAGED });
  });

  it('fails on a refused pin — consumers ignore it and the operator cannot tell', () => {
    const check = classifyRuntimePin({
      facts: facts({ pinRefusal: { pinPath: '/home/u/.myco/runtime.command', reason: 'pin file mode 0666 is writable by group/other' } }),
      pinTargetExists: false,
    });
    expect(check?.status).toBe('fail');
    expect(check!.detail).toContain('refused');
    expect(check!.detail).toContain('0666');
  });

  it('fails on a dangling pin — it wins over every fallback', () => {
    const check = classifyRuntimePin({
      facts: facts({ pin: '/gone/myco', pinPath: '/home/u/.myco/runtime.command', pinScope: 'machine' }),
      pinTargetExists: false,
    });
    expect(check?.status).toBe('fail');
    expect(check!.detail).toContain('/gone/myco');
    // Repointing an operator override is not doctor's call.
    expect(check!.fixable).toBe(false);
  });
});

describe('runtime-pin-redundant fixer', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const ctx = {} as DoctorFixContext;

  function matched(pinPath: string, managedBinary: string): DoctorCheck[] {
    return [{
      name: 'Runtime pin',
      status: 'warn',
      detail: '',
      fixable: true,
      fixId: 'runtime-pin-redundant',
      fixData: { pinPath, managedBinary },
    }] as DoctorCheck[];
  }

  it('removes a pin whose content still names the managed binary', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pin-fix-'));
    tmpDirs.push(home);
    const pinPath = path.join(home, 'runtime.command');
    fs.writeFileSync(pinPath, `${MANAGED}\n`);

    const actions = await DOCTOR_FIXERS['runtime-pin-redundant'](ctx, matched(pinPath, MANAGED));

    expect(fs.existsSync(pinPath)).toBe(false);
    expect(actions.join(' ')).toContain('Removed redundant runtime pin');
  });

  it('leaves a pin that changed between detection and fix', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pin-fix-'));
    tmpDirs.push(home);
    const pinPath = path.join(home, 'runtime.command');
    fs.writeFileSync(pinPath, '/operator/override/myco\n');

    const actions = await DOCTOR_FIXERS['runtime-pin-redundant'](ctx, matched(pinPath, MANAGED));

    expect(fs.existsSync(pinPath)).toBe(true);
    expect(actions.join(' ')).toContain('left in place');
  });
});
