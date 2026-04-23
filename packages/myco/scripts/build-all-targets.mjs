// Build Myco binaries for all supported targets via `bun build --compile`.
//
// Used by `npm run build:binaries` (locally) and in CI for full release
// cross-compiles. For a single target, set TARGET env var and call
// `npm run build:binary` instead — this script just loops that shape.
//
// Prereqs: each target's libsqlite3 artifact must already exist under
// `vendor-src/libsqlite3/<target>/` and the matching sqlite-vec platform
// sub-package must be installed in node_modules. In CI, the workflow takes
// care of both. Locally, this script only makes sense for the host target
// (dev-link already wires that path).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'windows-x64'];

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const singleTargetScript = path.join(pkgRoot, 'scripts', 'build-single-target.mjs');

for (const target of TARGETS) {
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
