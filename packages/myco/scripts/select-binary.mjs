// Postinstall: bootstrap npm into the single managed binary.
//
// Each supported platform has its own published package
// (`@goondocks/myco-<target>`) whose `package.json` carries the matching
// `os` and `cpu` filters. npm installs only the matching one; the rest are
// skipped. This script uses `require.resolve` to find the binary inside the
// installed platform package, converges it into the canonical managed binary,
// and publishes vendor/resolved.json for the npm dispatch path. Myco 2.0
// records its channel without installing a local daemon or service.
//
// The path layout, home-role predicates and marker publisher are shared
// plain-ESM modules used by both the postinstall and the compiled binary.
// Imports are side-effect free; only execution as the main module installs.

import fs from 'node:fs';
import { releaseKey, isV2Version } from './release-policy.mjs';
import { isMemberHome, legacyVaultFiles } from './home-role.mjs';
import { writeInstallMarker } from './install-marker.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Both the postinstall and compiled binary use the canonical path layout.
import { managedBinaryPath, versionBinaryPath } from './managed-paths.mjs';

// ---------------------------------------------------------------------------
// Myco-home resolution. Mirrors `src/grove/paths.ts` resolveMycoHome() for the
// postinstall (which cannot import TS): honors `$MYCO_HOME`, else `~/.myco`.
// ---------------------------------------------------------------------------

function resolveMycoHome() {
  const configured = process.env.MYCO_HOME?.trim();
  if (configured) {
    if (configured === '~') return os.homedir();
    if (configured.startsWith('~/') || configured.startsWith(`~${path.sep}`)) {
      return path.join(os.homedir(), configured.slice(2));
    }
    return path.resolve(configured);
  }
  return path.join(os.homedir(), '.myco');
}

function detectTarget() {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (platform === 'win32') return 'windows-x64';
  return null;
}

class LegacyInstallRefusal extends Error {}

