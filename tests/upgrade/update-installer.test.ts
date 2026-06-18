/**
 * Tests for the update installer's detached-spawn layer.
 *
 * The orchestration logic moved out of generated `#!/bin/sh` scripts and into
 * the cross-platform `apply-update.ts` (covered by its own test). What remains
 * here is the daemon-side spawner: it writes the orchestration params to a temp
 * JSON file and spawns `<binary> __apply-update <paramsFile>` DETACHED.
 *
 * These tests assert that contract: params JSON carries the right `kind`,
 * fields, and `serviceManagedLabel`; the spawned argv invokes `__apply-update`
 * with the params path; the spawn is detached + unreffed; no `/bin/sh`.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';

// ---------------------------------------------------------------------------
// Capture spawn calls and intercept fs writes so the test never touches the
// real ~/.myco or shells out. We record written files in-memory by path.
// ---------------------------------------------------------------------------
type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown> };
const spawnCalls: SpawnCall[] = [];
let unrefCount = 0;

import * as childProcessActual__ns from 'node:child_process';
const childProcessActual = { ...childProcessActual__ns };
mock.module('node:child_process', () => ({
  ...childProcessActual,
  spawn: vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ cmd, args, opts });
    return { unref: () => { unrefCount++; }, on: () => {}, kill: () => {} } as never;
  }),
}));

const writtenFiles = new Map<string, string>();
import * as fsActual__ns from 'node:fs';
const fsActual = fsActual__ns.default ?? fsActual__ns;
const fsStub = {
  ...fsActual,
  mkdirSync: vi.fn(() => undefined),
  copyFileSync: vi.fn(() => undefined),
  writeFileSync: vi.fn((p: string, content: string) => { writtenFiles.set(String(p), String(content)); }),
};
mock.module('node:fs', () => ({ ...fsStub, default: fsStub }));

afterAll(() => {
  mock.module('node:child_process', () => childProcessActual);
  mock.module('node:fs', () => ({ ...fsActual, default: fsActual }));
});

import { spawnUpdateScript, spawnRestartScript } from '@myco/upgrade/spawn.js';

/** The single params file the spawner wrote for the most recent call. */
function lastParams(): Record<string, unknown> {
  const call = spawnCalls.at(-1)!;
  const paramsFile = call.args[1];
  return JSON.parse(writtenFiles.get(paramsFile)!) as Record<string, unknown>;
}

const UPDATE_BASE = {
  packageSpecs: ['@goondocks/myco@1.0.0'],
  projectRoot: '/project',
  vaultDir: '/project/.myco',
  mycoBinary: 'myco',
  daemonPort: 20915,
  targetVersion: '1.0.0',
};

const RESTART_BASE = {
  projectRoot: '/home/user/project',
  vaultDir: '/home/user/project/.myco',
  runLocalUpdate: true,
  fromVersion: '0.17.0',
  toVersion: '0.17.1',
  mycoBinary: 'myco',
  daemonPort: 20915,
};

beforeEach(() => {
  spawnCalls.length = 0;
  writtenFiles.clear();
  unrefCount = 0;
});

