import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT_SOURCE = path.resolve('packages/myco/scripts/select-binary.mjs');

interface Fixture {
  tmpDir: string;
  pkgRoot: string;
  scriptPath: string;
  target: string;
  binaryName: string;
}

function hostTarget(): string | null {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (process.platform === 'win32') return 'windows-x64';
  return null;
}

function hostBinaryName(): string {
  return process.platform === 'win32' ? 'myco.exe' : 'myco';
}

function makeFixture(options?: { sourceCheckout?: boolean; includeBinary?: boolean }): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-select-binary-'));
  const pkgRoot = path.join(tmpDir, 'package');
  const scriptsDir = path.join(pkgRoot, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  const scriptPath = path.join(scriptsDir, 'select-binary.mjs');
  fs.copyFileSync(SCRIPT_SOURCE, scriptPath);

  if (options?.sourceCheckout) {
    fs.mkdirSync(path.join(pkgRoot, 'src'), { recursive: true });
  }

  const target = hostTarget();
  if (!target) throw new Error(`unsupported test host: ${process.platform}-${process.arch}`);
  const binaryName = hostBinaryName();

  if (options?.includeBinary) {
    const binaryPath = path.join(pkgRoot, 'vendor', target, binaryName);
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, 'binary');
  }

  return { tmpDir, pkgRoot, scriptPath, target, binaryName };
}

describe('select-binary postinstall', () => {
  let fixtures: Fixture[] = [];

  afterEach(() => {
    for (const fixture of fixtures) {
      fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
    fixtures = [];
  });

  it('soft-skips missing binaries in a source checkout', () => {
    const fixture = makeFixture({ sourceCheckout: true });
    fixtures.push(fixture);

    const result = spawnSync(process.execPath, [fixture.scriptPath], {
      cwd: fixture.pkgRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Skipping postinstall in source checkout');
  });

  it('fails fast when a packaged install is missing its host binary', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);

    const result = spawnSync(process.execPath, [fixture.scriptPath], {
      cwd: fixture.pkgRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Package install is incomplete');
  });

  it('writes resolved.json when the host binary is present', () => {
    const fixture = makeFixture({ includeBinary: true });
    fixtures.push(fixture);

    const result = spawnSync(process.execPath, [fixture.scriptPath], {
      cwd: fixture.pkgRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const resolvedPath = path.join(fixture.pkgRoot, 'vendor', 'resolved.json');
    expect(JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'))).toEqual({ target: fixture.target });
    expect(result.stdout).toContain(`vendor/${fixture.target}/${fixture.binaryName}`);
  });
});
