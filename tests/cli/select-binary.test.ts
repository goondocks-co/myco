import { describe, it, expect, afterEach } from 'bun:test';
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
  binaryPath: string;
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

/**
 * Build a fake @goondocks/myco install tree on disk so the postinstall
 * script can `require.resolve('@goondocks/myco-<target>/bin/<bin>')`
 * against a real node_modules layout. The platform package gets a
 * package.json (required for resolve to recognise it as a package) and
 * a bin/<binary> file when `includeBinary` is true.
 */
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

  // Stage the platform package as a sibling under node_modules/@goondocks/
  // — same layout npm produces when installing the optionalDependency.
  const platformPkgDir = path.join(pkgRoot, 'node_modules', '@goondocks', `myco-${target}`);
  fs.mkdirSync(path.join(platformPkgDir, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(platformPkgDir, 'package.json'),
    JSON.stringify({ name: `@goondocks/myco-${target}`, version: '0.0.0' }) + '\n',
  );

  let binaryPath = path.join(platformPkgDir, 'bin', binaryName);
  if (options?.includeBinary) {
    fs.writeFileSync(binaryPath, 'binary');
  }

  return { tmpDir, pkgRoot, scriptPath, target, binaryName, binaryPath };
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

  it('fails fast when a packaged install is missing its platform binary', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);

    const result = spawnSync(process.execPath, [fixture.scriptPath], {
      cwd: fixture.pkgRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not installed');
    expect(result.stderr).toContain(`@goondocks/myco-${fixture.target}`);
  });

  it('writes resolved.json with the absolute binary path when present', () => {
    const fixture = makeFixture({ includeBinary: true });
    fixtures.push(fixture);

    const result = spawnSync(process.execPath, [fixture.scriptPath], {
      cwd: fixture.pkgRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const resolvedPath = path.join(fixture.pkgRoot, 'vendor', 'resolved.json');
    const resolved = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
    expect(resolved.target).toBe(fixture.target);
    // binaryPath must resolve through realpath, but on macOS /tmp resolves
    // through /private/tmp, so compare via realpath rather than literal.
    expect(fs.realpathSync(resolved.binaryPath)).toBe(fs.realpathSync(fixture.binaryPath));
    expect(result.stdout).toContain(`@goondocks/myco-${fixture.target}`);
  });
});
