// Postinstall: locate the platform-specific binary that npm should have
// installed as an optionalDependency, mark it executable, and write
// `vendor/resolved.json` so `bin/myco` can dispatch without re-resolving on
// every invocation.
//
// Each supported platform has its own published package
// (`@goondocks/myco-<target>`) whose `package.json` carries the matching
// `os` and `cpu` filters. npm installs only the matching one; the rest are
// skipped. This script uses `require.resolve` to find the binary inside the
// installed platform package, and exits non-zero with a clear message if
// nothing resolves — do NOT silently succeed, because `bin/myco` would then
// fail at every call.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function detectTarget() {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (platform === 'win32') return 'windows-x64';
  return null;
}

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

// Self-install as a managed OS service so launchd / systemd starts the
// daemon at every login from the moment Myco is installed. Skipped in
// source checkouts (no published dist/), skipped silently on failure
// (the daemon's lazy-spawn path still works; doctor will surface the
// gap). Plan reference: Decision 13 / Step 12.
if (!isSourceCheckout) {
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
      await mod.ensureSelfInstalledAsService(stderrLogger);
    } catch (err) {
      process.stderr.write(`[myco] Service install skipped: ${err?.message ?? err}\n`);
    }
  }
}
