import fs from 'node:fs';
import path from 'node:path';
import { runGitAnswer } from '@myco/utils/git.js';

/** Ignore a machine-local file in Git's clone-local exclude file. Non-repositories need no entry. */
export function ensureGitIgnored(projectRoot: string, targetPath: string): void {
  const relative = path.relative(projectRoot, targetPath).split(path.sep).join('/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`Cannot exclude a path outside ${projectRoot}: ${targetPath}`);
  }
  let excludeFile: string;
  try {
    excludeFile = path.resolve(projectRoot, runGitAnswer(['rev-parse', '--git-path', 'info/exclude'], projectRoot));
  } catch {
    return;
  }
  let existing = '';
  try { existing = fs.readFileSync(excludeFile, 'utf-8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing.split('\n').some((line) => line.trim() === relative)) return;
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  fs.appendFileSync(excludeFile, `${existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''}${relative}\n`, 'utf-8');
}
