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
import { checkBinaryVersionSkew, classifyRuntimePin } from '@myco/cli/doctor-member';
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
    expect(check!.reason).toBe('runtime_pin_override');
    expect(check!.detail).toContain('override');
    expect(check!.fixable).toBe(false);
  });

  it('flags a pin naming the managed binary as removable residue', () => {
    const check = classifyRuntimePin({
      facts: facts({ pin: MANAGED, pinPath: '/home/u/.myco/runtime.command', pinScope: 'machine' }),
      pinTargetExists: true,
    });
    expect(check?.status).toBe('warn');
    expect(check!.reason).toBe('runtime_pin_redundant');
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
    expect(check!.reason).toBe('runtime_pin_refused');
    expect(check!.detail).toContain('refused');
    expect(check!.detail).toContain('0666');
  });

  it('fails on a dangling pin — it wins over every fallback', () => {
    const check = classifyRuntimePin({
      facts: facts({ pin: '/gone/myco', pinPath: '/home/u/.myco/runtime.command', pinScope: 'machine' }),
      pinTargetExists: false,
    });
    expect(check?.status).toBe('fail');
    expect(check!.reason).toBe('runtime_pin_target_absent');
    expect(check!.detail).toContain('/gone/myco');
    // Repointing an operator override is not doctor's call.
    expect(check!.fixable).toBe(false);
  });
});

describe('the binary version row', () => {
  it('names why it could not compare, or that it matched', () => {
    // The live install decides which branch answers; every one of them carries
    // a reason a report can read without its sentence.
    const check = checkBinaryVersionSkew();
    expect(check.name).toBe('Binary version');
    expect([
      'binary_manifest_missing', 'binary_manifest_unreadable', 'binary_manifest_unversioned',
      'binary_version_skew', 'binary_version_current',
    ]).toContain(check.reason ?? 'missing_reason');
  });
});
