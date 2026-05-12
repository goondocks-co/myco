import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateServiceCheck } from '../../packages/myco/src/cli/doctor';
import type { ServiceStatus } from '../../packages/myco/src/service/types';

const goodBin = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-doc-'));
  const b = path.join(d, 'myco');
  fs.writeFileSync(b, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return b;
};

describe('evaluateServiceCheck', () => {
  test('not installed → warn (lazy spawn still works)', () => {
    const status: ServiceStatus = { installed: false, running: false, pid: null, lastExitCode: null, unitPath: null };
    const check = evaluateServiceCheck('co.goondocks.myco', status, '/some/path');
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/not installed/i);
    expect(check.fixable).toBe(true);
  });

  test('installed and running → ok', () => {
    const bin = goodBin();
    const status: ServiceStatus = { installed: true, running: true, pid: 4242, lastExitCode: 0, unitPath: '/x' };
    const check = evaluateServiceCheck('co.goondocks.myco', status, bin);
    expect(check.status).toBe('ok');
  });

  test('installed but executable missing → fail (the chris machine failure mode)', () => {
    const status: ServiceStatus = { installed: true, running: false, pid: null, lastExitCode: 78, unitPath: '/x' };
    const check = evaluateServiceCheck('co.goondocks.myco', status, '/nonexistent/path');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/executable.*not found|EX_CONFIG|exit code 78/i);
    expect(check.fixable).toBe(true);
  });

  test('installed with non-zero lastExitCode → warn', () => {
    const bin = goodBin();
    const status: ServiceStatus = { installed: true, running: true, pid: 1, lastExitCode: 1, unitPath: '/x' };
    const check = evaluateServiceCheck('co.goondocks.myco', status, bin);
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/last exit code/i);
  });
});
