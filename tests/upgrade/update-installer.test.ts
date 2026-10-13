/** Retired local-runtime update entry points refuse before writing or spawning. */

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
import fsActual from 'node:fs';
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

import { spawnRestartScript, spawnApplyUpgrade } from '@myco/upgrade/spawn.js';

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

describe('retired local-runtime updater', () => {
  it('refuses a direct apply before writing parameters or spawning', () => {
    expect(() => spawnApplyUpgrade('myco-restart', {
      ...RESTART_BASE, kind: 'restart', restartReasonPath: '/unused',
    })).toThrow('retired __apply-update command');
    expect(writtenFiles.size).toBe(0);
    expect(spawnCalls).toEqual([]);
    expect(unrefCount).toBe(0);
  });

  it('refuses restart requests through the same entry point', () => {
    expect(() => spawnRestartScript(RESTART_BASE)).toThrow('Use myco update');
    expect(writtenFiles.size).toBe(0);
    expect(spawnCalls).toEqual([]);
  });
});