describe('spawnUpdateScript', () => {
  it('spawns the binary `__apply-update` subcommand detached + unreffed', () => {
    spawnUpdateScript(UPDATE_BASE);
    expect(spawnCalls.length).toBe(1);
    const { args, opts } = spawnCalls[0];
    expect(args[0]).toBe('__apply-update');
    // argv[1] is the params file path the orchestrator reads.
    expect(args[1]).toBe(spawnCalls[0].args[1]);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(opts.windowsHide).toBe(true);
    expect(unrefCount).toBe(1);
  });

  it('never spawns /bin/sh (the Windows-ENOENT bug this fix removes)', () => {
    spawnUpdateScript(UPDATE_BASE);
    expect(spawnCalls[0].cmd).not.toBe('/bin/sh');
  });

  it('writes a kind:"update" params JSON with the install fields', () => {
    spawnUpdateScript({
      ...UPDATE_BASE,
      packageSpecs: ['@goondocks/myco@1.0.0', '@goondocks/myco-team@0.1.1'],
    });
    const p = lastParams();
    expect(p.kind).toBe('update');
    expect(p.packageSpecs).toEqual(['@goondocks/myco@1.0.0', '@goondocks/myco-team@0.1.1']);
    expect(p.projectRoot).toBe('/project');
    expect(p.vaultDir).toBe('/project/.myco');
    expect(p.mycoBinary).toBe('myco');
    expect(p.daemonPort).toBe(20915);
    expect(p.targetVersion).toBe('1.0.0');
  });

  it('defaults serviceManagedLabel to null when not provided', () => {
    spawnUpdateScript(UPDATE_BASE);
    expect(lastParams().serviceManagedLabel).toBeNull();
  });

  it('passes a service label through when supplied', () => {
    spawnUpdateScript({ ...UPDATE_BASE, serviceManagedLabel: 'co.goondocks.myco' });
    expect(lastParams().serviceManagedLabel).toBe('co.goondocks.myco');
  });

  it('omits the retired managed-runtime params (deleted with the native installer)', () => {
    spawnUpdateScript(UPDATE_BASE);
    const p = lastParams();
    expect(p.localRuntimeSpec).toBeUndefined();
    expect(p.removeLocalRuntime).toBeUndefined();
    expect(p.machineRuntimeDir).toBeUndefined();
    expect(p.machineRuntimeTmpDir).toBeUndefined();
    expect(p.machineRuntimeCommandPath).toBeUndefined();
    expect(p.machineRuntimeMyco).toBeUndefined();
  });

  it('threads mycoBinaryUpdate + the managed binary path into the params (binary self-update)', () => {
    const mycoBinaryUpdate = {
      assetUrl: 'https://example.test/releases/myco-darwin-arm64',
      sha256sumsUrl: 'https://example.test/releases/SHA256SUMS',
      assetName: 'myco-darwin-arm64',
      targetVersion: '1.1.0',
    };
    spawnUpdateScript({ ...UPDATE_BASE, packageSpecs: [], mycoBinaryUpdate });
    const p = lastParams();
    expect(p.mycoBinaryUpdate).toEqual(mycoBinaryUpdate);
    // The managed binary the orchestrator will swap (`~/.myco/bin/myco` on posix).
    expect(String(p.managedBinaryPath)).toMatch(/(\.myco[/\\]bin[/\\]myco|Myco[/\\]bin[/\\]myco\.exe)$/);
  });

  it('omits mycoBinaryUpdate/managedBinaryPath when no binary update is requested', () => {
    spawnUpdateScript(UPDATE_BASE);
    const p = lastParams();
    expect(p.mycoBinaryUpdate).toBeUndefined();
    expect(p.managedBinaryPath).toBeUndefined();
  });
});

describe('spawnRestartScript', () => {
  it('writes a kind:"restart" params JSON with the restart fields', () => {
    spawnRestartScript(RESTART_BASE);
    const p = lastParams();
    expect(p.kind).toBe('restart');
    expect(p.runLocalUpdate).toBe(true);
    expect(p.fromVersion).toBe('0.17.0');
    expect(p.toVersion).toBe('0.17.1');
    expect(p.projectRoot).toBe('/home/user/project');
    expect(p.daemonPort).toBe(20915);
    expect(String(p.restartReasonPath)).toContain('restart-reason.json');
  });

  it('spawns `__apply-update` detached (no /bin/sh)', () => {
    spawnRestartScript(RESTART_BASE);
    expect(spawnCalls[0].cmd).not.toBe('/bin/sh');
    expect(spawnCalls[0].args[0]).toBe('__apply-update');
    expect(spawnCalls[0].opts.detached).toBe(true);
  });

  it('defaults serviceManagedLabel to null and passes a label through', () => {
    spawnRestartScript(RESTART_BASE);
    expect(lastParams().serviceManagedLabel).toBeNull();
    spawnRestartScript({ ...RESTART_BASE, serviceManagedLabel: 'co.goondocks.myco-dev' });
    expect(lastParams().serviceManagedLabel).toBe('co.goondocks.myco-dev');
  });

  it('installer→orchestrator handoff carries spaced paths intact (in the params JSON, not on argv)', () => {
    spawnRestartScript({
      ...RESTART_BASE,
      projectRoot: '/home/user/my project',
      vaultDir: '/home/user/my project/.myco',
    });
    const p = lastParams();
    expect(p.projectRoot).toBe('/home/user/my project');
    expect(String(p.restartReasonPath)).toContain('my project');
  });
});
