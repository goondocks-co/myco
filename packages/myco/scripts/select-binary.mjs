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
// managed binary, writes the install marker, and re-points the OS service at
// the managed binary. npm thus becomes a one-time bootstrap that hands off to
// the same self-updating binary the curl installer produces.
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
 * `dest` is INJECTED (not computed here) so the path lives in exactly one
 * place — `@myco/install/managed-binary` — which prod computes from the
 * compiled `dist` module and tests compute from the `.ts`. Same source, zero
 * `.ts`/`.mjs` drift.
 *
 * Returns `{ dest, copied, pinAction }` for callers/tests to assert.
 *
 * @param {{ home: string, platform: string, resolvedBinary: string, dest: string, channel: string }} args
 */
export function convergeNpmInstall({ home, platform, resolvedBinary, dest, channel, writeMarker }) {
  const log = (msg) => process.stderr.write(`[myco] ${msg}\n`);
  const mycoHome = path.join(home, '.myco');
  let copied = false;
  let pinAction = 'skipped';

  // --- Atomic copy: never truncate `dest` in place ------------------------
  // Write to a pid-suffixed temp file in the same directory, then rename onto
  // `dest`. A reader either sees the old binary or the new one, never a
  // half-written file.
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    try {
      fs.copyFileSync(resolvedBinary, tmp);
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

  // --- Pin reconciliation -------------------------------------------------
  // `runtime.command` is the machine pin every CLI shim re-execs. We may
  // safely point it at the managed binary, but must NOT clobber an active
  // beta managed-runtime pin or a deliberate external/dev pin.
  try {
    const pinPath = path.join(mycoHome, 'runtime.command');
    let pin = '';
    try { pin = fs.readFileSync(pinPath, 'utf8').trim(); } catch { /* absent */ }

    // Preserve a legacy managed-runtime pin (a path under ~/.myco/runtime/node_modules/)
    // so a pre-native-installer setup isn't stranded.
    const normalize = (p) => p.split(path.sep).join('/');
    const managedPrefix = `${normalize(path.join(mycoHome, 'runtime'))}/node_modules/`;
    const isManagedRuntimePin = pin !== '' && normalize(pin).startsWith(managedPrefix);

    const shouldWrite =
      pin === '' ||
      pin === dest ||
      (pin.includes('/node_modules/') && !isManagedRuntimePin);

    if (shouldWrite) {
      fs.mkdirSync(mycoHome, { recursive: true });
      fs.writeFileSync(pinPath, `${dest}\n`, { mode: 0o644 });
      // `mode` in writeFileSync is masked by umask; chmod to be certain the
      // pin is never group/other-writable (runtime-redirect.cjs refuses it).
      try { fs.chmodSync(pinPath, 0o644); } catch { /* best effort */ }
      pinAction = 'wrote';
    } else if (isManagedRuntimePin) {
      log('legacy managed-runtime pin detected; not re-pointing runtime.command');
      pinAction = 'preserved-managed';
    } else {
      log('external runtime.command pin preserved; not re-pointing');
      pinAction = 'preserved-external';
    }
  } catch (err) {
    log(`runtime.command reconcile skipped: ${err?.message ?? err}`);
  }

  // --- Install marker -----------------------------------------------------
  // When `writeMarker` is injected (production: `managed.writeInstallMarker`
  // from dist/src/install/managed-binary.js), delegate to the canonical helper
  // so the format is defined in exactly one place.  Tests that call
  // convergeNpmInstall directly do not inject `writeMarker`, so the inline
  // fallback keeps convergence unit-testable without a compiled dist/.
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

  // Converge npm into the single managed binary, then self-install/repoint the
  // OS service at it. Skipped in source checkouts (no published dist/). Both
  // steps are wrapped so neither can fail the postinstall — the daemon's
  // lazy-spawn path still works and `myco doctor` surfaces any gap.
  // Plan reference: Decision 13 / Step 12.
  if (!isSourceCheckout) {
    const distManagedBinary = path.join(pkgRoot, 'dist/src/install/managed-binary.js');
    let dest = null;
    if (fs.existsSync(distManagedBinary)) {
      try {
        const managed = await import(distManagedBinary);
        dest = managed.managedBinaryPath(os.homedir(), process.platform);
        const channel = deriveChannel(pkgRoot);
        convergeNpmInstall({
          home: os.homedir(),
          platform: process.platform,
          resolvedBinary: binaryPath,
          dest,
          channel,
          writeMarker: managed.writeInstallMarker,
        });
      } catch (err) {
        process.stderr.write(`[myco] Convergence skipped: ${err?.message ?? err}\n`);
      }
    } else {
      process.stderr.write('[myco] Convergence skipped: managed-binary module not found in dist/\n');
    }

    const distSelfInstall = path.join(pkgRoot, 'dist/src/service/self-install.js');
    if (fs.existsSync(distSelfInstall)) {
      try {
        const mod = await import(distSelfInstall);
        const stderrLogger = {
          info: (kind, message) => process.stderr.write(`[myco] ${kind}: ${message}\n`),
          debug: () => undefined,
          warn: (kind, message) => process.stderr.write(`[myco] ${kind}: ${message}\n`),
          error: (kind, message) => process.stderr.write(`[myco] ${kind}: ${message}\n`),
        };
        // Re-point the service unit at the managed binary so a self-update's
        // in-place swap takes effect on the next supervisor restart. Falls
        // back to the default executable inside self-install if `dest` is null.
        await mod.ensureSelfInstalledAsService(stderrLogger, dest ? { executable: dest } : {});
      } catch (err) {
        process.stderr.write(`[myco] Service install skipped: ${err?.message ?? err}\n`);
      }
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
