#!/usr/bin/env node
// Platform-binary dispatcher for @goondocks/myco.
//
// The npm package ships pre-compiled Bun binaries under `vendor/<target>/myco`
// for each supported platform. At postinstall, `scripts/select-binary.mjs`
// writes `vendor/resolved.json` with the host target. This shim reads that
// file and execFileSyncs the correct binary with forwarded argv.
//
// Before dispatching, the shim consults `.myco/runtime.command` via
// runtime-redirect.cjs. Projects that pin a local runtime (beta channel,
// dogfood) are re-exec'd into that binary so the interactive CLI matches
// the binary the project's daemon, hooks, and MCP server already use.
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

const { target } = resolved;
if (!target) die(`invalid ${resolvedPath} — missing "target" field`);

const binaryName = process.platform === 'win32' ? 'myco.exe' : 'myco';
const binaryPath = path.join(pkgRoot, 'vendor', target, binaryName);

if (!fs.existsSync(binaryPath)) {
  die(`platform binary missing at ${binaryPath} for target "${target}"`);
}

try {
  execFileSync(binaryPath, process.argv.slice(2), { stdio: 'inherit' });
} catch (err) {
  if (err.code === 'ENOENT') die(`platform binary at ${binaryPath} could not be executed`);
  process.exit(err.status ?? 1);
}
