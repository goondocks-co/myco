import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ArtifactCandidate {
  path: string;    // relative path from project root
  content: string; // full content read from disk
}

/**
 * Scans tool events for Write/Edit file paths, filters by gitignore and
 * configured extensions, reads final content from disk.
 *
 * Uses execFileSync (not exec) for git check-ignore — arguments are passed
 * as an array, so no shell injection risk.
 */
export function collectArtifactCandidates(
  events: Array<Record<string, unknown>>,
  config: { artifact_extensions: string[] },
  projectRoot: string,
): ArtifactCandidate[] {
  const seen = new Set<string>();

  for (const event of events) {
    const toolName = String(event.tool_name ?? event.tool ?? '');
    if (toolName !== 'Write' && toolName !== 'Edit') continue;

    const input = event.tool_input as Record<string, unknown> | undefined;
    const filePath = input?.file_path as string | undefined;
    if (!filePath) continue;

    seen.add(filePath);
  }

  if (seen.size === 0) return [];

  const candidates: ArtifactCandidate[] = [];

  for (const absPath of seen) {
    const ext = path.extname(absPath);
    if (!config.artifact_extensions.includes(ext)) continue;

    if (isGitIgnored(absPath, projectRoot)) continue;

    if (!fs.existsSync(absPath)) continue;

    const content = fs.readFileSync(absPath, 'utf-8');
    const relativePath = path.relative(projectRoot, absPath);

    candidates.push({ path: relativePath, content });
  }

  return candidates;
}

function isGitIgnored(filePath: string, cwd: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', filePath], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true; // exit 0 = file is ignored
  } catch {
    return false; // exit 1 = file is not ignored
  }
}
