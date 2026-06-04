import path from 'node:path';
import { createExcludeMatcher } from '../canopy/exclude.js';
import { expandHome } from '../grove/paths.js';
import { loadManifests } from '../symbionts/detect.js';

export interface CaptureIgnoreConfig {
  paths: string[];
  patterns: string[];
}

/** Symbiont home dirs (e.g. ~/.codex, ~/.claude) as absolute paths — these are
 *  agent config stores, never user projects, so they seed the ignore list. */
export function agentHomeIgnorePaths(): string[] {
  return loadManifests()
    .map((m) => m.detectionDir)
    .filter((d): d is string => d != null)
    .map((d) => expandHome(d));
}

function isUnderPrefix(root: string, prefix: string): boolean {
  const r = path.resolve(root);
  const p = path.resolve(expandHome(prefix));
  return r === p || r.startsWith(`${p}/`);
}

/**
 * True when projectRoot must not be auto-adopted: it is, or is under, any
 * configured ignore path, any agent-home seed dir, or matches an ignore glob.
 *
 * Patterns are matched against the absolute project root using
 * createExcludeMatcher (the canopy exclude engine). The common
 * "** /seg/** " shape is normalized to a bare segment name before
 * delegating so the segment matcher fires correctly against path components.
 */
export function isProjectRootIgnored(
  projectRoot: string,
  ignore: CaptureIgnoreConfig,
  agentHomeDirs: string[],
): boolean {
  for (const prefix of [...ignore.paths, ...agentHomeDirs]) {
    if (isUnderPrefix(projectRoot, prefix)) return true;
  }
  if (ignore.patterns.length > 0) {
    // Normalize patterns: `**/seg/**` → `seg` so the segment matcher in
    // createExcludeMatcher fires against path segments of the absolute root.
    // Patterns not matching that shape are passed through for path-glob matching.
    const normalizedPatterns = ignore.patterns.map((p) => {
      const m = /^\*\*\/([^*?/]+)\/\*\*$/.exec(p);
      return m ? m[1] : p;
    });
    const matcher = createExcludeMatcher(normalizedPatterns);
    const resolved = path.resolve(projectRoot);
    if (matcher(resolved)) return true;
  }
  return false;
}
