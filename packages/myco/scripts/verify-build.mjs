// Post-build sanity check. Replaces the old inline one-liner that only
// verified the UI bundle.
//
// Checks:
//   1. UI bundle exists at dist/ui/index.html.
//   2. The host-target binary exists at vendor/<host>/myco (or myco.exe).
//
// For CI/release builds, you should additionally verify all 5 targets —
// that loop lives in the workflow, not here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  process.stderr.write(`[build:verify] ${message}\n`);
  process.exit(1);
}

function hostTarget() {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (platform === 'win32') return 'windows-x64';
  fail(`Unsupported host platform: ${platform}-${arch}`);
}

const uiIndex = path.join(pkgRoot, 'dist', 'ui', 'index.html');
if (!fs.existsSync(uiIndex)) fail(`missing UI bundle: ${uiIndex}`);

const target = hostTarget();
const binaryName = process.platform === 'win32' ? 'myco.exe' : 'myco';
const binaryPath = path.join(pkgRoot, 'vendor', target, binaryName);
if (!fs.existsSync(binaryPath)) fail(`missing host binary: ${binaryPath}`);

const stat = fs.statSync(binaryPath);
process.stdout.write(
  `[build:verify] OK — UI bundle + ${target} binary (${Math.round(stat.size / 1024 / 1024)} MB)\n`,
);
