#!/usr/bin/env node
// Platform-binary dispatcher for @goondocks/myco.
//
// npm's `bin` entry must be a single path, so it can't point straight at a
// platform-specific binary. This shim preserves that contract and resolves
// the real binary at run time.
//
// Before dispatching, the shim consults a layered `runtime.command` pin
// via runtime-redirect.cjs:
//   1. Project pin: walk up from cwd for `<dir>/.myco/runtime.command`
//      (written by `make dev-link`) — applies only when invoked from
//      inside an opted-in project.
//   2. Machine pin: `~/.myco/runtime.command` (written by the beta
//      installer) — applies everywhere as a fallback.
// Set `MYCO_DEBUG_REDIRECT=1` to trace redirect decisions on stderr.
//
// With no pin, the binary is resolved through three independent sources, in
// order, taking the first that exists on disk:
//
//   1. `vendor/resolved.json` — written by the `scripts/select-binary.mjs`
//      postinstall. Fastest path, but a GENERATED file: it is absent from the
//      published tarball, so any re-extraction of this package (`npm update
//      -g`, a reinstall) deletes it and only a postinstall run restores it.
//   2. `require.resolve` of the platform package — the same lookup the
//      postinstall performs, so it succeeds whenever the optional dependency
//      is installed, generated file or not.
//   3. The managed binary under myco-home — the postinstall CONVERGES a copy
//      there, and the curl installer and self-update write the same path, so
//      it is present on every converged install.
//
// Treating (1) as a cache rather than a hard dependency is deliberate. It
// previously WAS the only source, which made a routine `npm update -g`
// (re-extract, postinstall not re-run) leave a shim that hard-exited on every
// invocation while a perfectly healthy binary sat at both (2) and (3).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { maybeRedirect } = require('./runtime-redirect.cjs');

function die(message) {
  process.stderr.write(`[myco] ${message}\n`);
  process.exit(1);
}

function detectTarget() {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (platform === 'win32') return 'windows-x64';
  return null;
}

// Mirrors resolveMycoHome() in scripts/select-binary.mjs and src/grove/paths.ts.
function resolveMycoHome() {
  const configured = (process.env.MYCO_HOME || '').trim();
  if (!configured) return path.join(os.homedir(), '.myco');
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/') || configured.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

// Layout duplicated from scripts/managed-paths.mjs — this file is plain CJS in
// the published tarball and cannot require() that ESM module. The duplication
// is gated by tests/cli/myco-shim-resolution.test.ts, which plants the binary
// at the path managedBinaryPath() computes and asserts the shim finds it — so
// the two copies cannot drift apart silently on the host platform.
function managedBinaryPath() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
      || path.win32.join(os.homedir(), 'AppData', 'Local');
    return path.win32.join(localAppData, 'Myco', 'bin', 'myco.exe');
  }
  return path.posix.join(resolveMycoHome(), 'bin', 'myco');
}

maybeRedirect(__filename);

const pkgRoot = path.resolve(__dirname, '..');
const target = detectTarget();
const binaryName = process.platform === 'win32' ? 'myco.exe' : 'myco';

// Each source reports what it consulted and the candidate it produced (null
// when it has nothing to offer). Every source is reported whether or not it
// yielded a candidate: when nothing resolves, the operator needs to see that
// e.g. the platform package was looked for and is not installed — an omitted
// source reads as one that was never tried.
const sources = [
  () => {
    const resolvedPath = path.join(pkgRoot, 'vendor', 'resolved.json');
    let binaryPath = null;
    try {
      ({ binaryPath = null } = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8')));
    } catch {
      return { from: `${resolvedPath} (absent — postinstall has not run)`, candidate: null };
    }
    return binaryPath
      ? { from: `${resolvedPath} -> ${binaryPath}`, candidate: binaryPath }
      : { from: `${resolvedPath} (no "binaryPath" field)`, candidate: null };
  },
  () => {
    if (!target) return null;
    const specifier = `@goondocks/myco-${target}/bin/${binaryName}`;
    try {
      return { from: specifier, candidate: require.resolve(specifier) };
    } catch {
      return { from: `${specifier} (not installed)`, candidate: null };
    }
  },
  () => {
    const candidate = managedBinaryPath();
    return { from: `managed binary ${candidate}`, candidate };
  },
];

/**
 * Existence is not enough — the candidate must be executable.
 *
 * `select-binary.mjs` is what chmods the platform binary to 0755, so on an
 * install whose postinstall never ran the file is present at mode 0644.
 * Accepting it on existence alone dead-ends the whole resolution on a binary
 * that cannot run, instead of falling through to a source that can.
 */
function isRunnable(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let binaryPath = null;
const tried = [];
for (const source of sources) {
  const result = source();
  if (!result) continue;
  if (!result.candidate) {
    tried.push(result.from);
    continue;
  }
  if (isRunnable(result.candidate)) {
    tried.push(result.from);
    binaryPath = result.candidate;
    break;
  }
  // Distinguish the two rejections — "absent" and "present but mode 0644"
  // call for completely different repairs.
  tried.push(`${result.from} (${fs.existsSync(result.candidate) ? 'not executable' : 'absent'})`);
}

if (!binaryPath) {
  if (!target) {
    die(`unsupported platform ${process.platform}-${process.arch}`);
  }
  die(
    `no myco binary found for target "${target}". Tried:\n`
    + tried.map((entry) => `  - ${entry}`).join('\n')
    + `\nReinstall with: npm install --include=optional -g @goondocks/myco`
    + `\nor install directly: curl -fsSL https://myco.sh/install.sh | sh`,
  );
}

try {
  execFileSync(binaryPath, process.argv.slice(2), { stdio: 'inherit' });
} catch (err) {
  // A child that ran and exited non-zero reports a numeric status — pass it
  // through untouched. Anything else is a SPAWN failure (ENOENT, EACCES), and
  // exiting silently on those is how a broken install looks like a command
  // that simply produced no output.
  if (typeof err.status === 'number') process.exit(err.status);
  die(`could not execute ${binaryPath}: ${err.code || err.message}`);
}
