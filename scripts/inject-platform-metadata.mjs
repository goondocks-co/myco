#!/usr/bin/env node
// Inject `os` and `cpu` fields into a platform package's package.json
// just before `npm pack`/`npm publish` runs in CI.
//
// We keep these fields OUT of the source-tree package.json because npm
// workspaces install eagerly validates os/cpu on every linked workspace —
// declaring `darwin-x64` in source breaks `npm install` for everyone on
// darwin-arm64. The published tarball needs them so npm's optional-dep
// resolver picks the matching platform package on user installs.
//
// Usage:
//   node scripts/inject-platform-metadata.mjs <target>
//
//   <target> is one of darwin-arm64 / darwin-x64 / linux-x64 /
//   linux-arm64 / windows-x64.
//
// Effect:
//   Reads `packages/myco-<target>/package.json`, sets `os` and `cpu` to
//   the target's pair, writes the file back. Idempotent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM_METADATA = {
  'darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
  'darwin-x64':   { os: ['darwin'], cpu: ['x64'] },
  'linux-x64':    { os: ['linux'],  cpu: ['x64'] },
  'linux-arm64':  { os: ['linux'],  cpu: ['arm64'] },
  'windows-x64':  { os: ['win32'],  cpu: ['x64'] },
};

const target = process.argv[2];
if (!target || !PLATFORM_METADATA[target]) {
  process.stderr.write(
    `[inject-platform-metadata] Usage: node ${path.basename(fileURLToPath(import.meta.url))} <target>\n` +
    `  valid: ${Object.keys(PLATFORM_METADATA).join(', ')}\n`,
  );
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(repoRoot, 'packages', `myco-${target}`, 'package.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const { os, cpu } = PLATFORM_METADATA[target];
pkg.os = os;
pkg.cpu = cpu;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

process.stdout.write(`[inject-platform-metadata] ${target}: os=${os.join(',')} cpu=${cpu.join(',')}\n`);
