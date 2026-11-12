// Post-build sanity check.
//
// Checks:
//   1. The host-target binary exists at ../myco-<host>/bin/myco (or myco.exe).
//   2. The host-target binary's baked --version matches package.json.
//      (Catches the version-skew class of bug where sync-package-versions
//      ran AFTER the binary was already built — the binary embeds
//      `pkg.version` at compile time via setPluginVersion in
//      entries/cli.<target>.ts, so a stale binary keeps reporting an
//      old version even after the manifest is bumped.)
//
// For CI/release builds, you should additionally verify every release target —
// that loop lives in the workflow, not here.

import fs from 'node:fs';
import { isStampedSourceVersion } from './release-policy.mjs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { binaryFileName, hostReleaseTarget } from './release-targets.mjs';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  process.stderr.write(`[build:verify] ${message}\n`);
  process.exit(1);
}

const host = hostReleaseTarget() ?? fail(`Unsupported host platform: ${process.platform}-${process.arch}`);
const target = host.name;
const binaryName = binaryFileName(host);
const platformPkgDir = path.resolve(pkgRoot, '..', `myco-${target}`);
const binaryPath = path.join(platformPkgDir, 'bin', binaryName);
if (!fs.existsSync(binaryPath)) fail(`missing host binary: ${binaryPath}`);

const DEV_VERSION_PLACEHOLDER = '0.0.0-dev';
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));
const expectedVersion = pkg.version;
let bakedVersion;
const probeDir = fs.mkdtempSync(path.join(tmpdir(), 'myco-build-verify-'));
try {
  try {
    const probeBinary = path.join(probeDir, binaryName);
    fs.copyFileSync(binaryPath, probeBinary);
    bakedVersion = execFileSync(probeBinary, ['--version'], { cwd: probeDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
} catch (err) {
  fail(`cannot probe binary --version (${binaryPath}): ${err.message}`);
}
// Source binaries require a stamped build identity; release binaries require the exact manifest version.
const versionOk =
  bakedVersion === expectedVersion ||
  (expectedVersion === DEV_VERSION_PLACEHOLDER && isStampedSourceVersion(bakedVersion));
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
