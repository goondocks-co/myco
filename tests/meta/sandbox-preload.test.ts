import { describe, expect, it } from 'bun:test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const REAL_HOME = (globalThis as Record<string, unknown>).__MYCO_TEST_REAL_HOME__ as string;

describe('sandbox preload — redirect', () => {
  it('os.homedir() is NOT the real home', () => {
    expect(typeof REAL_HOME).toBe('string');
    expect(os.homedir()).not.toBe(REAL_HOME);
  });
  it('os.userInfo().homedir is redirected too', () => {
    expect(os.userInfo().homedir).not.toBe(REAL_HOME);
  });
});

describe('sandbox preload — fence (live-config writes throw)', () => {
  const probe = (rel: string) => path.join(REAL_HOME, rel);
  it('writeFileSync to ~/.myco throws', () => {
    expect(() => fs.writeFileSync(probe('.myco/__leak_probe__'), 'x')).toThrow(/TEST SAFETY/);
  });
  it('mkdirSync under ~/.myco-team throws', () => {
    expect(() => fs.mkdirSync(probe('.myco-team/teams/x'), { recursive: true })).toThrow(/TEST SAFETY/);
  });
  it('renameSync moving ~/.myco/teams aside throws', () => {
    expect(() => fs.renameSync(probe('.myco/teams'), probe('.myco/teams.bak'))).toThrow(/TEST SAFETY/);
  });
  it('rmSync of ~/.myco throws', () => {
    expect(() => fs.rmSync(probe('.myco'), { recursive: true, force: true })).toThrow(/TEST SAFETY/);
  });
  it('copyFileSync into ~/.myco-collective throws', () => {
    const src = path.join(os.tmpdir(), 'probe-src'); fs.writeFileSync(src, 'x');
    expect(() => fs.copyFileSync(src, probe('.myco-collective/x'))).toThrow(/TEST SAFETY/);
  });
  it('writes OUTSIDE the real myco namespace are allowed', () => {
    const ok = path.join(os.tmpdir(), 'myco-sandbox-ok-' + process.pid);
    expect(() => { fs.mkdirSync(ok, { recursive: true }); fs.writeFileSync(path.join(ok, 'f'), 'x'); fs.rmSync(ok, { recursive: true, force: true }); }).not.toThrow();
  });
});
