import os from 'node:os';
import path from 'node:path';
import { canonicalPath } from './git-files.js';

/** The configured temporary folders, or the system temporary folders. */
export function temporaryFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  const named = env.MYCO_TEMPORARY_FOLDERS;
  if (named !== undefined && named.length > 0) return named.split(path.delimiter).filter((dir) => dir.length > 0);
  return [os.tmpdir(), env.TMPDIR, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
    .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
}

/** Agent scratchpads under temporary storage are excluded from project history. */
export function isAgentScratchDirectory(directory: string): boolean {
  const recordedPaths = [path.resolve(directory), canonicalPath(directory)];
  return temporaryFolders().some((folder) => [path.resolve(folder), canonicalPath(folder)].some((root) => recordedPaths.some((recorded) => {
    const relative = path.relative(root, recorded);
    return !relative.startsWith('..') && !path.isAbsolute(relative)
      && /(?:^|[\\/])claude-[^\\/]+[\\/](?:.*[\\/])?scratchpad(?:[\\/]|$)/.test(path.join(path.basename(root), relative));
  })));
}
