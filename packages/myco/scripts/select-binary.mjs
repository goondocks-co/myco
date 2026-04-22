// Postinstall: detect the host platform/arch, verify that the matching
// platform binary shipped in the tarball exists, mark it executable, and
// write `vendor/resolved.json` so `bin/myco` can dispatch without re-detecting
// on every invocation.
//
// Runs under Node (triggered by `npm install` / `npm install -g`). Exits
// non-zero with a clear message if the host platform is unsupported — do
// NOT silently succeed, because `bin/myco` would then fail at every call.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const binaryName = process.platform === 'win32' ? 'myco.exe' : 'myco';
const binaryPath = path.join(pkgRoot, 'vendor', target, binaryName);

// During dev-link (Makefile) no vendor/ is populated — skip cleanly so the
// dev workflow isn't blocked by a missing production artifact.
if (!fs.existsSync(binaryPath)) {
  process.stderr.write(
    `[myco] No platform binary found at vendor/${target}/${binaryName}. ` +
    `Skipping postinstall (expected in dev-link; error in production install).\n`,
  );
  process.exit(0);
}

if (process.platform !== 'win32') {
  try { fs.chmodSync(binaryPath, 0o755); } catch { /* best effort */ }
}

const resolvedPath = path.join(pkgRoot, 'vendor', 'resolved.json');
fs.writeFileSync(resolvedPath, JSON.stringify({ target }, null, 2) + '\n', 'utf-8');

process.stdout.write(`[myco] Selected platform binary: vendor/${target}/${binaryName}\n`);
