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
  /** Hermetic env for the spawned postinstall — HOME + MYCO_HOME redirected into the temp tree. */
  scriptEnv: NodeJS.ProcessEnv;
  /** The sandbox myco-home (`<sandboxHome>/.myco`) the convergence writes into. */
  mycoHome: string;
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
  // select-binary.mjs imports the shared `./managed-paths.mjs` path module — it
  // ships alongside the script in `scripts/` and must travel with it into the
  // scaffolded package, or the postinstall subprocess crashes at module load.
  fs.copyFileSync(
    path.resolve('packages/myco/scripts/managed-paths.mjs'),
    path.join(scriptsDir, 'managed-paths.mjs'),
  );

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

  // HERMETIC SANDBOX (critical): the postinstall CONVERGES into MYCO_HOME,
  // which DEFAULTS to ~/.myco. Every spawn MUST redirect HOME + MYCO_HOME into
  // the temp tree — otherwise a test with a real platform binary present writes
  // the fixture's fake binary over the developer's REAL ~/.myco/bin/myco, which
  // breaks every hook on the machine (the runtime.command pin execs that path).
  const sandboxHome = path.join(tmpDir, 'sandbox-home');
  const mycoHome = path.join(sandboxHome, '.myco');
  fs.mkdirSync(sandboxHome, { recursive: true });
  const scriptEnv = { ...process.env, HOME: sandboxHome, MYCO_HOME: mycoHome };

  return { tmpDir, pkgRoot, scriptPath, target, binaryName, binaryPath, scriptEnv, mycoHome };
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
      env: fixture.scriptEnv,
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
      env: fixture.scriptEnv,
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
      env: fixture.scriptEnv,
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

  // Regression: convergence must run against the published package shape, which
  // has NO dist/src/ and NO src/ directories. The original bug was a silent
  // skip ("managed-binary module not found in dist/") because the convergence
  // block imported dist/src/install/managed-binary.js — never emitted by the
  // bun binary build. This test exercises the exact published shape.
  it('convergence runs against the published package shape (no dist/src/, no src/)', () => {
    const fixture = makeFixture({ includeBinary: true });
    fixtures.push(fixture);

    // Write a package.json with a real version so versionedDest is computed.
    fs.writeFileSync(
      path.join(fixture.pkgRoot, 'package.json'),
      JSON.stringify({ name: '@goondocks/myco', version: '1.2.3' }) + '\n',
    );

    // Confirm the published shape: no dist/src/, no src/.
    expect(fs.existsSync(path.join(fixture.pkgRoot, 'dist', 'src'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.pkgRoot, 'src'))).toBe(false);

    const result = spawnSync(process.execPath, [fixture.scriptPath], {
      cwd: fixture.pkgRoot,
      encoding: 'utf8',
      env: fixture.scriptEnv,
    });

    expect(result.status).toBe(0);
    // Must NOT print the old skip message.
    expect(result.stderr).not.toContain('managed-binary module not found in dist/');
    expect(result.stderr).not.toContain('Convergence skipped');

    // Convergence wrote into the sandbox myco-home, never the real ~/.myco.
    // Stable managed binary at <mycoHome>/bin/myco[.exe].
    const binaryName = process.platform === 'win32' ? 'myco.exe' : 'myco';
    const managedBin = path.join(fixture.mycoHome, 'bin', binaryName);
    expect(fs.existsSync(managedBin)).toBe(true);

    // Versioned slot at <mycoHome>/bin/versions/1.2.3/myco[.exe].
    const versionedBin = path.join(fixture.mycoHome, 'bin', 'versions', '1.2.3', binaryName);
    expect(fs.existsSync(versionedBin)).toBe(true);

    // install.json marker at <mycoHome>/install.json.
    const markerPath = path.join(fixture.mycoHome, 'install.json');
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(marker.source).toBe('npm');
    expect(marker.bin).toBe(managedBin);
  });
});
