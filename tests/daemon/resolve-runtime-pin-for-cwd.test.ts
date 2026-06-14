import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRuntimePinForCwd } from '@myco/daemon/update-checker.js';

/**
 * Real-filesystem coverage for the upward walk. MYCO_HOME points at a temp
 * `.myco` so the machine-pin fallback (`<MYCO_HOME>/runtime.command`) is
 * absent unless the test creates it, and the cwd walk lives entirely under a
 * separate temp tree.
 */
let tmp: string;
let mycoHome: string;
let savedMycoHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pin-walk-'));
  mycoHome = path.join(tmp, 'home', '.myco');
  fs.mkdirSync(mycoHome, { recursive: true });
  savedMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
});

afterEach(() => {
  if (savedMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedMycoHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writePin(dir: string, value: string): void {
  const mycoDir = path.join(dir, '.myco');
  fs.mkdirSync(mycoDir, { recursive: true });
  fs.writeFileSync(path.join(mycoDir, 'runtime.command'), value, 'utf-8');
}

describe('resolveRuntimePinForCwd', () => {
  it('finds a project pin via an upward filesystem walk from a nested cwd', () => {
    const projectRoot = path.join(tmp, 'work', 'a', 'b');
    const nestedCwd = path.join(projectRoot, 'c');
    fs.mkdirSync(nestedCwd, { recursive: true });
    writePin(projectRoot, '  /opt/dogfood/bin/myco \n');

    expect(resolveRuntimePinForCwd(nestedCwd)).toBe('/opt/dogfood/bin/myco');
  });

  it('falls back to the machine pin when no project pin exists on the walk', () => {
    fs.writeFileSync(path.join(mycoHome, 'runtime.command'), '/opt/beta/myco\n', 'utf-8');

    const cwd = path.join(tmp, 'work', 'no', 'project', 'pin');
    fs.mkdirSync(cwd, { recursive: true });

    expect(resolveRuntimePinForCwd(cwd)).toBe('/opt/beta/myco');
  });

  it('returns null when neither a project pin nor a machine pin exists', () => {
    const cwd = path.join(tmp, 'work', 'bare');
    fs.mkdirSync(cwd, { recursive: true });
    expect(resolveRuntimePinForCwd(cwd)).toBeNull();
  });
});