function replacingLegacy(home, dest, version, replaceLegacy) {
  if (!version || !isV2Version(version)) return false;
  let current = null;
  if (fs.existsSync(dest)) {
    const probe = spawnSync(dest, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (probe.status !== 0) throw new LegacyInstallRefusal('Cannot inspect the installed Myco binary; nothing was replaced.');
    current = probe.stdout.match(/[0-9]+[.][0-9]+[.][0-9]+[^ \r\n]*/)?.[0];
    if (!current) throw new LegacyInstallRefusal('Cannot read the installed Myco version; nothing was replaced.');
  }
  const legacy = current?.startsWith('1.') || ((!current || !isV2Version(current)) && !isMemberHome(home) && legacyVaultFiles(home).length > 0);
  if (legacy && !replaceLegacy) {
    throw new LegacyInstallRefusal('Myco 1.4 is on this machine. Nothing was replaced. To opt in, set MYCO_REPLACE_LEGACY=1, then run myco login <invite link>, myco cutover --dry-run, and myco cutover.');
  }
  return legacy;
}

/**
 * Converge the npm install onto the single managed binary. Pure-ish: all fs
 * I/O is confined to `home` / `dest`. Legacy refusal and replacement staging
 * fail closed; placement failures for other installs are reported to stderr.
 *
 * `dest` and `versionedDest` are INJECTED so tests can supply arbitrary paths
 * without touching the real home directory.
 *
 * Layout produced (mirrors install.sh / the daemon helpers):
 *   `versionedDest`  → <bindir>/versions/<bare-semver>/myco[.exe]
 *   `dest`           → <bindir>/myco[.exe]  (stable, current slot)
 *
 * Sequence: place at versioned slot via atomic temp+rename, then copy from
 * the versioned slot to the stable path via a second atomic temp+rename. A
 * partial copy can never leave a broken stable binary.
 *
 * Returns `{ dest, copied, pinAction }` for callers/tests to assert.
 *
 * @param {{ mycoHome: string, platform: string, resolvedBinary: string, dest: string, channel: string, version?: string, versionedDest?: string, writeMarker?: Function }} args
 */
export function convergeNpmInstall({ mycoHome, platform, resolvedBinary, dest, channel, version, versionedDest, writeMarker, replaceLegacy = process.env.MYCO_REPLACE_LEGACY === '1' }) {
  let replacedLegacy;
  try {
    replacedLegacy = replacingLegacy(mycoHome, dest, version, replaceLegacy);
  } catch (error) {
    throw new LegacyInstallRefusal(error.message);
  }
  if (replacedLegacy && !versionedDest) throw new LegacyInstallRefusal(
    'A versioned destination is required before replacing Myco 1.4. Nothing was replaced.',
  );
  const log = (msg) => process.stderr.write(`[myco] ${msg}\n`);
  let copied = false;
  let pinAction = 'skipped';

  // --- Step 1: Atomic placement into the versioned slot -------------------
  // When `versionedDest` is provided, place the binary at the versioned path
  // first. This is the canonical layout: <bindir>/versions/<semver>/myco[.exe].
  // Uses the same temp+rename pattern as the stable copy below.
  let sourceForStable = resolvedBinary;
  if (versionedDest) {
    try {
      fs.mkdirSync(path.dirname(versionedDest), { recursive: true });
      if (replacedLegacy) fs.writeFileSync(path.join(path.dirname(versionedDest), '.adopt-failed'), new Date().toISOString());
      const tmpV = `${versionedDest}.tmp-${process.pid}`;
      try {
        fs.copyFileSync(resolvedBinary, tmpV);
        if (platform !== 'win32') {
          try { fs.chmodSync(tmpV, 0o755); } catch { /* best effort */ }
        }
        fs.renameSync(tmpV, versionedDest);
        // Stable copy reads from the versioned slot — ensures both paths
        // hold identical bytes from the same verified source.
        sourceForStable = versionedDest;
      } catch (err) {
        try { fs.rmSync(tmpV, { force: true }); } catch { /* best effort */ }
        throw err;
      }
    } catch (err) {
      if (replacedLegacy) throw new LegacyInstallRefusal(`Myco 1.4 replacement could not be staged: ${err.message}`);
      log(`versioned binary placement skipped: ${err?.message ?? err}`);
      // Fall back to copying directly from the resolved source binary.
    }
  }

  // --- Step 2: Atomic copy to the stable dest ----------------------------
  // Write to a pid-suffixed temp file in the same directory, then rename onto
  // `dest`. A reader either sees the old binary or the new one, never a
  // half-written file.
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    try {
      fs.copyFileSync(sourceForStable, tmp);
      if (platform !== 'win32') {
        try { fs.chmodSync(tmp, 0o755); } catch { /* best effort */ }
      }
      fs.renameSync(tmp, dest);
      copied = true;
    } catch (err) {
      // Clean up the temp file on any failure.
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      // On win32 the existing managed binary may be running (the daemon /
      // the launcher), so the rename fails EBUSY/EPERM during a
      // win32 in-place swap; leave the old binary and marker in place.
      if (platform === 'win32' && (err?.code === 'EBUSY' || err?.code === 'EPERM')) {
        log('managed binary in use; skipped (win32 swap deferred to update path)');
      } else {
        throw err;
      }
    }
  } catch (err) {
    log(`managed binary copy skipped: ${err?.message ?? err}`);
  }

  // --- Pin migration ------------------------------------------------------
  // `runtime.command` is an operator override; its absence is the normal
  // state — every consumer falls through to the managed binary on its own.
  // A pin naming the managed binary is
  // redundant by construction and is removed. Any other pin carries operator
  // intent and is untouched.
  try {
    const pinPath = path.join(mycoHome, 'runtime.command');
    let pin = '';
    try { pin = fs.readFileSync(pinPath, 'utf8').trim(); } catch { /* absent */ }

    // Removable pins: one naming the managed binary (redundant — resolution
    // reaches it without the pin), or one under a foreign node_modules (its
    // target is deleted by any npm update). An active managed-runtime pin
    // (<mycoHome>/runtime/node_modules/) and every other pin carry intent and
    // are untouched.
    const normalize = (p) => p.split(path.sep).join('/');
    const managedPrefix = `${normalize(path.join(mycoHome, 'runtime'))}/node_modules/`;
    const isManagedRuntimePin = pin !== '' && normalize(pin).startsWith(managedPrefix);
    const isRetiredNpmPin = pin.includes('/node_modules/') && !isManagedRuntimePin;

    if (pin === dest || isRetiredNpmPin) {
      fs.rmSync(pinPath, { force: true });
      pinAction = 'removed-redundant';
    } else if (pin !== '') {
      log('runtime.command pin preserved (operator override); not touching');
      pinAction = 'preserved-external';
    }
  } catch (err) {
    log(`runtime.command migration skipped: ${err?.message ?? err}`);
  }

  // Publish the channel only for a binary that reached its managed destination.
  if (copied) {
    (writeMarker ?? writeInstallMarker)(mycoHome, { channel, source: 'npm', bin: dest });
  }

  return { dest, copied, pinAction };
}

