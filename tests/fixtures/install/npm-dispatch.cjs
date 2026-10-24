#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { maybeRedirect } = require('./runtime-redirect.cjs');
const resolution = require('./binary-resolution.cjs');

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

maybeRedirect(__filename);

const pkgRoot = path.resolve(__dirname, '..');
const target = detectTarget();
const binaryName = process.platform === 'win32' ? 'myco.exe' : 'myco';
const sources = [
  () => {
    const candidate = resolution.managedBinaryPath(resolution.resolveMycoHome(), process.platform, process.env.LOCALAPPDATA);
    return { from: `managed binary ${candidate}`, candidate };
  },
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
];


let binaryPath = null;
const tried = [];
for (const source of sources) {
  const result = source();
  if (!result) continue;
  if (!result.candidate) {
    tried.push(result.from);
    continue;
  }
  if (resolution.isRunnableBinary(result.candidate)) {
    tried.push(result.from);
    binaryPath = result.candidate;
    break;
  }
  tried.push(`${result.from} (${fs.existsSync(result.candidate) ? 'not executable' : 'absent'})`);
}

if (!binaryPath) {
  if (!target) {
    die(`unsupported platform ${process.platform}-${process.arch}`);
  }
  die(
    `no myco binary found for target "${target}". Tried:\n`
    + tried.map((entry) => `  - ${entry}`).join('\n'),
  );
}

try {
  execFileSync(binaryPath, process.argv.slice(2), { stdio: 'inherit' });
} catch (err) {
  if (typeof err.status === 'number') process.exit(err.status);
  if (err.signal) {
    const signals = require('node:os').constants.signals;
    process.exit(128 + (signals[err.signal] || 0));
  }
  die(`could not execute ${binaryPath}: ${err.code || err.message}`);
}
