import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { managedBinaryPath, versionBinaryPath } from '@myco/install/managed-binary';
// Import the convergence entrypoint from the postinstall .mjs directly. The
// .mjs is guarded by an is-main check, so importing it MUST NOT execute the
// postinstall body (detectTarget / require.resolve / process.exit). If that
// guard regresses, this import would terminate the test process.
import { convergeNpmInstall } from '../../packages/myco/scripts/select-binary.mjs';

const PLATFORM = process.platform === 'win32' ? 'win32' : process.platform;
const TEST_VERSION = '1.2.3';

interface Fixture {
  home: string;
  resolvedBinary: string;
}

function makeFixture(): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-converge-home-'));
  // A fake "source" platform binary that convergence copies into the managed
  // bin dir. Distinct content so we can assert byte-for-byte placement.
  const srcDir = path.join(home, 'fake-platform-pkg', 'bin');
  fs.mkdirSync(srcDir, { recursive: true });
  const resolvedBinary = path.join(srcDir, 'myco');
  fs.writeFileSync(resolvedBinary, 'FAKE-MYCO-BINARY-CONTENT');
  return { home, resolvedBinary };
}

function writePin(home: string, value: string): void {
  const pinPath = path.join(home, '.myco', 'runtime.command');
  fs.mkdirSync(path.dirname(pinPath), { recursive: true });
  fs.writeFileSync(pinPath, `${value}\n`, { mode: 0o644 });
}

function readPin(home: string): string {
  return fs.readFileSync(path.join(home, '.myco', 'runtime.command'), 'utf8').trim();
}

