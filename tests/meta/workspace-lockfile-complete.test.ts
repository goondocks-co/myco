/**
 * Meta gate: every workspace package is in the lockfile.
 *
 * `npm ci` refuses to install when `package.json` and `package-lock.json`
 * disagree, and adding a directory under `packages/` makes them disagree — the
 * workspace glob picks it up, the lock does not know it. Every CI job starts
 * with `npm ci`, so the whole pipeline dies before a test runs, while a
 * developer's `npm test` (which installs nothing) stays green. That asymmetry
 * is why this is a test and not a convention.
 *
 * The fix when this fails is `npm install --package-lock-only`, which adds the
 * two entries a workspace member needs and touches nothing else.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

interface Lockfile {
  packages: Record<string, { name?: string; resolved?: string; link?: boolean }>;
}

/** Every directory the root `workspaces` globs cover, as `packages/<dir>`. */
function workspaceDirs(): string[] {
  const root = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { workspaces?: string[] };
  const dirs: string[] = [];
  for (const pattern of root.workspaces ?? []) {
    const [parent, star] = pattern.split('/');
    if (star !== '*') throw new Error(`this gate understands only <dir>/* workspace globs, not "${pattern}"`);
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(REPO_ROOT, parent, entry.name, 'package.json'))) dirs.push(`${parent}/${entry.name}`);
    }
  }
  return dirs.sort();
}

describe('workspace lockfile', () => {
  it('names every workspace package, so `npm ci` can install the tree', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf-8')) as Lockfile;
    const dirs = workspaceDirs();
    expect(dirs.length).toBeGreaterThan(1);

    for (const dir of dirs) {
      const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, dir, 'package.json'), 'utf-8')) as { name: string };
      // The lock carries two entries per member: the package itself, keyed by
      // its path, and the `node_modules/<name>` link that resolves to it.
      expect({ dir, entry: lock.packages[dir]?.name ?? null }).toEqual({ dir, entry: manifest.name });
      expect({ name: manifest.name, link: lock.packages[`node_modules/${manifest.name}`]?.resolved ?? null })
        .toEqual({ name: manifest.name, link: dir });
    }
  });
});
