// Post-build sanity check. Replaces the old inline one-liner that only
// verified the UI bundle.
//
// Checks:
//   1. UI bundle exists at dist/ui/index.html.
//   2. The host-target binary exists at ../myco-<host>/bin/myco (or myco.exe).
//   3. The host-target binary's baked --version matches package.json.
//      (Catches the version-skew class of bug where sync-package-versions
//      ran AFTER the binary was already built — the binary embeds
//      `pkg.version` at compile time via setPluginVersion in
//      entries/cli.<target>.ts, so a stale binary keeps reporting an
//      old version even after the manifest is bumped.)
//
// For CI/release builds, you should additionally verify all 5 targets —
// that loop lives in the workflow, not here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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
const platformPkgDir = path.resolve(pkgRoot, '..', `myco-${target}`);
const binaryPath = path.join(platformPkgDir, 'bin', binaryName);
if (!fs.existsSync(binaryPath)) fail(`missing host binary: ${binaryPath}`);

const DEV_VERSION_PLACEHOLDER = '0.0.0-dev';
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));
const expectedVersion = pkg.version;
let bakedVersion;
try {
  bakedVersion = execFileSync(binaryPath, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
} catch (err) {
  fail(`cannot probe binary --version (${binaryPath}): ${err.message}`);
}
// Dev builds stamp the git description (`0.0.0-dev+<describe>`) into the binary
// while package.json keeps the placeholder — build-single-target.mjs restores it
// after compile. Accept that; require an exact match only for release builds
// (where sync-package-versions has written a concrete version into package.json).
const versionOk =
  bakedVersion === expectedVersion ||
  (expectedVersion === DEV_VERSION_PLACEHOLDER && bakedVersion.startsWith(`${DEV_VERSION_PLACEHOLDER}+`));
if (!versionOk) {
  fail(
    `binary version mismatch — package.json says ${expectedVersion} but ` +
    `${binaryPath} --version reports ${bakedVersion}. For a release build the ` +
    `binary was likely compiled before \`sync-package-versions.mjs\` bumped the ` +
    `manifest — re-run \`npm run build:binary\` after the version bump.`,
  );
}

const stat = fs.statSync(binaryPath);
process.stdout.write(
  `[build:verify] OK — UI bundle + ${target} binary (${Math.round(stat.size / 1024 / 1024)} MB, version ${bakedVersion})\n`,
);
