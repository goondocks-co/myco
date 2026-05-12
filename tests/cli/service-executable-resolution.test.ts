import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveServiceExecutable } from '../../packages/myco/src/cli/service';

describe('resolveServiceExecutable', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rse-'));
    originalHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalHome;
  });

  test('returns daemon.json command for dev variant when present', () => {
    const dir = path.join(tmpHome, 'service-dev');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ pid: 1, port: 1, command: '/abs/path/to/myco' }));
    expect(resolveServiceExecutable('dev')).toBe('/abs/path/to/myco');
  });

  test('returns daemon.json command for prod variant when present', () => {
    const dir = path.join(tmpHome, 'service');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ pid: 1, port: 1, command: '/abs/myco-prod' }));
    expect(resolveServiceExecutable('prod')).toBe('/abs/myco-prod');
  });

  test('falls back to process.execPath when daemon.json missing', () => {
    expect(resolveServiceExecutable('prod')).toBe(process.execPath);
  });

  test('falls back to process.execPath when daemon.json has no command field', () => {
    const dir = path.join(tmpHome, 'service-dev');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ pid: 1, port: 1 }));
    expect(resolveServiceExecutable('dev')).toBe(process.execPath);
  });
});
