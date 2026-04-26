import fs from 'node:fs';
import path from 'node:path';

export interface WalkOptions {
  /** Absolute path to walk. */
  projectRoot: string;
  /**
   * Returns true when a relative path should be excluded. Compiled once
   * per scan. The optional `isDir` flag lets layered matchers (notably
   * `.gitignore` dir-only rules) make the right call; callers that build
   * a single-purpose matcher can ignore it.
   */
  isExcluded: (relPath: string, isDir?: boolean) => boolean;
}

/**
 * Recursive file walk yielding repo-relative, forward-slash paths.
 *
 * Both directory and file paths are tested against `isExcluded`; excluded
 * directories prune the walk so we never descend into `node_modules` etc.
 * Symlinks are skipped silently. Filesystem errors on a single entry are
 * swallowed so one missing or unreadable directory doesn't fail the whole
 * scan; the caller logs in aggregate.
 */
export function* walkProject(opts: WalkOptions): Generator<string> {
  const stack: string[] = ['']; // empty string represents projectRoot itself
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const absDir = relDir === '' ? opts.projectRoot : path.join(opts.projectRoot, relDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      const relChild = relDir === '' ? e.name : `${relDir}/${e.name}`;
      // Symlinks are skipped without inspecting their target.
      if (e.isSymbolicLink()) continue;

      if (e.isDirectory()) {
        if (opts.isExcluded(relChild, true)) continue;
        stack.push(relChild);
        continue;
      }
      if (!e.isFile()) continue;
      if (opts.isExcluded(relChild, false)) continue;
      yield relChild;
    }
  }
}
