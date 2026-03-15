import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ArtifactCandidate {
  path: string;    // relative path from project root
  content: string; // full content read from disk
}

/** Filenames (case-insensitive) that are agent/plugin infrastructure, not project artifacts. */
const EXCLUDED_FILENAMES = new Set([
  'claude.md',
  'agents.md',
  'gemini.md',
]);

/** Directory prefixes (relative to project root) that contain plugin/agent components. */
const EXCLUDED_PREFIXES = [
  'commands/',
  'skills/',
  'hooks/',
  '.claude-plugin/',
  '.claude/',
];

/**
 * Returns true if a relative path belongs to plugin/agent infrastructure
 * that should never be captured as a project artifact.
 */
export function isExcludedPath(relativePath: string): boolean {
  const basename = path.basename(relativePath).toLowerCase();
  if (EXCLUDED_FILENAMES.has(basename)) return true;

  const normalized = relativePath.replace(/\\/g, '/');
  return EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Filters a set of written/edited file paths by extension, gitignore,
 * and infrastructure exclusions, then reads final content from disk.
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

      // Skip plugin/agent infrastructure files
      if (isExcludedPath(relativePath)) continue;

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