describe('select-binary convergeNpmInstall', () => {
  let fixtures: Fixture[] = [];

  afterEach(() => {
    for (const f of fixtures) fs.rmSync(f.home, { recursive: true, force: true });
    fixtures = [];
  });

  it('importing the .mjs does not execute the postinstall (is-main guard)', () => {
    // If the guard were wrong, the static import above would have run
    // detectTarget()/process.exit() at module-load and this test would never
    // run. Reaching here at all proves the guard holds; assert the export
    // shape too so the seam stays a real function.
    expect(typeof convergeNpmInstall).toBe('function');
  });

  it('places the binary in the versioned slot then copies to stable dest (a, a2, b)', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const { home, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(home, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(home, PLATFORM);

    const result = convergeNpmInstall({
      home,
      platform: PLATFORM,
      resolvedBinary,
      dest,
      channel: 'stable',
      version: TEST_VERSION,
      versionedDest: versionedPath,
    });

    // (a) versioned slot exists with the source bytes.
    expect(fs.existsSync(versionedPath)).toBe(true);
    expect(fs.readFileSync(versionedPath, 'utf8')).toBe('FAKE-MYCO-BINARY-CONTENT');

    // (a2) stable dest is the canonical managed path and holds the source bytes.
    expect(result.dest).toBe(dest);
    expect(dest).toBe(managedBinaryPath(home, PLATFORM));
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toBe('FAKE-MYCO-BINARY-CONTENT');

    // (b) no leftover temp files from the atomic placement — in either the
    // stable bin dir or the versioned slot dir (both use temp+rename).
    const binDir = path.dirname(dest);
    const stableLeftovers = fs.readdirSync(binDir).filter((n) => n.includes('.tmp-'));
    expect(stableLeftovers).toEqual([]);
    const versionedLeftovers = fs
      .readdirSync(path.dirname(versionedPath))
      .filter((n) => n.includes('.tmp-'));
    expect(versionedLeftovers).toEqual([]);
  });

  it('versioned slot path matches versions/<version>/myco layout (a3)', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const { home, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(home, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(home, PLATFORM);

    convergeNpmInstall({
      home,
      platform: PLATFORM,
      resolvedBinary,
      dest,
      channel: 'stable',
      version: TEST_VERSION,
      versionedDest: versionedPath,
    });

    // Path structure: <bindir>/versions/<bare-semver>/myco[.exe]
    const binaryName = PLATFORM === 'win32' ? 'myco.exe' : 'myco';
    expect(versionedPath).toContain(`versions/${TEST_VERSION}/${binaryName}`);
    expect(fs.existsSync(versionedPath)).toBe(true);
  });

  it('writes the runtime.command pin to dest, never group/other-writable (c)', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const { home, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(home, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(home, PLATFORM);

    convergeNpmInstall({
      home,
      platform: PLATFORM,
      resolvedBinary,
      dest,
      channel: 'stable',
      version: TEST_VERSION,
      versionedDest: versionedPath,
    });

    expect(readPin(home)).toBe(dest);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(home, '.myco', 'runtime.command')).mode & 0o777;
      expect(mode & 0o022).toBe(0);
    }
  });

  it('writes the install marker with source=npm, bin=dest, and channel (d)', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const { home, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(home, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(home, PLATFORM);

    convergeNpmInstall({
      home,
      platform: PLATFORM,
      resolvedBinary,
      dest,
      channel: 'beta',
      version: TEST_VERSION,
      versionedDest: versionedPath,
    });

    const marker = JSON.parse(fs.readFileSync(path.join(home, '.myco', 'install.json'), 'utf8'));
    expect(marker.source).toBe('npm');
    expect(marker.bin).toBe(dest);
    expect(marker.channel).toBe('beta');
  });

  it('preserves a pre-existing managed-runtime pin (e)', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const { home, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(home, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(home, PLATFORM);
    // An ACTIVE beta managed runtime pin: <home>/.myco/runtime/node_modules/...
    const managedRuntimePin = path.join(home, '.myco', 'runtime', 'node_modules', '.bin', 'myco');
    writePin(home, managedRuntimePin);

    const result = convergeNpmInstall({
      home,
      platform: PLATFORM,
      resolvedBinary,
      dest,
      channel: 'stable',
      version: TEST_VERSION,
      versionedDest: versionedPath,
    });

    // Pin is untouched — the binary still converges, but we do NOT clobber an
    // active managed runtime.
    expect(readPin(home)).toBe(managedRuntimePin);
    expect(result.pinAction).not.toBe('wrote');
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('re-points a legacy node_modules pin onto the managed binary (f)', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const { home, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(home, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(home, PLATFORM);
    // A legacy npm install pin: inside node_modules but NOT the managed runtime.
    const legacyPin = '/somewhere/node_modules/@goondocks/myco-darwin-arm64/bin/myco';
    writePin(home, legacyPin);

    const result = convergeNpmInstall({
      home,
      platform: PLATFORM,
      resolvedBinary,
      dest,
      channel: 'stable',
      version: TEST_VERSION,
      versionedDest: versionedPath,
    });

    expect(readPin(home)).toBe(dest);
    expect(result.pinAction).toBe('wrote');
  });

  it('preserves a deliberate external/dev pin (not node_modules, not managed-runtime) (g)', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const { home, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(home, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(home, PLATFORM);
    // A deliberate external/dev pin: no /node_modules/ segment, not under
    // <home>/.myco/runtime/. Convergence must NEVER clobber this.
    const externalPin = path.join(home, '.local', 'bin', 'myco-dev');
    writePin(home, externalPin);
    // Record exact bytes written (writePin appends \n, trim() strips it for
    // readPin; compare at the trim level to match the assertion style of case e).
    const pinBefore = readPin(home);

    const result = convergeNpmInstall({
      home,
      platform: PLATFORM,
      resolvedBinary,
      dest,
      channel: 'stable',
      version: TEST_VERSION,
      versionedDest: versionedPath,
    });

    // Pin is byte-identical to what was written — not overwritten with dest.
    expect(readPin(home)).toBe(pinBefore);
    expect(readPin(home)).toBe(externalPin);
    // Implementation must land on the preserve-external branch, not 'wrote'.
    expect(result.pinAction).toBe('preserved-external');
    // Binary convergence still happens — the managed dest is placed.
    expect(fs.existsSync(dest)).toBe(true);
  });
});
