/**
 * Walk up from a starting directory to find ancestor package roots.
 *
 * - `findPackageRoot(start)` returns the nearest ancestor with any
 *   `package.json`.
 * - `findCorePackageRoot(start)` returns the `@goondocks/myco` core
 *   package, walking past sibling sub-packages
 *   (e.g. `@goondocks/myco-<arch>`) to reach it. Handles two layouts:
 *
 *     1. npm install (consumer side):
 *        `<core>/node_modules/@goondocks/myco-<arch>/bin/myco` —
 *        core is an ancestor of the platform package; ancestor walk
 *        finds it.
 *
 *     2. Source monorepo (dev side):
 *        `packages/myco/` and `packages/myco-<arch>/bin/myco` are
 *        siblings under `packages/`. Ancestor walk from the platform
 *        bin/ never visits core; we detect the platform sub-package
 *        and check for a `myco/` sibling under the same parent.
 *
 *   Use this when you need a path that ships only in core (`dist/`,
 *   `skills/`, `scripts/`, `src/agent/definitions/`, the canonical
 *   version) — the Bun-compiled binary lives inside the platform
 *   sub-package, so its nearest `package.json` is not core's.
 */
import fs from 'node:fs';
import path from 'node:path';

const ANCESTOR_WALK_LIMIT = 8;

const CORE_PACKAGE_NAME = '@goondocks/myco';
const PLATFORM_PACKAGE_PATTERN = /^@goondocks\/myco-(?:darwin|linux|windows)-(?:arm64|x64)$/;

/**
 * Find the nearest ancestor directory containing `package.json`.
 * Returns undefined if none is found within {@link ANCESTOR_WALK_LIMIT}
 * levels. Prefer {@link findCorePackageRoot} when you specifically need
 * the `@goondocks/myco` core package.
 */
export function findPackageRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < ANCESTOR_WALK_LIMIT; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function readPackageName(pkgJsonPath: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as { name?: string };
    return typeof pkg.name === 'string' ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the `@goondocks/myco` core package root. Walks ancestors and
 * inspects `package.json#name`, skipping packages whose name doesn't
 * match (e.g. `@goondocks/myco-darwin-arm64`). Returns undefined if no
 * matching root is found within {@link ANCESTOR_WALK_LIMIT} levels.
 *
 * If the walk encounters a `@goondocks/myco-<arch>` platform package,
 * also probes that package's parent directory for a `myco/` sibling —
 * the source-monorepo layout where core and the platform package both
 * live under `packages/`.
 */
export function findCorePackageRoot(startDir: string): string | undefined {
  let dir = startDir;
  let platformParent: string | undefined;
  for (let i = 0; i < ANCESTOR_WALK_LIMIT; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const name = readPackageName(pkgPath);
      if (name === CORE_PACKAGE_NAME) return dir;
      if (name && PLATFORM_PACKAGE_PATTERN.test(name)) {
        // Remember this package's parent — in the source monorepo
        // (`packages/myco-<arch>/`), core lives next to it
        // (`packages/myco/`). The npm install topology
        // (`<core>/node_modules/@goondocks/myco-<arch>/`) is handled
        // by the normal ancestor walk above.
        platformParent ??= path.dirname(dir);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (platformParent) {
    const sibling = path.join(platformParent, 'myco');
    const siblingPkg = path.join(sibling, 'package.json');
    if (fs.existsSync(siblingPkg) && readPackageName(siblingPkg) === CORE_PACKAGE_NAME) {
      return sibling;
    }
  }
  return undefined;
}
