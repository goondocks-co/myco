/**
 * Walk up from a starting directory to find the nearest ancestor
 * containing package.json. Used by multiple modules that need to
 * locate the package root after tsup code-splitting moves chunks
 * to unpredictable locations within dist/.
 */
import fs from 'node:fs';
import path from 'node:path';

const ANCESTOR_WALK_LIMIT = 5;

/**
 * Find the nearest ancestor directory containing package.json.
 * Returns undefined if no package.json is found within ANCESTOR_WALK_LIMIT levels.
 */
export function findPackageRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < ANCESTOR_WALK_LIMIT; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return undefined;
}