const DEVELOPMENT_VERSION = '0.0.0-dev';

/** Package alpha builds record alpha; beta/RC and local development builds record beta. */
export function deriveChannel(pkgRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  if (pkg.version === DEVELOPMENT_VERSION) return 'beta';
  const parsed = typeof pkg.version === 'string' ? releaseKey(pkg.version) : null;
  if (!parsed) throw new Error('Package version is not a valid release version');
  return parsed.phase === 'rc' ? 'beta' : parsed.phase;
}

async function main() {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const require = createRequire(import.meta.url);

  const target = detectTarget();
  if (!target) {
    process.stderr.write(
      `[myco] Unsupported platform: ${process.platform}-${process.arch}. ` +
      `Supported: darwin-{arm64,x64}, linux-{x64,arm64}, windows-x64.\n`,
    );
    process.exit(1);
  }

  const platformPkg = `@goondocks/myco-${target}`;
  const binaryName = process.platform === 'win32' ? 'myco.exe' : 'myco';

  // Source-checkout escape hatch: during local dev (`npm ci` in the monorepo)
  // the platform package's `bin/` directory is empty until `make dev-link` (or
  // an explicit `npm run build:binary`) compiles the host-target binary into
  // it. Detect that state via the presence of `src/`, and exit 0 with a hint
  // so monorepo installs don't trip postinstall.
  const isSourceCheckout = fs.existsSync(path.join(pkgRoot, 'src'));

  let binaryPath;
  try {
    binaryPath = require.resolve(`${platformPkg}/bin/${binaryName}`);
  } catch (err) {
    if (isSourceCheckout) {
      process.stderr.write(
        `[myco] No platform binary found in ${platformPkg}/bin/${binaryName}. ` +
        `Skipping postinstall in source checkout (expected before \`make dev-link\`).\n`,
      );
      process.exit(0);
    }
    process.stderr.write(
      `[myco] Platform binary package ${platformPkg} is not installed. ` +
      `npm should have installed it as an optionalDependency of @goondocks/myco. ` +
      `Try: npm install --include=optional -g @goondocks/myco\n` +
      `(reason: ${err.message})\n`,
    );
    process.exit(1);
  }

  if (process.platform !== 'win32') {
    try { fs.chmodSync(binaryPath, 0o755); } catch { /* best effort */ }
  }

  // Refuse an unsafe replacement before publishing the npm dispatch target.
  if (!isSourceCheckout) {
    const mycoHome = resolveMycoHome();
    const platform = process.platform;
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
    const channel = deriveChannel(pkgRoot);
    const version = pkg.version;
    const dest = managedBinaryPath(mycoHome, platform, process.env.LOCALAPPDATA);
    const versionedDest = versionBinaryPath(mycoHome, platform, version, process.env.LOCALAPPDATA);
    const result = convergeNpmInstall({
      mycoHome,
      platform,
      resolvedBinary: binaryPath,
      dest,
      channel,
      version,
      versionedDest,
    });
    if (!result.copied) throw new Error('The managed binary could not be placed; npm dispatch was not changed.');
  }
  const vendorDir = path.join(pkgRoot, 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  const resolvedPath = path.join(vendorDir, 'resolved.json');
  fs.writeFileSync(
    resolvedPath,
    JSON.stringify({ target, binaryPath }, null, 2) + '\n',
    'utf-8',
  );

  process.stdout.write(`[myco] Selected platform binary: ${binaryPath}\n`);


}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
