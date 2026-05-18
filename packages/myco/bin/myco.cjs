#!/usr/bin/env node
// Platform-binary dispatcher for @goondocks/myco.
//
// The host-specific binary lives in a separate npm package
// (`@goondocks/myco-<target>`) installed automatically as an
// `optionalDependency`. At postinstall, `scripts/select-binary.mjs` uses
// `require.resolve` to locate it and writes `vendor/resolved.json` with the
// absolute `binaryPath`. This shim reads that file and `execFileSync`s the
// binary with forwarded argv.
//
// Before dispatching, the shim consults a layered `runtime.command` pin
// via runtime-redirect.cjs:
//   1. Project pin: walk up from cwd for `<dir>/.myco/runtime.command`
//      (written by `make dev-link`) — applies only when invoked from
//      inside an opted-in project.
//   2. Machine pin: `~/.myco/runtime.command` (written by the beta
//      installer) — applies everywhere as a fallback.
// When neither pin matches, the shim runs the bundled production binary.
// Set `MYCO_DEBUG_REDIRECT=1` to trace redirect decisions on stderr.
//
// Rationale: npm's `bin` entry must be a single path. We can't point it
// directly at a platform-specific binary without a post-install step. This
// shim preserves the single-bin-entry contract while letting us pick the
// right binary at install time.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { maybeRedirect } = require('./runtime-redirect.cjs');

function die(message) {
  process.stderr.write(`[myco] ${message}\n`);
  process.exit(1);
}

maybeRedirect(__filename);

const pkgRoot = path.resolve(__dirname, '..');
const resolvedPath = path.join(pkgRoot, 'vendor', 'resolved.json');

let resolved;
try {
  resolved = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
} catch (err) {
  die(`could not read ${resolvedPath} — did postinstall run? (${err.message})`);
}

const { target, binaryPath } = resolved;
if (!target) die(`invalid ${resolvedPath} — missing "target" field`);
if (!binaryPath) die(`invalid ${resolvedPath} — missing "binaryPath" field`);

if (!fs.existsSync(binaryPath)) {
  die(
    `platform binary missing at ${binaryPath} for target "${target}" — ` +
    `the @goondocks/myco-${target} package may have been removed; reinstall with: ` +
    `npm install --include=optional -g @goondocks/myco`,
  );
}

try {
  execFileSync(binaryPath, process.argv.slice(2), { stdio: 'inherit' });
} catch (err) {
  if (err.code === 'ENOENT') die(`platform binary at ${binaryPath} could not be executed`);
  process.exit(err.status ?? 1);
}
