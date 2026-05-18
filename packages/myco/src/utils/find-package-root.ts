/**
 * Walk up from a starting directory to find ancestor package roots.
 *
 * - `findPackageRoot(start)` returns the nearest ancestor with any
 *   `package.json`.
 * - `findCorePackageRoot(start)` returns the nearest ancestor whose
 *   `package.json#name === '@goondocks/myco'`, walking past sibling
 *   sub-packages (e.g. `@goondocks/myco-<arch>`) until it lands on core.
 *   Use this when you need a path that ships only in core (`dist/`,
 *   `skills/`, `scripts/`, `src/agent/definitions/`, the canonical
 *   version) — the Bun-compiled binary lives inside the platform
 *   sub-package, so its nearest `package.json` is not core's.
 */
import fs from 'node:fs';
import path from 'node:path';

const ANCESTOR_WALK_LIMIT = 8;

const CORE_PACKAGE_NAME = '@goondocks/myco';

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

/**
 * Find the `@goondocks/myco` core package root. Walks ancestors and
 * inspects `package.json#name`, skipping packages whose name doesn't
 * match (e.g. `@goondocks/myco-darwin-arm64`). Returns undefined if no
 * matching ancestor is found within {@link ANCESTOR_WALK_LIMIT} levels.
 */
export function findCorePackageRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < ANCESTOR_WALK_LIMIT; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === CORE_PACKAGE_NAME) return dir;
      } catch {
        // Malformed package.json — keep walking; an ancestor may have
        // a valid one.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
