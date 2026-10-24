// Build a single target via TARGET env var — used by CI matrix, Makefile
// source builds, and the plain `npm run build` local flow. Defaults to the host
// platform when TARGET is unset so local builds don't need all five targets
// staged. No shell interpolation.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampDevelopmentVersion } from './install-marker-schema.mjs';
import { signExecutable } from './sign-executable.mjs';

function detectHostTarget() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (process.platform === 'win32') return 'windows-x64';
  return null;
}

function buildSingleTarget() {
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

  const pkgPath = path.join(pkgRoot, 'package.json');
  const pkgRaw = fs.readFileSync(pkgPath, 'utf-8');
  const pkgJson = JSON.parse(pkgRaw);

  // The compiled entry embeds the temporary package version; the manifest keeps its original bytes.
  const DEV_VERSION_PLACEHOLDER = '0.0.0-dev';
  let stampedPkg = false;
  if (pkgJson.version === DEV_VERSION_PLACEHOLDER) {
    const described = spawnSync(
      'git',
      ['describe', '--tags', '--always', '--match', 'myco/v*'],
      { cwd: pkgRoot, encoding: 'utf-8' },
    );
    const description = described.status === 0 ? (described.stdout ?? '').trim() : '';
    fs.writeFileSync(pkgPath, `${JSON.stringify({ ...pkgJson, version: stampDevelopmentVersion(description) }, null, 2)}\n`);
    stampedPkg = true;
  }
  const mycoVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;

  // Compile into the target workspace used by release and source builds.
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
  let status = 1;
  try {
    const result = spawnSync(
      'bun',
      // `--splitting` makes every dynamic import a chunk the binary reads only when it is reached: a hook loads its own
      // chunk (`entries/dispatch.ts`) and never parses the rest of the CLI.
      ['build', '--compile', '--splitting', '--minify', `--target=${bunTarget}`, entry, '--outfile', outfile],
      { stdio: 'inherit', cwd: pkgRoot, env: process.env },
    );
    status = result.status ?? 1;
    if (status === 0) signExecutable({ target, outfile });
  } finally {
    // Restore the exact original package.json bytes so the working tree (and any
    // release-stamped version) is never left mutated by a dev build.
    if (stampedPkg) fs.writeFileSync(pkgPath, pkgRaw);
  }
  process.exit(status);

}

buildSingleTarget();
