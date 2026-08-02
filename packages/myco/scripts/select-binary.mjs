// Postinstall: bootstrap npm into the single self-updating managed binary.
//
// Each supported platform has its own published package
// (`@goondocks/myco-<target>`) whose `package.json` carries the matching
// `os` and `cpu` filters. npm installs only the matching one; the rest are
// skipped. This script uses `require.resolve` to find the binary inside the
// installed platform package, writes `vendor/resolved.json` (so a fallback
// `bin/myco` dispatch can find it), and then CONVERGES: it copies the
// selected binary into the canonical managed location (`~/.myco/bin/myco`),
// reconciles the `runtime.command` pin so every CLI invocation re-execs the
// managed binary, and writes the install marker. The daemon heals the OS
// service unit on its next startup via `ensureSelfInstalledAsService`, so
// the postinstall does NOT need to call any service-install logic — doing so
// would require `dist/src/` modules that are never emitted in the published
// tarball (the build only produces a bun binary + `dist/ui/`).
//
// The path-layout helpers come from `./managed-paths.mjs` — a shared plain-ESM
// module imported BOTH here and (re-exported) by `src/install/managed-binary.ts`,
// so the postinstall and the compiled binary cannot disagree on the layout.
// (We still cannot import `dist/src/` — it is never emitted in the published
// tarball — which is why the shared module is plain ESM under `scripts/`.)
//
// This module exports `convergeNpmInstall` so the convergence mechanics are
// unit-testable in isolation. The postinstall side effects run only when the
// file is executed as the main module (the is-main guard at the bottom), so
// importing it for a test is side-effect free.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The PATH layout is imported from the shared `./managed-paths.mjs` module —
// the SINGLE source of truth that both this postinstall and the compiled binary
// (`src/install/managed-binary.ts` re-exports it) use, so they cannot drift.
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

/**
 * Converge the npm install onto the single managed binary. Pure-ish: all fs
 * I/O is confined to `home` / `dest`. Every step is wrapped so a failure logs
 * to stderr and is NON-FATAL — npm postinstall must never fail because the
 * daemon's lazy-spawn path and `myco doctor` still recover the gap.
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
export function convergeNpmInstall({ mycoHome, platform, resolvedBinary, dest, channel, version, versionedDest, writeMarker }) {
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
      // the launcher), so the rename fails EBUSY/EPERM. Task 9 handles the
      // win32 in-place swap; here we skip and continue, non-fatal.
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
  // A pin naming the managed binary (what earlier postinstalls wrote) is
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

  // --- Install marker -----------------------------------------------------
  // `writeMarker` is an optional injection seam for tests. Production callers
  // omit it; the inline fallback writes the same JSON shape.
  try {
    if (writeMarker) {
      writeMarker(mycoHome, { channel, source: 'npm', bin: dest });
    } else {
      fs.mkdirSync(mycoHome, { recursive: true });
      fs.writeFileSync(
        path.join(mycoHome, 'install.json'),
        JSON.stringify({ channel, source: 'npm', bin: dest }, null, 2),
      );
    }
  } catch (err) {
    log(`install marker skipped: ${err?.message ?? err}`);
  }

  return { dest, copied, pinAction };
}

/**
 * Derive the release channel from this package's own version: a semver
 * prerelease component (`-beta`, `-alpha`, `-rc`, …) => 'beta', else 'stable'.
 * Any error defaults to 'stable'.
 */
function deriveChannel(pkgRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
    return /-(?:beta|alpha|rc|next|canary|dev)\b/.test(String(pkg.version)) ? 'beta' : 'stable';
  } catch {
    return 'stable';
  }
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

  const vendorDir = path.join(pkgRoot, 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  const resolvedPath = path.join(vendorDir, 'resolved.json');
  fs.writeFileSync(
    resolvedPath,
    JSON.stringify({ target, binaryPath }, null, 2) + '\n',
    'utf-8',
  );

  process.stdout.write(`[myco] Selected platform binary: ${binaryPath}\n`);

  // Converge npm into the single managed binary. Skipped in source checkouts
  // (no platform binary present before `make dev-link`). Wrapped so a failure
  // logs to stderr and is NON-FATAL — the daemon's lazy-spawn path still works
  // and `myco doctor` surfaces any gap. Plan reference: Decision 13 / Step 12.
  //
  // Service install is intentionally NOT performed here. The daemon calls
  // `ensureSelfInstalledAsService` on every startup (daemon/main.ts), which is
  // idempotent and handles the service unit. Attempting it from the postinstall
  // would require dist/src/service/self-install.js, which is never emitted in
  // the published tarball.
  if (!isSourceCheckout) {
    try {
      const mycoHome = resolveMycoHome();
      const platform = process.platform;
      // `pkg.version` is the bare semver (e.g. "1.2.3") — npm packages never
      // carry the "myco/v" tag prefix that curl installers use. This is the
      // exact version string the daemon's versionBinaryPath() expects.
      let pkg = { version: null };
      try {
        pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
      } catch { /* version stays null; versionedDest skipped */ }
      const version = pkg.version ?? null;
      const dest = managedBinaryPath(mycoHome, platform, process.env.LOCALAPPDATA);
      const versionedDest = version
        ? versionBinaryPath(mycoHome, platform, version, process.env.LOCALAPPDATA)
        : null;
      const channel = deriveChannel(pkgRoot);
      convergeNpmInstall({
        mycoHome,
        platform,
        resolvedBinary: binaryPath,
        dest,
        channel,
        version,
        versionedDest,
      });
    } catch (err) {
      process.stderr.write(`[myco] Convergence skipped: ${err?.message ?? err}\n`);
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
