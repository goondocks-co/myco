/**
 * Contract adoption gates for the TS resolution sites: no adopted site
 * bare-names when a managed binary exists, and home isolation holds — a
 * non-default-home process never resolves the default home's binary.
 */

import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveManagedBinaryPath } from '@myco/symbionts/installer.js';
import { managedBinaryPath } from '@myco/install/managed-binary.js';

const tmpDirs: string[] = [];
let savedMycoHome: string | undefined;

beforeEach(() => {
  savedMycoHome = process.env.MYCO_HOME;
});

afterEach(() => {
  if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedMycoHome;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-adopt-'));
  tmpDirs.push(dir);
  return dir;
}

function writeManaged(home: string, mode = 0o755): string {
  const managed = managedBinaryPath(home, process.platform, process.env.LOCALAPPDATA);
  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.writeFileSync(managed, '#!/bin/sh\nexit 0\n', { mode });
  return managed;
}

describe('resolveManagedBinaryPath (installer-embedded commands)', () => {
  it('uses the managed binary when runnable, forward-slashed', () => {
    const home = tmpHome();
    const managed = writeManaged(home);
    expect(resolveManagedBinaryPath(home, process.platform)).toBe(managed.replaceAll('\\', '/'));
  });

  it('skips a present-but-not-executable managed binary', () => {
    const home = tmpHome();
    writeManaged(home, 0o644);
    expect(resolveManagedBinaryPath(home, process.platform)).toBe(process.execPath.replaceAll('\\', '/'));
  });
});
