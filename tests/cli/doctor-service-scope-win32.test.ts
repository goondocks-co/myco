/**
 * The service-scope doctor row must not hand Windows users an impossible
 * remediation: `myco service install` refuses boot scope on win32, so the
 * generic "run it from a shell that can elevate" advice is a permanent
 * unfixable warn there. The win32 branch names the real fix instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkServiceScope } from '@myco/cli/doctor.js';

let workDir: string;
let savedMycoHome: string | undefined;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-scope-win32-'));
  savedMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = workDir;
  fs.writeFileSync(path.join(workDir, 'config.yaml'), 'daemon:\n  service_scope: boot\n');
});

afterEach(() => {
  if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedMycoHome;
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('doctor service-scope row on win32', () => {
  it('names the real fix instead of an elevate command that refuses on Windows', async () => {
    const row = await checkServiceScope('win32');

    expect(row?.status).toBe('warn');
    expect(row?.detail).toContain('not supported on Windows');
    expect(row?.detail).toContain('Task Scheduler');
    expect(row?.detail).not.toContain('shell that can elevate');
  });

  it('keeps the elevate remediation on platforms where boot scope exists', async () => {
    const row = await checkServiceScope('darwin');

    expect(row?.status).toBe('warn');
    expect(row?.detail).toContain('shell that can elevate');
  });
});
