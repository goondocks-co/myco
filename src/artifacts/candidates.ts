import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ArtifactCandidate {
  path: string;    // relative path from project root
  content: string; // full content read from disk
}

/**
 * Filters a set of written/edited file paths by extension and gitignore,
 * then reads final content from disk.
 *
 * Uses execFileSync (not exec) for git check-ignore — arguments are passed
 * as an array, so no shell injection risk.
 */
export function collectArtifactCandidates(
  filePaths: Set<string>,
  config: { artifact_extensions: string[] },
  projectRoot: string,
): ArtifactCandidate[] {
  if (filePaths.size === 0) return [];

  // Filter by extension first (cheap)
  const extFiltered = [...filePaths].filter((absPath) =>
    config.artifact_extensions.includes(path.extname(absPath)),
  );

  if (extFiltered.length === 0) return [];

  // Batch git check-ignore: one subprocess instead of N
  const ignoredSet = getGitIgnored(extFiltered, projectRoot);

  const candidates: ArtifactCandidate[] = [];

  for (const absPath of extFiltered) {
    if (ignoredSet.has(absPath)) continue;

    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const relativePath = path.relative(projectRoot, absPath);
      candidates.push({ path: relativePath, content });
    } catch {
      // File was deleted between event capture and now — skip
    }
  }

  return candidates;
}

function getGitIgnored(filePaths: string[], cwd: string): Set<string> {
  try {
    const result = execFileSync('git', ['check-ignore', ...filePaths], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return new Set(result.trim().split('\n').filter(Boolean));
  } catch {
    // exit 1 = none are ignored (or git not available)
    return new Set();
  }
}
