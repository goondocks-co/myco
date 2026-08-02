/**
 * Machine runtime pin health.
 *
 * `~/.myco/runtime.command` is consulted BEFORE PATH by the hook guard
 * (`myco-run.cjs`), the Pi extension's tool dispatch, and the npm shim's
 * redirect. It is the only resolution those consumers have that survives a
 * minimal launchd PATH (GUI-launched agents) or a non-interactive shell (how
 * coding agents spawn commands).
 *
 * Regression origin: the npm postinstall wrote this pin but the native
 * installers never did, so every curl/ps1-installed machine fell back to a
 * bare `myco` in all three consumers — and `myco doctor` had nothing to say
 * about it.
 */

import { afterEach, describe, it, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyRuntimePin } from '@myco/cli/doctor';
import { DOCTOR_FIXERS } from '@myco/cli/doctor-fixes';
import type { DoctorCheck, DoctorFixContext } from '@myco/cli/doctor-fixes';

const MANAGED = '/home/u/.myco/bin/myco';
const PIN_PATH = '/home/u/.myco/runtime.command';

function args(overrides: Partial<Parameters<typeof classifyRuntimePin>[0]> = {}) {
  return {
    managedBinary: MANAGED,
    managedExists: true,
    pinPath: PIN_PATH,
    pin: MANAGED,
    pinTargetExists: true,
    ...overrides,
  };
}

describe('classifyRuntimePin', () => {
  it('emits no row on a source build (no managed binary to pin to)', () => {
    expect(classifyRuntimePin(args({ managedExists: false, pin: null }))).toBeNull();
  });

  it('passes when the pin names the managed binary', () => {
    const check = classifyRuntimePin(args());
    expect(check?.status).toBe('ok');
  });

  it('warns and offers a fix when the pin is absent', () => {
    // Not fatal — consumers fall back to PATH — but that fallback is exactly
    // the one that fails on the hosts the pin exists to serve.
    const check = classifyRuntimePin(args({ pin: null, pinTargetExists: false }));
    expect(check?.status).toBe('warn');
    expect(check!.fixable).toBe(true);
    expect(check!.fixId).toBe('runtime-pin');
    expect(check!.fixData).toEqual({ pinPath: PIN_PATH, managedBinary: MANAGED });
  });

  it('fails when the pin points at something that no longer exists', () => {
    // Worse than absent: there is no fallback, every pinned invocation fails.
    const check = classifyRuntimePin(args({ pin: '/gone/myco', pinTargetExists: false }));
    expect(check?.status).toBe('fail');
    expect(check!.detail).toContain('/gone/myco');
    expect(check!.fixable).toBe(true);
  });

  it('accepts a live pin aimed elsewhere as a deliberate override', () => {
    // `make dev-link` and the beta installer both point the pin off the
    // managed binary on purpose; "fixing" that would undo an operator choice.
    const check = classifyRuntimePin(args({ pin: '/repo/packages/myco-darwin-arm64/bin/myco' }));
    expect(check?.status).toBe('ok');
    expect(check!.detail).toContain('override');
    expect(check!.fixable).toBe(false);
  });
});

describe('runtime-pin fixer', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const ctx = {} as DoctorFixContext;

  function sandbox(): { pinPath: string; binary: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pin-fix-'));
    tmpDirs.push(home);
    spyOn(os, 'homedir').mockReturnValue(home);
    const binary = path.join(home, '.myco', 'bin', 'myco');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return { pinPath: path.join(home, '.myco', 'runtime.command'), binary };
  }

  function matched(pinPath: string, managedBinary: string): DoctorCheck[] {
    return [{
      name: 'Runtime pin',
      status: 'warn',
      detail: '',
      fixable: true,
      fixId: 'runtime-pin',
      fixData: { pinPath, managedBinary },
    }] as DoctorCheck[];
  }

  it('writes the pin with the managed binary path', async () => {
    const { pinPath, binary } = sandbox();

    await DOCTOR_FIXERS['runtime-pin'](ctx, matched(pinPath, binary));

    expect(fs.readFileSync(pinPath, 'utf8').trim()).toBe(binary);
  });

  it('writes a pin the readers will trust (not group/other-writable)', async () => {
    // Every reader refuses a 0o022-writable pin — it is exec'd as the user's
    // `myco`, so a writable pin would let a local user redirect every call.
    const { pinPath, binary } = sandbox();

    await DOCTOR_FIXERS['runtime-pin'](ctx, matched(pinPath, binary));

    expect(fs.statSync(pinPath).mode & 0o022).toBe(0);
  });

  it('creates the parent directory when myco-home does not exist yet', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pin-fresh-'));
    tmpDirs.push(home);
    const pinPath = path.join(home, 'fresh', 'runtime.command');

    const actions = await DOCTOR_FIXERS['runtime-pin'](ctx, matched(pinPath, '/some/myco'));

    expect(fs.existsSync(pinPath)).toBe(true);
    expect(actions.join(' ')).toContain('Wrote runtime pin');
  });
});
