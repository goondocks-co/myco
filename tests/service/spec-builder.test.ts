import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServiceSpec } from '../../packages/myco/src/service/spec-builder';

function makeFakeBinary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-svc-spec-'));
  const bin = path.join(dir, 'myco');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}

describe('buildServiceSpec', () => {
  test('prod spec has prod label, service/ paths, no MYCO_HOME override', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const bin = makeFakeBinary();
    const spec = buildServiceSpec({ variant: 'prod', mycoHome: home, executable: bin });
    expect(spec.label).toBe('co.goondocks.myco');
    expect(spec.variant).toBe('prod');
    expect(spec.executable).toBe(bin);
    expect(spec.args).toEqual(['daemon']);
    expect(spec.stdoutPath).toBe(path.join(home, 'service', 'logs', 'daemon.out.log'));
    expect(spec.stderrPath).toBe(path.join(home, 'service', 'logs', 'daemon.err.log'));
    expect(spec.runAtLoad).toBe(true);
    expect(spec.keepAlive).toBe(true);
    expect(spec.env.MYCO_HOME).toBe(home);
    expect(spec.env.MYCO_SERVICE_VARIANT).toBe('prod');
  });

  test('dev spec uses dev label and service-dev/ log paths', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const bin = makeFakeBinary();
    const spec = buildServiceSpec({ variant: 'dev', mycoHome: home, executable: bin });
    expect(spec.label).toBe('co.goondocks.myco-dev');
    expect(spec.stdoutPath).toBe(path.join(home, 'service-dev', 'logs', 'daemon.out.log'));
    expect(spec.env.MYCO_SERVICE_VARIANT).toBe('dev');
  });

  test('throws if executable does not exist on disk', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    expect(() => buildServiceSpec({
      variant: 'prod',
      mycoHome: home,
      executable: '/nonexistent/myco',
    })).toThrow(/executable not found/i);
  });

  test('rejects executable paths under /opt/homebrew/Cellar (versioned brew paths break on upgrade)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    expect(() => buildServiceSpec({
      variant: 'prod',
      mycoHome: home,
      executable: '/opt/homebrew/Cellar/node/25.9.0_2/bin/node',
    })).toThrow(/Cellar/);
  });

  test('PATH always includes /opt/homebrew/bin and /usr/local/bin so GUI-launched daemon finds tools', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const bin = makeFakeBinary();
    const spec = buildServiceSpec({ variant: 'prod', mycoHome: home, executable: bin });
    expect(spec.env.PATH).toContain('/opt/homebrew/bin');
    expect(spec.env.PATH).toContain('/usr/local/bin');
  });
});
