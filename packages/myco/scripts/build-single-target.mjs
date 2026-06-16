// Build a single target via TARGET env var — used by CI matrix, Makefile
// dev-link, and the plain `npm run build` local flow. Defaults to the host
// platform when TARGET is unset so local builds don't need all five targets
// staged. No shell interpolation.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function detectHostTarget() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (process.platform === 'win32') return 'windows-x64';
  return null;
}

const target = process.env.TARGET ?? detectHostTarget();
if (!target) {
  process.stderr.write(`[build:binary] no TARGET and host platform ${process.platform}-${process.arch} is unsupported\n`);
  process.exit(2);
}

const VALID = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'windows-x64']);
if (!VALID.has(target)) {
  process.stderr.write(`[build:binary] unknown TARGET="${target}" (valid: ${[...VALID].join(', ')})\n`);
  process.exit(2);
}

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(pkgRoot, 'src', 'entries', `cli.${target}.ts`);
if (!fs.existsSync(entry)) {
  process.stderr.write(`[build:binary] missing entry: ${entry}\n`);
  process.exit(1);
}

const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));
const mycoVersion = pkgJson.version;

// Compile the binary directly into its per-platform npm package
// (`packages/myco-<target>/bin/`). The core package's postinstall then uses
// `require.resolve('@goondocks/myco-<target>/bin/<bin>')` to locate it at
// runtime. Workspace symlinks make this work in monorepo dev too.
const platformPkgDir = path.resolve(pkgRoot, '..', `myco-${target}`);
const outputDir = path.join(platformPkgDir, 'bin');
fs.mkdirSync(outputDir, { recursive: true });
const binaryName = target.startsWith('windows-') ? 'myco.exe' : 'myco';
const outfile = path.join(outputDir, binaryName);

// Bun's `-baseline` x64 variant omits modern SIMD (AVX2). Required to run
// under Windows-on-ARM x64 emulation (pre-24H2 lacks AVX2) and on older x64
// CPUs. Opt in with BASELINE=1; native x64 hardware uses the default build.
const bunTarget = process.env.BASELINE === '1' ? `bun-${target}-baseline` : `bun-${target}`;

process.stdout.write(`[build:binary] ${target} (${bunTarget}) -> ${outfile} (version ${mycoVersion})\n`);
const result = spawnSync(
  'bun',
  ['build', '--compile', '--minify', `--target=${bunTarget}`, entry, '--outfile', outfile],
  { stdio: 'inherit', cwd: pkgRoot, env: process.env },
);
process.exit(result.status ?? 1);
