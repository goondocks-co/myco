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
  // The temp dir IS the resolved myco-home (what the daemon passes as the
  // `mycoHome` arg — `resolveMycoHome()` = `~/.myco` / `$MYCO_HOME`). The managed
  // layout (`bin/`, `bin/versions/`, `runtime.command`, `install.json`) lives
  // directly under it.
  mycoHome: string;
  resolvedBinary: string;
}

function makeFixture(): Fixture {
  const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-converge-home-'));
  // A fake "source" platform binary that convergence copies into the managed
  // bin dir. Distinct content so we can assert byte-for-byte placement. Kept in
  // a sibling dir so it doesn't collide with the managed `bin/` layout.
  const srcDir = path.join(mycoHome, 'fake-platform-pkg', 'bin');
  fs.mkdirSync(srcDir, { recursive: true });
  const resolvedBinary = path.join(srcDir, 'myco');
  fs.writeFileSync(resolvedBinary, 'FAKE-MYCO-BINARY-CONTENT');
  return { mycoHome, resolvedBinary };
}

function writePin(mycoHome: string, value: string): void {
  const pinPath = path.join(mycoHome, 'runtime.command');
  fs.mkdirSync(path.dirname(pinPath), { recursive: true });
  fs.writeFileSync(pinPath, `${value}\n`, { mode: 0o644 });
}

function readPin(mycoHome: string): string {
  return fs.readFileSync(path.join(mycoHome, 'runtime.command'), 'utf8').trim();
}

describe('select-binary convergeNpmInstall', () => {
  let fixtures: Fixture[] = [];

  afterEach(() => {
    for (const f of fixtures) fs.rmSync(f.mycoHome, { recursive: true, force: true });
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
    const { mycoHome, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(mycoHome, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(mycoHome, PLATFORM);

    const result = convergeNpmInstall({
      mycoHome,
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
    expect(dest).toBe(managedBinaryPath(mycoHome, PLATFORM));
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toBe('FAKE-MYCO-BINARY-CONTENT');
    // The single-.myco invariant: the managed path is rooted at the myco-home,
    // never doubled.
    expect(dest).not.toContain('.myco/.myco');

    // (b) no leftover temp files from the atomic placement.
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
    const { mycoHome, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(mycoHome, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(mycoHome, PLATFORM);

    convergeNpmInstall({
      mycoHome,
      platform: PLATFORM,
      resolvedBinary,
      dest,
      channel: 'stable',
      version: TEST_VERSION,
      versionedDest: versionedPath,
    });

    const binaryName = PLATFORM === 'win32' ? 'myco.exe' : 'myco';
    expect(versionedPath).toContain(`versions/${TEST_VERSION}/${binaryName}`);
    expect(fs.existsSync(versionedPath)).toBe(true);
  });

  it('writes the runtime.command pin to dest, never group/other-writable (c)', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const { mycoHome, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(mycoHome, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(mycoHome, PLATFORM);

    convergeNpmInstall({
      mycoHome,
      platform: PLATFORM,
      resolvedBinary,
      dest,
      channel: 'stable',
      version: TEST_VERSION,
      versionedDest: versionedPath,
    });

    expect(readPin(mycoHome)).toBe(dest);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(mycoHome, 'runtime.command')).mode & 0o777;
      expect(mode & 0o022).toBe(0);
    }
  });

  it('writes the install marker with source=npm, bin=dest, and channel (d)', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const { mycoHome, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(mycoHome, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(mycoHome, PLATFORM);

    convergeNpmInstall({
      mycoHome,
      platform: PLATFORM,
      resolvedBinary,
      dest,
      channel: 'beta',
      version: TEST_VERSION,
      versionedDest: versionedPath,
    });

    const marker = JSON.parse(fs.readFileSync(path.join(mycoHome, 'install.json'), 'utf8'));
    expect(marker.source).toBe('npm');
    expect(marker.bin).toBe(dest);
    expect(marker.channel).toBe('beta');
  });

  it('preserves a pre-existing managed-runtime pin (e)', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const { mycoHome, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(mycoHome, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(mycoHome, PLATFORM);
    // An ACTIVE beta managed runtime pin: <mycoHome>/runtime/node_modules/...
    const managedRuntimePin = path.join(mycoHome, 'runtime', 'node_modules', '.bin', 'myco');
    writePin(mycoHome, managedRuntimePin);

    const result = convergeNpmInstall({
      mycoHome,
      platform: PLATFORM,
      resolvedBinary,
      dest,
      channel: 'stable',
      version: TEST_VERSION,
      versionedDest: versionedPath,
    });

    // Pin is untouched — the binary still converges, but we do NOT clobber an
    // active managed runtime.
    expect(readPin(mycoHome)).toBe(managedRuntimePin);
    expect(result.pinAction).not.toBe('wrote');
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('re-points a legacy node_modules pin onto the managed binary (f)', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const { mycoHome, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(mycoHome, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(mycoHome, PLATFORM);
    // A legacy npm install pin: inside node_modules but NOT the managed runtime.
    const legacyPin = '/somewhere/node_modules/@goondocks/myco-darwin-arm64/bin/myco';
    writePin(mycoHome, legacyPin);

    const result = convergeNpmInstall({
      mycoHome,
      platform: PLATFORM,
      resolvedBinary,
      dest,
      channel: 'stable',
      version: TEST_VERSION,
      versionedDest: versionedPath,
    });

    expect(readPin(mycoHome)).toBe(dest);
    expect(result.pinAction).toBe('wrote');
  });

  it('preserves a deliberate external/dev pin (not node_modules, not managed-runtime) (g)', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const { mycoHome, resolvedBinary } = fixture;
    const versionedPath = versionBinaryPath(mycoHome, PLATFORM, TEST_VERSION);
    const dest = managedBinaryPath(mycoHome, PLATFORM);
    // A deliberate external/dev pin: no /node_modules/ segment, not under
    // <mycoHome>/runtime/. Convergence must NEVER clobber this.
    const externalPin = path.join(mycoHome, '.local', 'bin', 'myco-dev');
    writePin(mycoHome, externalPin);
    const pinBefore = readPin(mycoHome);

    const result = convergeNpmInstall({
      mycoHome,
      platform: PLATFORM,
      resolvedBinary,
      dest,
      channel: 'stable',
      version: TEST_VERSION,
      versionedDest: versionedPath,
    });

    // Pin is byte-identical to what was written — not overwritten with dest.
    expect(readPin(mycoHome)).toBe(pinBefore);
    expect(readPin(mycoHome)).toBe(externalPin);
    expect(result.pinAction).toBe('preserved-external');
    expect(fs.existsSync(dest)).toBe(true);
  });
});
