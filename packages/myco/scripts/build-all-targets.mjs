// Build Myco binaries for all supported targets via `bun build --compile`.
//
// Used by `npm run build:binaries` (locally) and in CI for full release
// cross-compiles. For a single target, set TARGET env var and call
// `npm run build:binary` instead — this script just loops that shape.
//
// Prereqs: each target that carries native artifacts needs its libsqlite3
// artifact under `vendor-src/libsqlite3/<target>/` and the matching sqlite-vec
// platform sub-package installed in node_modules. In CI, the workflow takes
// care of both. Use `make source-build` for a local host build.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_TARGETS } from './release-targets.mjs';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const singleTargetScript = path.join(pkgRoot, 'scripts', 'build-single-target.mjs');

for (const { name: target } of RELEASE_TARGETS) {
  const result = spawnSync(
    process.execPath,
    [singleTargetScript],
    { stdio: 'inherit', cwd: pkgRoot, env: { ...process.env, TARGET: target } },
  );
  if (result.status !== 0) {
    process.stderr.write(`[build:binaries] Failed building ${target} (status=${result.status ?? 'signal'})\n`);
    process.exit(result.status ?? 1);
  }
}
